import { afterEach, describe, expect, it, vi } from "vitest";
import { Document } from "@langchain/core/documents";
import { DocumentIngressProcessor } from "../src/processors/dataIngestionProcessor.js";
import { EvidenceExtractor } from "../src/processors/evidence/evidenceExtractor.js";
import { telemetryClient } from "../src/processors/appInsights.js";
import { EvidenceEmbeddingCache } from "../src/processors/evidence/evidenceEmbeddingCache.js";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.js";
import { partitionIdsHash } from "../src/processors/evidence/evidenceSourceLookup.js";
import { SourcePartitionVisibilityError } from "../src/processors/evidence/sourcePartitionSearch.js";

const searchMocks = vi.hoisted(() => ({ uploadDocuments: vi.fn(), client: vi.fn(), search: vi.fn() }));
vi.mock("@azure/search-documents", async original => ({
  ...await original<typeof import("@azure/search-documents")>(),
  SearchClient: class {
    constructor(readonly endpoint: string, readonly indexName: string, _credential: unknown, options: unknown) {
      searchMocks.client(endpoint, indexName, options);
    }
    uploadDocuments = searchMocks.uploadDocuments;
    search = searchMocks.search;
  },
}));

vi.mock("../src/processors/appInsights.js", () => ({
  telemetryClient: { trackEvent: vi.fn(), trackException: vi.fn() },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  searchMocks.uploadDocuments.mockReset();
});

describe("Search upload concurrency", () => {
  it("batches embeddings, reuses them on retry, and preserves content, citations, IDs and positions", async () => {
    const processor = new DocumentIngressProcessor("results","source.md","source.md","https://example.test/source",
      "account-1","source-1",false,false) as any;
    const embedBatch = vi.fn(async(texts:string[])=>texts.map(text=>[text.length,0.1,0.2]));
    Object.assign(processor,{searchEndpoint:"https://example.search.windows.net",currentPosition:1_000_000,
      aoaiEmbeddings:{embedQuery:vi.fn(()=>{throw new Error("Unexpected per-record embedding");})},
      embeddingCache:new EvidenceEmbeddingCache("account-1","source-1",{endpoint:"https://embedding.test",deployment:"large",
        model:"text-embedding-3-large",dimensions:3,apiVersion:"2024-12-01-preview",inputVersion:"strip-newlines-v1"},{embedBatch})});
    vi.spyOn(processor,"createIfIndexDoesNotExist").mockResolvedValue();
    searchMocks.uploadDocuments.mockResolvedValue({results:[]});
    const documents = Array.from({length:26},(_,i)=>new Document({pageContent:`Evidence ${i}`,metadata:{sourceId:"source-1",
      evidenceJobId:"job-1",pages:[1],sourceQuote:`Evidence ${i}`,sourceOffset:i,
      sourceSpans:[{pageNumber:1,sourceOffset:i,sourceQuote:`Evidence ${i}`}],sourceContentHash:"a".repeat(64)}}));
    await processor.createIndex(documents,"test-index");
    expect(searchMocks.client).toHaveBeenLastCalledWith("https://example.search.windows.net", "test-index", {serviceVersion: "2026-04-01"});
    const original = structuredClone(searchMocks.uploadDocuments.mock.calls.flatMap(([docs])=>docs));
    expect(embedBatch.mock.calls.map(([texts])=>texts.length)).toEqual([16,9,1]);
    expect(original.map(row=>row.pos)).toEqual(Array.from({length:26},(_,i)=>1_000_000+i));
    expect(original.map(row=>row.content)).toEqual(documents.map(doc=>doc.pageContent));
    expect(original.map(row=>JSON.parse(row.metadata).sourceSpans)).toEqual(documents.map(doc=>doc.metadata.sourceSpans));
    expect(original.map(row=>row.content_vector)).toEqual(documents.map(doc=>[doc.pageContent.length,0.1,0.2]));
    searchMocks.uploadDocuments.mockClear(); processor.currentPosition=1_000_000;
    await processor.createIndex(documents,"test-index");
    expect(searchMocks.uploadDocuments.mock.calls.flatMap(([docs])=>docs)).toEqual(original);
    expect(embedBatch).toHaveBeenCalledTimes(3);
  });
  function setup(count: number, evidenceJobId?: string) {
    const processor = new DocumentIngressProcessor("results", "source.md", "source.md",
      "https://example.test/source", "account-1", "source-1", false, false);
    Object.assign(processor, { searchEndpoint: "https://example.search.windows.net" });
    vi.spyOn(processor as any, "createIfIndexDoesNotExist").mockResolvedValue();
    vi.spyOn(processor as any, "generateDocumentEntry").mockImplementation(async (doc: Document) => [{ id: doc.pageContent }]);
    const docs = Array.from({ length: count }, (_, index) => new Document({ pageContent: String(index) }));
    return () => (processor as any).createIndex(docs, "test-index", evidenceJobId) as Promise<void>;
  }

  it("reports cumulative finalize progress for one indexing attempt", async () => {
    searchMocks.uploadDocuments.mockResolvedValue({results:[]});
    await setup(51,"job-1")();
    const events = vi.mocked(telemetryClient.trackEvent).mock.calls.map(([event])=>event);
    const started = events.find(event=>event.name==="EvidenceIndexingStarted");
    const uploaded = events.filter(event=>event.name==="documentsIndexed");
    expect(started?.properties).toMatchObject({jobId:"job-1",completedSourceDocuments:"0",totalSourceDocuments:"51"});
    expect(uploaded.map(event=>event.properties?.completedSourceDocuments)).toEqual(["25","50","51"]);
    expect(uploaded.every(event=>event.properties?.indexingAttemptId===started?.properties?.indexingAttemptId)).toBe(true);
  });

  it("waits for each chunk upload before starting the next", async () => {
    const run = setup(51);
    const pending: (() => void)[] = [];
    searchMocks.uploadDocuments.mockImplementation(() => new Promise(resolve => {
      pending.push(() => resolve({ results: [] }));
    }));
    const result = run();
    for (let chunk = 1; chunk <= 3; chunk++) {
      await vi.waitFor(() => expect(searchMocks.uploadDocuments).toHaveBeenCalledTimes(chunk));
      expect(pending).toHaveLength(1);
      pending.shift()!();
    }
    await result;
    expect(searchMocks.uploadDocuments.mock.calls.map(([docs]) => docs.length)).toEqual([25, 25, 1]);
    expect(searchMocks.uploadDocuments.mock.calls.flatMap(([docs]) => docs.map((doc: { id: string }) => doc.id)))
      .toEqual(Array.from({ length: 51 }, (_, index) => String(index)));
  });

  it("finishes sequential document retries before uploading the next chunk", async () => {
    const run = setup(26);
    const pending: (() => void)[] = [];
    searchMocks.uploadDocuments.mockRejectedValueOnce(new Error("Chunk upload failed"))
      .mockImplementation(() => new Promise(resolve => { pending.push(() => resolve({ results: [] })); }));
    const result = run();
    for (let request = 2; request <= 27; request++) {
      await vi.waitFor(() => expect(searchMocks.uploadDocuments).toHaveBeenCalledTimes(request));
      expect(pending).toHaveLength(1);
      expect(searchMocks.uploadDocuments.mock.calls[request - 1][0]).toEqual([{ id: String(request - 2) }]);
      pending.shift()!();
    }
    await result;
  });

  it("propagates a failed document retry without starting remaining uploads", async () => {
    const run = setup(51);
    const failure = new Error("Chunk upload failed");
    searchMocks.uploadDocuments.mockRejectedValueOnce(failure).mockRejectedValueOnce(new Error("Document retry failed"));
    await expect(run()).rejects.toBe(failure);
    expect(searchMocks.uploadDocuments).toHaveBeenCalledTimes(2);
    expect(searchMocks.uploadDocuments.mock.calls[1][0]).toEqual([{ id: "0" }]);
  });
});

describe("source segment positions", () => {
  it.each([
    { path: "an embedding failure", cached: false, nested: false },
    { path: "a batch embedding fallback", cached: true, nested: false },
    { path: "nested page and token splitting", cached: true, nested: true },
  ])("reconstructs the source in order after $path", async ({ cached, nested }) => {
    const processor = new DocumentIngressProcessor("results", "source.md", "source.md",
      "https://example.test/source", "account-1", "source-1", false, false) as any;
    const firstPage = "START\n" + "alpha ".repeat(2997) + "MIDDLE\n" + "beta ".repeat(3000) + "END\n";
    const secondPage = "Second page.\n";
    const source = nested ? firstPage + "<!-- PageBreak -->" + secondPage : firstPage;
    const embedQuery = vi.fn(async (text: string) => {
      if (text === source || (nested && text === firstPage)) throw new Error("Embedding input too large");
      // Later segments can finish first if fallback embeddings run concurrently.
      if (text.startsWith("START")) await new Promise(resolve => setTimeout(resolve, 20));
      return [text.length, 0.1, 0.2];
    });
    Object.assign(processor, { searchEndpoint: "https://example.search.windows.net", aoaiEmbeddings: { embedQuery },
      ...(cached ? { embeddingCache: { vectors: async (texts: string[]) =>
        texts.map(text => text === source ? null : [text.length, 0.1, 0.2]) } } : {}) });
    vi.spyOn(processor, "createIfIndexDoesNotExist").mockResolvedValue();
    searchMocks.uploadDocuments.mockResolvedValue({ results: [] });
    const metadata = { sourceId: "source-1", tags: [], contentOrigin: "extracted" };
    const documents = [
      new Document({ pageContent: "Before.\n", metadata: { ...metadata, pages: [1] } }),
      new Document({ pageContent: source, metadata: { ...metadata, pages: nested ? [1, 2] : [1] } }),
      new Document({ pageContent: "After.\n", metadata: { ...metadata, pages: nested ? [2] : [1] } }),
    ];

    await processor.createIndex(documents, "test-index");

    const entries = searchMocks.uploadDocuments.mock.calls.flatMap(([docs]) => docs);
    const ordered = [...entries].sort((a, b) => a.pos - b.pos);
    expect(entries.length).toBeGreaterThan(documents.length);
    expect(ordered.map(entry => entry.content).join(""))
      .toBe("Before.\n" + firstPage + (nested ? secondPage : "") + "After.\n");
    expect(entries.map(entry => entry.pos)).toEqual(entries.map((_, index) => index));
    for (const [index, entry] of entries.entries()) {
      expect(JSON.parse(entry.metadata)).toMatchObject({ ...metadata, pos: index, nxt: index + 1 });
      if (index > 0) expect(JSON.parse(entry.metadata).prv).toBe(index - 1);
      expect(entry.content_vector).toEqual([entry.content.length, 0.1, 0.2]);
      expect(entry.pages).toEqual(nested && (entry.content === secondPage || entry.content === "After.\n") ? [2] : [1]);
    }
  });
});

describe("embedding validation concurrency", () => {
  it("limits validation to ten in-flight requests and preserves document order", async () => {
    const processor = new DocumentIngressProcessor("results", "source.md", "source.md",
      "https://example.test/source", "account-1", "source-1", false, false);
    const documents = Array.from({ length: 25 }, (_, index) => new Document({
      pageContent: `${index} ` + "word ".repeat(6100), metadata: { index },
    }));
    let active = 0;
    let maximum = 0;
    const pending: (() => void)[] = [];
    const embedQuery = vi.fn(() => new Promise<number[]>(resolve => {
      active++;
      maximum = Math.max(maximum, active);
      pending.push(() => { active--; resolve([0.1]); });
    }));
    Object.assign(processor, { aoaiEmbeddingsSmall: { embedQuery } });

    const result = (processor as any).documentSecondSplit(documents) as Promise<Document[]>;
    await vi.waitFor(() => expect(embedQuery).toHaveBeenCalledTimes(10));
    expect(active).toBe(10);
    // Finishing nine requests cannot start the next batch while one is pending.
    pending.splice(1).reverse().forEach(finish => finish());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(embedQuery).toHaveBeenCalledTimes(10);
    pending.shift()!();
    await vi.waitFor(() => expect(embedQuery).toHaveBeenCalledTimes(20));
    pending.splice(0).reverse().forEach(finish => finish());
    await vi.waitFor(() => expect(embedQuery).toHaveBeenCalledTimes(25));
    pending.splice(0).reverse().forEach(finish => finish());

    expect(await result).toEqual(documents);
    expect(maximum).toBe(10);
    expect(active).toBe(0);
  });
});

describe("inline evidence extraction telemetry", () => {
  function readinessFixture() {
    const processor = new DocumentIngressProcessor("results", "source.md", "source.md", "https://example.test/source",
      "account-1", "source-1", false, false) as any;
    Object.assign(processor, {searchEndpoint: "https://example.search.windows.net", generalIndex: "account-alias"});
    const source = new EvidenceSource(new Document({pageContent: "Original text.", metadata: {accountId: "account-1", sourceId: "source-1", pages: [1]}}));
    const row = {id: "partition", sourceId: "source-1", tags: [], content: source.document.pageContent, pos: 0, pages: [1], metadata: "{}"};
    searchMocks.search.mockImplementation(async () => ({count: 1, results: (async function* () {yield {document: row};})()}));
    return {processor, source, row, manifest: {sourceContentHash: source.contentHash, count: 1, idsHash: partitionIdsHash([row.id])}};
  }

  it("checks partition readiness through the configured alias with an alias-compatible API", async () => {
    const {processor, source, manifest} = readinessFixture();
    const fingerprint = await processor.waitForSourcePartitions(source, manifest);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(searchMocks.client).toHaveBeenCalledWith("https://example.search.windows.net", "account-alias", {serviceVersion: "2026-04-01"});
    expect(searchMocks.search).toHaveBeenCalledWith("*", expect.objectContaining({filter: "sourceId eq 'source-1' and not tags/any()"}));
  });

  it.each(["count", "duplicate", "missing"])("retries a %s visibility mismatch without reuploading or checkpointing an incomplete source", async scenario => {
    vi.stubEnv("EVIDENCE_SOURCE_LOOKUP_MODE", "hybrid");
    const putStage = vi.fn(), processor = new DocumentIngressProcessor("results", "source.md", "source.md", "https://example.test/source",
      "account-1", "source-1", false, false, {putStage} as any, true) as any;
    Object.assign(processor, {searchEndpoint: "https://example.search.windows.net", generalIndex: "account-alias"});
    const original = new Document({pageContent: "Original text.", metadata: {sourceId: "source-1", pages: [1]}});
    const part = new Document({pageContent: original.pageContent, metadata: {pages: [1], contentOrigin: "extracted"}});
    vi.spyOn(processor, "prepareGeneralIndex").mockResolvedValue();
    vi.spyOn(processor, "prepareEmbeddings").mockReturnValue(undefined);
    vi.spyOn(processor, "extractSplitsForDocument").mockResolvedValue({fullDocument: original, splits1: [part]});
    vi.spyOn(processor, "documentSecondSplit").mockImplementation(async docs => docs);
    const upload = vi.spyOn(processor, "createIndex").mockResolvedValue(["partition"]);
    const row = {id: "partition", sourceId: "source-1", tags: [], content: original.pageContent, metadata: "{}", pos: 0, pages: [1]};
    searchMocks.search.mockImplementationOnce(async () => ({count: scenario === "missing" ? 0 : 2,
      results: (async function* () {
        if (scenario !== "missing") yield {document: row};
        if (scenario === "duplicate") yield {document: row};
      })()})).mockImplementation(async () => {
      expect(putStage).not.toHaveBeenCalled();
      expect(upload).toHaveBeenCalledOnce();
      return {count: 1, results: (async function* () {yield {document: row};})()};
    });
    await processor.processDocument();
    expect(searchMocks.search).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledOnce();
    expect(putStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), 0, "ready",
      expect.objectContaining({count: 1, idsHash: partitionIdsHash([row.id]), snapshotFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)}));
  });

  it("stops retrying visibility mismatches at the readiness deadline", async () => {
    const {processor, source, manifest, row} = readinessFixture();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    searchMocks.search.mockImplementation(async () => {
      now += 30_000;
      return {count: 2, results: (async function* () {yield {document: row};})()};
    });
    await expect(processor.waitForSourcePartitions(source, manifest)).rejects.toBeInstanceOf(SourcePartitionVisibilityError);
    expect(searchMocks.search).toHaveBeenCalledOnce();
  });

  it("propagates dependency failures without treating them as visibility lag", async () => {
    const {processor, source, manifest} = readinessFixture();
    const error = Object.assign(new Error("Forbidden"), {statusCode: 403});
    searchMocks.search.mockRejectedValue(error);
    await expect(processor.waitForSourcePartitions(source, manifest)).rejects.toBe(error);
    expect(searchMocks.search).toHaveBeenCalledOnce();
  });

  it("honors a source stop before retrying a changing snapshot", async () => {
    const {processor, source, manifest, row} = readinessFixture();
    const stopped = new Error("source stopped");
    processor.checkOpen = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(stopped);
    searchMocks.search.mockImplementation(async () => ({count: 2, results: (async function* () {yield {document: row};})()}));
    await expect(processor.waitForSourcePartitions(source, manifest)).rejects.toBe(stopped);
    expect(searchMocks.search).toHaveBeenCalledOnce();
  });

  it.each([false, true])("publishes and verifies source partitions before %s deferred reconciliation", async deferred => {
    vi.stubEnv("EVIDENCE_SOURCE_LOOKUP_MODE", "hybrid");
    const steps: string[] = [], ready = vi.fn(async () => {steps.push("manifest");});
    const processor = new DocumentIngressProcessor("results", "source.md", "source.md", "https://example.test/source",
      "account-1", "source-1", false, false, {putStage: ready} as any, deferred) as any;
    const original = new Document({pageContent: "Original text.", metadata: {pages: [1]}});
    const part = new Document({pageContent: "Original text.", metadata: {pages: [1], contentOrigin: "extracted"}});
    vi.spyOn(processor, "prepareGeneralIndex").mockResolvedValue();
    vi.spyOn(processor, "prepareEmbeddings").mockReturnValue(undefined);
    vi.spyOn(processor, "extractSplitsForDocument").mockResolvedValue({fullDocument: original, splits1: [part]});
    vi.spyOn(processor, "documentSecondSplit").mockImplementation(async docs => docs);
    vi.spyOn(processor, "createIndex").mockImplementation(async docs => {
      steps.push(docs[0].pageContent === "Original text." ? "partitions" : "evidence"); return ["partition-id"];
    });
    vi.spyOn(processor, "waitForSourcePartitions").mockImplementation(async () => {steps.push("visible");});
    vi.spyOn(processor, "extractEvidenceDocumentsForSource").mockImplementation(async source => {
      expect(source.metadata.sourcePartitionManifest.count).toBe(1);
      steps.push("reconcile"); return [new Document({pageContent: "Evidence"})];
    });
    await processor.processDocument();
    expect(steps).toEqual(deferred ? ["partitions", "visible", "manifest"] : ["partitions", "visible", "manifest", "reconcile", "evidence"]);
    expect(part.metadata.accountId).toBe("account-1");
    expect(part.metadata.sourceContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(part.metadata.tags).toEqual([]);
  });

  it("keeps CurrentOrder sources on local lookup when hybrid mode is enabled", async () => {
    vi.stubEnv("EVIDENCE_SOURCE_LOOKUP_MODE", "hybrid");
    const putStage = vi.fn(), getStage = vi.fn();
    const processor = new DocumentIngressProcessor("results", "source.md", "source.md", "https://example.test/source",
      "account-1", "source-1", true, false, {putStage, getStage} as any, false) as any;
    const original = new Document({pageContent: "Original text.", metadata: {pages: [1]}});
    const part = new Document({pageContent: "Original text.", metadata: {pages: [1]}});
    vi.spyOn(processor, "prepareGeneralIndex").mockResolvedValue();
    vi.spyOn(processor, "prepareEmbeddings").mockReturnValue(undefined);
    vi.spyOn(processor, "extractSplitsForDocument").mockResolvedValue({fullDocument: original, splits1: [part]});
    const wait = vi.spyOn(processor, "waitForSourcePartitions");
    const local = vi.spyOn(processor, "buildSplitsDedupList").mockResolvedValue([part]);
    vi.spyOn(processor, "createIndex").mockResolvedValue(["id"]);
    await processor.processDocument();
    expect(local).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    expect(putStage).not.toHaveBeenCalled();
    expect(part.metadata.tags).toEqual(["CurrentOrder"]);
    expect(processor.hybridSourceLookup()).toBe(false);
  });

  it("awaits persistence of the actual source page count before constructing the extractor",async()=>{
    vi.stubEnv("EVIDENCE_EVENT_STRUCTURE_MODE","invalid");
    const processor=new DocumentIngressProcessor("results","source.md","source.md","https://example.test/source",
      "account-1","source-1",false,false,undefined,false,undefined,"thorough");
    vi.spyOn(processor,"prepareGeneralIndex").mockResolvedValue();
    vi.spyOn(processor as any,"retrieveDocumentFromBlob").mockResolvedValue(new Document({
      pageContent:Array.from({length:101},(_,i)=>`Page ${i+1}`).join("<!-- PageBreak -->")+"<!-- PageBreak -->",
    }));
    const onSource=vi.fn(async(pageCount:number)=>{expect(pageCount).toBe(101);throw new Error("budget persistence unavailable");});
    await expect(processor.extractEvidence(onSource)).rejects.toThrow("budget persistence unavailable");
    expect(onSource).toHaveBeenCalledOnce();
  });
  it("correlates start and failure events when extractor configuration is invalid", async () => {
    vi.stubEnv("EVIDENCE_SPECIALIST_MODE", "off");
    vi.stubEnv("EVIDENCE_EVENT_STRUCTURE_MODE", "invalid");
    const processor = new DocumentIngressProcessor("results", "source.md", "source.md",
      "https://example.test/source", "account-1", "source-1", false, false, undefined, false, undefined,"thorough");
    vi.spyOn(processor, "prepareGeneralIndex").mockResolvedValue();
    vi.spyOn(processor, "prepareEmbeddings").mockResolvedValue();
    vi.spyOn(processor as any, "retrieveDocumentFromBlob")
      .mockResolvedValue(new Document({ pageContent: "Synthetic source text." }));
    vi.spyOn(processor as any, "documentSecondSplit").mockImplementation(async documents => documents);
    const index = vi.spyOn(processor as any, "createIndex").mockResolvedValue();
    const generate = vi.spyOn(EvidenceExtractor.prototype, "generateDocuments").mockResolvedValue([]);

    await expect(processor.processDocument()).rejects
      .toThrow("EVIDENCE_EVENT_STRUCTURE_MODE must be off or annotate");

    const events = vi.mocked(telemetryClient.trackEvent).mock.calls.map(([event]) => event)
      .filter(event => event.name?.startsWith("EvidenceExtraction") && event.name !== "EvidenceExtractionModeSelected");
    const properties = { accountId: "account-1", sourceId: "source-1", pageCount: "1", executionMode: "inline",evidenceExtractionMode:"thorough" };
    expect(events).toEqual([
      { name: "EvidenceExtractionStarted", properties },
      { name: "EvidenceExtractionFailed", properties: { ...properties, errorType: "Error" },
        measurements: { durationMs: expect.any(Number) } },
    ]);
    expect(events[1].measurements?.durationMs).toBeGreaterThanOrEqual(0);
    expect(generate).not.toHaveBeenCalled();
    expect(index).not.toHaveBeenCalled();
  });
});
