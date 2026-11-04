import type { SearchIndex } from "@azure/search-documents";
import { Document } from "@langchain/core/documents";
import { describe, expect, it, vi } from "vitest";
import { DocumentIngressProcessor } from "../src/processors/dataIngestionProcessor.ts";
import { formatEvidenceContent } from "../src/processors/evidence/evidenceContent.ts";
import { asOfSearchField, ensureEvidenceSearchFields } from "../src/processors/evidence/evidenceSearchSchema.ts";
import { evidenceRetrievalFields, evidenceSearchValues } from "../src/processors/evidence/evidenceSearchProjection.ts";
import { extractionSearchFields } from "../src/processors/extractionSearchSchema.ts";
import { extractionChunks, parseExtractionPackage } from "../src/processors/extractionPackage.ts";

vi.mock("../src/processors/appInsights.js", () => ({
  telemetryClient: { trackEvent: vi.fn(), trackException: vi.fn() },
}));

const index: SearchIndex = {
  name: "test-index", etag: "v1",
  fields: [
    { name: "id", type: "Edm.String", key: true },
    { name: "content", type: "Edm.String", searchable: true },
    { name: "content_vector", type: "Collection(Edm.Single)", searchable: true, vectorSearchDimensions: 3, vectorSearchProfileName: "existing-profile" },
  ],
  semanticSearch: { configurations: [{ name: "existing-semantic", prioritizedFields: { contentFields: [{ name: "content" }] } }] },
  vectorSearch: { profiles: [{ name: "existing-profile", algorithmConfigurationName: "existing-algorithm" }], algorithms: [{ name: "existing-algorithm", kind: "hnsw" }] },
};

function clientFor(schema: SearchIndex) {
  return { getIndex: vi.fn().mockResolvedValue(schema), createOrUpdateIndex: vi.fn().mockImplementation(async value => value) };
}

describe("evidence Search schema migration", () => {
  it("adds asOf and retains all existing fields and Search configuration with an ETag condition", async () => {
    const client = clientFor(index);
    const migrated = await ensureEvidenceSearchFields(client, index.name);
    expect(migrated).toEqual({ ...index, fields: [...index.fields, ...extractionSearchFields(), ...evidenceRetrievalFields(), asOfSearchField()] });
    expect(client.createOrUpdateIndex).toHaveBeenCalledWith(migrated, { onlyIfUnchanged: true });
    expect(index.fields).toHaveLength(3);
  });

  it("does not write an already compatible schema", async () => {
    const existing = { ...index, fields: [...index.fields, ...extractionSearchFields(), ...evidenceRetrievalFields(), asOfSearchField()] };
    const client = clientFor(existing);
    expect(await ensureEvidenceSearchFields(client, index.name)).toBe(existing);
    expect(client.createOrUpdateIndex).not.toHaveBeenCalled();
  });

  it("fills missing date parts while preserving extra complex fields", async () => {
    const complete = asOfSearchField();
    const partial = { ...complete, fields: [complete.fields![0], { name: "sourceLabel", type: "Edm.String" as const }] };
    const client = clientFor({ ...index, fields: [...index.fields, partial] });
    const result = await ensureEvidenceSearchFields(client, index.name);
    expect(result.fields.find(field => field.name === "asOf")?.fields).toEqual([...partial.fields, ...complete.fields!.slice(1)]);
  });

  it.each([409, 412])("re-reads the index after an update conflict (%s)", async statusCode => {
    const client = clientFor(index);
    client.getIndex.mockResolvedValueOnce(index).mockResolvedValueOnce({ ...index, etag: "v2" });
    client.createOrUpdateIndex.mockRejectedValueOnce({ statusCode });
    await ensureEvidenceSearchFields(client, index.name);
    expect(client.getIndex).toHaveBeenCalledTimes(2);
    expect(client.createOrUpdateIndex).toHaveBeenLastCalledWith(expect.objectContaining({ etag: "v2" }), { onlyIfUnchanged: true });
  });

  it.each([
    { name: "asOf", type: "Edm.String" },
    { name: "asOf", type: "Edm.ComplexType", fields: [{ name: "year", type: "Edm.String", searchable: false, filterable: true }] },
  ])("rejects incompatible existing fields", async incompatible => {
    const client = clientFor({ ...index, fields: [...index.fields, incompatible as any] });
    await expect(ensureEvidenceSearchFields(client, index.name)).rejects.toThrow("Search field asOf");
    expect(client.createOrUpdateIndex).not.toHaveBeenCalled();
  });

  it("propagates update failures and bounds conflict retries", async () => {
    const client = clientFor(index);
    client.createOrUpdateIndex.mockRejectedValue({ statusCode: 412 });
    await expect(ensureEvidenceSearchFields(client, index.name)).rejects.toEqual({ statusCode: 412 });
    expect(client.createOrUpdateIndex).toHaveBeenCalledTimes(3);
  });

  it.each([
    { name: "evidenceKind", type: "Edm.String", filterable: false, facetable: true },
    { name: "claimant", type: "Edm.String", filterable: true, searchable: false, facetable: true },
    { name: "subject", type: "Edm.String", filterable: true, searchable: true, facetable: true },
  ])("rejects incompatible retrieval field $name without modifying the index", async field => {
    const client = clientFor({...index, fields: [...index.fields, field as any]});
    await expect(ensureEvidenceSearchFields(client, index.name)).rejects.toThrow(`Search field ${field.name}`);
    expect(client.createOrUpdateIndex).not.toHaveBeenCalled();
  });
});

