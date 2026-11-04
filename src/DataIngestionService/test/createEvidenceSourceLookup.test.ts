import {Document} from "@langchain/core/documents";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.ts";
import {createEvidenceSourceLookup} from "../src/processors/evidence/createEvidenceSourceLookup.ts";
import {partitionIdsHash} from "../src/processors/evidence/evidenceSourceLookup.ts";
import {SourcePartitionSearch} from "../src/processors/evidence/sourcePartitionSearch.ts";

const mocks = vi.hoisted(() => ({query: vi.fn(), dispose: vi.fn(), search: vi.fn(), client: vi.fn(), embeddings: vi.fn()}));
vi.mock("@azure/cosmos", () => ({CosmosClient: class {
  database() {return {container: () => ({items: {query: mocks.query}})};} dispose = mocks.dispose;
}}));
vi.mock("@azure/search-documents", () => ({SearchClient: class {
  constructor(readonly endpoint: string, readonly indexName: string, _credential: unknown, options: unknown) {mocks.client(endpoint, indexName, options);}
  search = mocks.search;
}}));
vi.mock("../src/processors/azureOpenAIEmbeddingsWithTelemetry.js", () => ({AzureOpenAIEmbeddingsWithTelemetry: class {embedBatch = mocks.embeddings;}}));
vi.mock("../src/processors/appInsights.js", () => ({telemetryClient: {trackEvent: vi.fn()}}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AZURE_OPENAI_CUSTOM_ENDPOINT", "https://embedding.test");
  mocks.query.mockReturnValue({fetchAll: async () => ({resources: [{searchEndpoint: "https://account.search.windows.net", dataSourceId: "account-index"}]})});
  mocks.embeddings.mockImplementation(async texts => texts.map(() => Array.from({length: 3072}, (_, i) => i === 0 ? 1 : 0)));
});
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const source = new EvidenceSource(new Document({pageContent: "The recorded score is 42.", metadata: {accountId: "account", sourceId: "source", pages: [1]}}));
  const row = {id: "one", sourceId: "source", tags: [], content: source.document.pageContent, pages: [1], pos: 1,
    metadata: JSON.stringify({accountId: "account", sourceId: "source", sourceContentHash: source.contentHash}), contentOrigin: "extracted"};
  mocks.search.mockImplementation(async () => ({count: 1, results: (async function* () {yield {document: row};})()}));
  const snapshot = await new SourcePartitionSearch({search: mocks.search, endpoint: "https://account.search.windows.net", indexName: "account-index"} as any,
    "account", "source").snapshot();
  source.document.metadata.sourcePartitionManifest = {sourceContentHash: source.contentHash, count: 1,
    idsHash: partitionIdsHash([row.id]), snapshotFingerprint: snapshot.fingerprint};
  mocks.search.mockClear();
  return {source, row};
}

describe("runtime Search lookup readiness", () => {
  it("uses the configured cutoff and includes it in the lazy decision identity", async () => {
    const {source, row} = await fixture();
    mocks.search.mockImplementation(async () => ({count: 1, results: (async function* () {yield {document: row, rerankerScore: 1};})()}));
    const unfiltered = await createEvidenceSourceLookup("account", "source", source);
    vi.stubEnv("EVIDENCE_SOURCE_MIN_RERANKER_SCORE", "2");
    const filtered = await createEvidenceSourceLookup("account", "source", source);
    expect(filtered.fingerprint).not.toBe(unfiltered.fingerprint);
    expect(mocks.search).not.toHaveBeenCalled();
    const request = {query: "score", pageNumber: 1, purpose: "review" as const};
    expect(await filtered.search(request)).toEqual({passages: []});
    expect((await filtered.search({...request, citations: [{pageNumber: 1, sourceOffset: 0, sourceQuote: row.content}]})).passages).toHaveLength(1);
    vi.stubEnv("EVIDENCE_SOURCE_MIN_RERANKER_SCORE", "typo");
    await expect(createEvidenceSourceLookup("account", "source", source)).rejects.toThrow("0 to 4");
  });

  it("does no Cosmos, Search or embedding work until a tool actually requests context", async () => {
    const {source} = await fixture();
    source.document.metadata.searchEndpoint = "https://untrusted.invalid";
    const lookup = await createEvidenceSourceLookup("account", "source", source);
    await lookup.verify();
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.search).not.toHaveBeenCalled(); expect(mocks.embeddings).not.toHaveBeenCalled();
    expect((await lookup.search({query: "recorded score", pageNumber: 1, purpose: "review"})).passages).toHaveLength(1);
    expect(mocks.query.mock.calls[0][1]).toEqual({partitionKey: ["account"]});
    expect(mocks.client).toHaveBeenCalledWith("https://account.search.windows.net", "account-index", {serviceVersion: "2026-04-01"});
    expect(mocks.search.mock.calls.every(([, options]) => options.filter === "sourceId eq 'source' and not tags/any()")).toBe(true);
    expect(mocks.embeddings).toHaveBeenCalledTimes(1);
  });

  it("fails on a changed corpus before generating query vectors", async () => {
    const {source, row} = await fixture();
    const lookup = await createEvidenceSourceLookup("account", "source", source);
    row.content += " changed";
    await expect(lookup.search({query: "score", pageNumber: 1, purpose: "review"})).rejects.toThrow("fully visible");
    expect(mocks.embeddings).not.toHaveBeenCalled();
  });

  it("requires readiness and rejects a source/account mismatch before external reads", async () => {
    const {source} = await fixture();
    await expect(createEvidenceSourceLookup("other", "source", source)).rejects.toThrow("identity");
    await expect(createEvidenceSourceLookup("account", "other", source)).rejects.toThrow("identity");
    delete source.document.metadata.sourcePartitionManifest;
    await expect(createEvidenceSourceLookup("account", "source", source)).rejects.toThrow("readiness");
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.embeddings).not.toHaveBeenCalled();
  });
});
