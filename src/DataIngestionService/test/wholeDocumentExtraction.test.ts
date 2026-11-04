import { Document } from "@langchain/core/documents";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentIngressProcessor } from "../src/processors/dataIngestionProcessor.ts";
import type { EvidenceCheckpointStore } from "../src/processors/evidence/evidenceCheckpoint.ts";
import { literalDocument, parseExtractionPackage } from "../src/processors/extractionPackage.ts";

const mocks = vi.hoisted(() => ({ generateDocuments: vi.fn(), resolveMode:vi.fn(), construct:vi.fn() }));

vi.mock("../src/processors/evidence/evidenceExtractionMode.js",()=>({
  resolveEvidenceExtractionMode:mocks.resolveMode,
  routeEvidenceExtractionModeForBudget:async(mode:string)=>mode,
}));

vi.mock("../src/processors/evidence/evidenceExtractor.js", () => ({
  EvidenceExtractor: class {
    constructor(...args:unknown[]) {mocks.construct(...args);}
    generateDocuments = mocks.generateDocuments;
  },
}));

vi.mock("../src/processors/appInsights.js", () => ({
  telemetryClient: { trackEvent: vi.fn(), trackException: vi.fn() },
}));

function makeProcessor(content: string, checkpointStore?: EvidenceCheckpointStore) {
  const processor = Object.create(DocumentIngressProcessor.prototype) as DocumentIngressProcessor;
  Object.assign(processor, {
    accountId: "account-1",
    sourceId: "source-1",
    sourceUrl: "https://example.test/source",
    filename: "source.md",
    generalIndex: "account-index",
    isWebSite: false,
    isCurrentOrder: true,
    skipEvidenceExtraction: false,
    currentPosition: 0,
    checkpointStore,
  });
  vi.spyOn(processor, "prepareGeneralIndex").mockResolvedValue();
  vi.spyOn(processor, "prepareEmbeddings").mockResolvedValue();
  vi.spyOn(processor as any, "retrieveDocumentFromBlob")
    .mockResolvedValue(new Document({ pageContent: content }));
  vi.spyOn(processor as any, "documentSecondSplit")
    .mockImplementation(async (documents: Document[]) => documents);
  const createIndex = vi.spyOn(processor as any, "createIndex").mockResolvedValue(undefined);
  return { processor, createIndex };
}