describe("ingestion of dated evidence", () => {
  it("embeds and uploads the same date-bearing content and uploads the structured asOf date", async () => {
    const processor = Object.create(DocumentIngressProcessor.prototype) as any;
    const embedQuery = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    Object.assign(processor, { aoaiEmbeddings: { embedQuery, dimensions: 3 }, currentPosition: 0 });
    const metadata = { what: "An assessment score was recorded.", factType: "assessmentResult", tags: ["fact"],
      asOf: { year: "2025", month: "3", day: null, season: null, quarter: null },
      sourceSpans: [{ pageNumber: 1, sourceOffset: 0, sourceQuote: "Score: 65" }], sourceId: "source-1",
    };
    const source = new Document({ pageContent: formatEvidenceContent(metadata), metadata });
    const [entry] = await processor.generateDocumentEntry(source);
    expect(entry.content).toContain("As of: March 2025");
    expect(embedQuery).toHaveBeenCalledExactlyOnceWith(entry.content);
    expect(entry.content).toBe(source.pageContent);
    expect(entry.content_vector).toEqual([0.1, 0.2, 0.3]);
    expect(entry.asOf).toEqual(metadata.asOf);
    expect(JSON.parse(entry.metadata).asOf).toEqual(entry.asOf);
    expect(entry.evidenceKind).toBe("fact");
    expect(entry.factType).toBe("assessmentResult");
    expect(entry.claimant).toBeNull();
    expect(await processor.prepareFields()).toContainEqual(asOfSearchField());
    for (const field of evidenceRetrievalFields()) expect(await processor.prepareFields()).toContainEqual(field);
  });

  it("creates a retrievable content_vector so stored vectors can be reused", async () => {
    const processor = Object.create(DocumentIngressProcessor.prototype) as any;
    processor.aoaiEmbeddings = { dimensions: 3072 };
    const field = (await processor.prepareFields()).find((candidate: any) => candidate.name === "content_vector");
    expect(field).toMatchObject({ searchable: true, hidden: false, stored: true, vectorSearchDimensions: 3072 });
  });

  it("upgrades existing indexes through the ingestion path", async () => {
    const processor = Object.create(DocumentIngressProcessor.prototype) as any;
    const client = clientFor(index);
    await processor.createIfIndexDoesNotExist(client, index.name);
    expect(client.createOrUpdateIndex).toHaveBeenCalledWith(expect.objectContaining({
      fields: [...index.fields, ...extractionSearchFields(), ...evidenceRetrievalFields(), asOfSearchField()],
    }), { onlyIfUnchanged: true });
  });
});