describe("whole document evidence extraction", () => {
  beforeEach(() => {
    mocks.generateDocuments.mockReset();
    mocks.construct.mockClear();
    mocks.resolveMode.mockReset().mockResolvedValue("thorough");
  });

  it("passes the resolved fast mode to inline extraction while keeping normal search chunks",async()=>{
    const {processor,createIndex}=makeProcessor("An uploaded source.");
    mocks.resolveMode.mockResolvedValue("fast");
    mocks.generateDocuments.mockResolvedValue([]);
    await processor.processDocument();
    expect(mocks.construct).toHaveBeenCalledWith("account-1","source-1",undefined,undefined,undefined,"fast",
      expect.objectContaining({vectors: expect.any(Function)}), expect.any(Function));
    expect(createIndex).toHaveBeenCalledOnce();
  });

  it.each([[true], [false]])(
    "uses the right lookup resolution when CurrentOrder is %s", async (isCurrentOrder: boolean) => {
      const {processor} = makeProcessor("An uploaded source.");
      Object.assign(processor, {isCurrentOrder});
      mocks.generateDocuments.mockResolvedValue([]);
      await processor.processDocument();
      const factory = mocks.construct.mock.calls[0][7];
      if (isCurrentOrder) await expect(factory()).resolves.toBeUndefined();
      else expect(factory).toBeUndefined();
    });

  it("indexes shared-resource chunks without constructing an extractor",async()=>{
    const {processor,createIndex}=makeProcessor("Shared reference material.");
    mocks.resolveMode.mockResolvedValue("skip");
    await processor.processDocument();
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.generateDocuments).not.toHaveBeenCalled();
    expect(createIndex).toHaveBeenCalledOnce();
    expect(createIndex.mock.calls[0][0]).not.toHaveLength(0);
  });

  it("indexes search chunks immediately when extraction is delegated to the evidence service", async () => {
    const clearSource = vi.fn(async () => {});
    const { processor, createIndex } = makeProcessor("A long uploaded document.",
      { clearSource } as unknown as EvidenceCheckpointStore);
    Object.assign(processor, { deferEvidenceExtraction: true });
    await expect(processor.processDocument()).resolves.toEqual(["account-index"]);
    expect(createIndex).toHaveBeenCalledTimes(1);
    expect(mocks.generateDocuments).not.toHaveBeenCalled();
    expect(clearSource).not.toHaveBeenCalled();
  });

  it("the evidence service extracts the complete retained document without indexing its chunks", async () => {
    const content = "First page.\n<!-- PageBreak -->\nSecond page.";
    const { processor, createIndex } = makeProcessor(content);
    mocks.generateDocuments.mockResolvedValueOnce([]);
    await expect(processor.extractEvidence()).resolves.toEqual([]);
    expect(mocks.generateDocuments).toHaveBeenCalledTimes(1);
    expect(mocks.generateDocuments.mock.calls[0][0].pageContent).toBe(content);
    expect(mocks.generateDocuments.mock.calls[0][0].metadata.pages).toEqual([1, 2]);
    expect(createIndex).not.toHaveBeenCalled();
  });

  it("indexes CU enrichment separately and supplies only literal text to evidence extraction", async () => {
    const text = "The blue car stopped.";
    const location = { pages: [2], regions: ["D(2,0,0,1,1)"], startTimeMs: null, endTimeMs: null, speaker: null };
    const pkg = parseExtractionPackage({ version: 1, accountId: "account-1", sourceId: "source-1", mediaType: "document",
      provider: "content-understanding", analyzerId: "prebuilt-documentSearch", apiVersion: "2025-11-01", analysisId: "analysis-1",
      configurationHash: "a".repeat(64), sourceSha256: "b".repeat(64), stringEncoding: "utf16", literalMarkdown: text,
      literalPages: [{ pageNumber: 2, text, locationKind: "physical-page" }],
      blocks: [{ id: "source", kind: "paragraph", origin: "extracted", text, ...location, serviceSpans: [] },
        { id: "summary", kind: "summary", origin: "generated", text: "An interpreted event.", ...location, serviceSpans: [] }],
      evidenceLocations: [{ pageNumber: 2, offset: 0, length: text.length, blockId: "source", ...location }],
      rawResponse: {}, usage: null, warnings: [] });
    const { processor, createIndex } = makeProcessor(text);
    Object.assign(processor, { extractionPackage: pkg });
    vi.mocked((processor as any).retrieveDocumentFromBlob).mockResolvedValue(literalDocument(pkg));
    mocks.generateDocuments.mockResolvedValueOnce([new Document({ pageContent: "A stopped car.",
      metadata: { sourceSpans: [{ pageNumber: 2, sourceOffset: 0, sourceQuote: text }] } })]);
    await processor.processDocument();
    expect(mocks.generateDocuments.mock.calls[0][0].pageContent).toBe(text);
    const indexed = createIndex.mock.calls[0][0] as Document[];
    expect(indexed.map(document => document.metadata.contentOrigin)).toEqual(["extracted", "generated", "evidence"]);
    expect(indexed[2].metadata.citations[0].regions).toEqual(location.regions);
  });

  it("sends the complete uploaded document once while indexing its search chunks", async () => {
    const content = "# First section\nAn event occurred.\n<!-- PageBreak -->\n## Second section\nA witness made a claim.";
    const { processor, createIndex } = makeProcessor(content);
    const evidence = new Document({ pageContent: "Extracted claim", metadata: { tags: ["claim"] } });
    mocks.generateDocuments.mockResolvedValueOnce([evidence]);

    const indexes = await processor.processDocument();

    expect(indexes).toEqual(["account-index"]);
    expect(mocks.generateDocuments).toHaveBeenCalledTimes(1);
    const completeDocument = mocks.generateDocuments.mock.calls[0][0] as Document;
    expect(completeDocument.pageContent).toBe(content);
    expect(completeDocument.metadata).toMatchObject({
      pages: [1, 2], title: "source.md", source: "https://example.test/source",
      sourceId: "source-1", tags: ["CurrentOrder"],
    });
    const indexedDocuments = createIndex.mock.calls[0][0] as Document[];
    expect(indexedDocuments).toContain(evidence);
    expect(indexedDocuments.length).toBeGreaterThan(2);
  });

  it("does not index search chunks when evidence extraction fails", async () => {
    const clearSource = vi.fn(async () => {});
    const { processor, createIndex } = makeProcessor("An uploaded document with evidence.",
      { clearSource } as unknown as EvidenceCheckpointStore);
    mocks.generateDocuments.mockRejectedValueOnce(new Error("model unavailable"));

    await expect(processor.processDocument()).rejects.toThrow("model unavailable");
    expect(createIndex).not.toHaveBeenCalled();
    expect(clearSource).not.toHaveBeenCalled();
  });

  it("clears verified window checkpoints only after indexing succeeds", async () => {
    const clearSource = vi.fn(async () => {});
    const store = { clearSource } as unknown as EvidenceCheckpointStore;
    const { processor, createIndex } = makeProcessor("A completed document.", store);
    mocks.generateDocuments.mockResolvedValueOnce([]);

    await processor.processDocument();

    expect(createIndex).toHaveBeenCalledTimes(1);
    expect(clearSource).toHaveBeenCalledWith("account-1", "source-1");
    expect(createIndex.mock.invocationCallOrder[0]).toBeLessThan(clearSource.mock.invocationCallOrder[0]);
  });

  it("retains verified window checkpoints when indexing fails", async () => {
    const clearSource = vi.fn(async () => {});
    const store = { clearSource } as unknown as EvidenceCheckpointStore;
    const { processor, createIndex } = makeProcessor("A document awaiting indexing.", store);
    mocks.generateDocuments.mockResolvedValueOnce([]);
    createIndex.mockRejectedValueOnce(new Error("search unavailable"));

    await expect(processor.processDocument()).rejects.toThrow("search unavailable");
    expect(clearSource).not.toHaveBeenCalled();
  });
});