describe("evidence retrieval projection", () => {
  const citations = {sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:"Source"}],sourceContentHash:"a".repeat(64)};

  it("keeps opposing claims attributable and separate from facts", () => {
    const claim = {...citations,tags:["claim","fact","event"],claimType:"allegation",claimant:"Alex O'Neil"};
    expect(evidenceSearchValues({...claim,claimPolarity:"asserts"})).toMatchObject({
      evidenceKind:"claim",claimant:"Alex O'Neil",claimPolarity:"asserts",factType:null,eventType:null,
      sourceContentHash:citations.sourceContentHash,
    });
    expect(evidenceSearchValues({...claim,claimPolarity:"denies"}).claimPolarity).toBe("denies");
  });

  it("distinguishes a fact's subject from its reporter and events from their inherited fact tag", () => {
    expect(evidenceSearchValues({...citations,tags:["fact","event"],factType:"assessmentResult",
      subject:["Casey"],reportedBy:["Dr. North"]})).toMatchObject({
      evidenceKind:"fact",subject:["Casey"],reportedBy:["Dr. North"],claimant:null,eventType:null,
    });
    expect(evidenceSearchValues({...citations,tags:["fact","event","eventType:assessment"]})).toMatchObject({
      evidenceKind:"event",eventType:"assessment",factType:null,
    });
  });

  it("does not classify ordinary chunks based on user-supplied evidence tags", () => {
    expect(evidenceSearchValues({tags:["fact","event","claim"],factType:"other",claimant:"Alex"})).toMatchObject({
      evidenceKind:null,eventType:null,factType:null,claimType:null,claimant:null,subject:[],reportedBy:[],
    });
  });

  it("uploads claim filters alongside the unchanged embedding content and citation metadata", async () => {
    const processor = Object.create(DocumentIngressProcessor.prototype) as any;
    const embedQuery = vi.fn().mockResolvedValue([0.1,0.2,0.3]);
    Object.assign(processor,{aoaiEmbeddings:{embedQuery},currentPosition:0});
    const metadata = {...citations,what:"Delivery was denied.",tags:["claim"],claimType:"denial",
      claimant:"Alex",claimPolarity:"denies"};
    const doc = new Document({pageContent:formatEvidenceContent(metadata),metadata});
    const [entry] = await processor.generateDocumentEntry(doc);
    expect(entry).toMatchObject({evidenceKind:"claim",claimType:"denial",claimant:"Alex",claimPolarity:"denies"});
    expect(JSON.parse(entry.metadata).sourceSpans).toEqual(citations.sourceSpans);
    expect(embedQuery).toHaveBeenCalledExactlyOnceWith(doc.pageContent);
  });
});

describe("enriched RAG ingestion into Azure AI Search", () => {
  it("embeds visual descriptions into searchable content and retains their source and generated origin", async () => {
    const caption = "Exhibit C: Vehicle photograph.";
    const description = "The photograph shows front-left fender damage and a broken headlight.";
    const location = { pages: [6], regions: ["D(6,1,1,4,3)"], startTimeMs: null, endTimeMs: null, speaker: null };
    const pkg = parseExtractionPackage({ version: 1, accountId: "account", sourceId: "source", mediaType: "document",
      provider: "content-understanding", analyzerId: "prebuilt-documentSearch", apiVersion: "2025-11-01", analysisId: "analysis",
      configurationHash: "a".repeat(64), sourceSha256: "b".repeat(64), stringEncoding: "utf16", literalMarkdown: caption,
      literalPages: [{ pageNumber: 6, text: caption, locationKind: "physical-page" }],
      blocks: [{ id: "caption", kind: "paragraph", origin: "extracted", text: caption, ...location, serviceSpans: [] },
        { id: "figure", kind: "figure-description", origin: "generated", text: description, ...location, serviceSpans: [] }],
      evidenceLocations: [{ pageNumber: 6, offset: 0, length: caption.length, blockId: "caption", ...location }],
      assets: [{ id: "image", kind: "figure", containerName: "results", containerPath: "cu-assets/figure.jpg",
        url: "https://storage.blob.core.windows.net/results/cu-assets/figure.jpg", contentType: "image/jpeg",
        sha256: "c".repeat(64), sizeBytes: 1234, serviceFilePath: "figures/1.1", blockIds: ["figure"],
        pages: [6], regions: location.regions, timeMs: null }],
      rawResponse: {}, usage: null, warnings: [] });
    const processor = Object.create(DocumentIngressProcessor.prototype) as any;
    const embedQuery = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    Object.assign(processor, { aoaiEmbeddings: { embedQuery }, currentPosition: 0, accountId: "account", sourceId: "source" });
    const chunks = extractionChunks(pkg);
    const entries = await Promise.all(chunks.map(async chunk => (await processor.generateDocumentEntry(chunk))[0]));
    const figure = entries.find(entry => entry.contentOrigin === "generated");
    expect(figure.content).toContain(description);
    expect(figure.content).toContain("AI-generated figure-description");
    expect(embedQuery).toHaveBeenCalledWith(figure.content);
    expect(figure.content_vector).toEqual([0.1, 0.2, 0.3]);
    expect(figure.pages).toEqual([6]);
    expect(figure.analysisId).toBe("analysis");
    expect(JSON.parse(figure.metadata).regions).toEqual(location.regions);
    expect(JSON.parse(figure.metadata).images[0].url).toBe(pkg.assets[0].url);
    expect(entries.find(entry => entry.contentOrigin === "extracted").content).not.toContain("fender damage");
  });
});
