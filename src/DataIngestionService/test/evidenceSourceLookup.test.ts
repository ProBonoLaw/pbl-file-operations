import {Document} from "@langchain/core/documents";
import {createHash} from "node:crypto";
import {afterEach, describe, expect, it, vi} from "vitest";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.ts";
import {SearchSourceContext, partitionIdsHash, sourceLookupMode, sourcePartitionPassages, validatePartitionManifest} from "../src/processors/evidence/evidenceSourceLookup.ts";
import {SourcePartitionSearch, type IndexedSourcePartition} from "../src/processors/evidence/sourcePartitionSearch.ts";
import type {EvidenceCheckpointStore} from "../src/processors/evidence/evidenceCheckpoint.ts";
import {EvidenceEmbeddingCache} from "../src/processors/evidence/evidenceEmbeddingCache.ts";
import {EvidenceReconciliationTimeoutError, reconciliationCheckpointGuard, reconciliationSignal,
  withReconciliationDeadline} from "../src/processors/evidence/evidenceReconciliationDeadline.ts";

afterEach(() => {vi.unstubAllEnvs(); vi.useRealTimers();});
function fixture() {
  const source = new EvidenceSource(new Document({pageContent: "Morgan scored 42.\n\nThe report was signed on May 3.<!-- PageBreak -->The score was reported by Lee.",
    metadata: {accountId: "account", sourceId: "source", pages: [1, 2]}}));
  const rows: IndexedSourcePartition[] = source.pages.map(page => ({id: String(page.pageNumber),
    sourceId: "source", tags: [], content: page.text, pages: [page.pageNumber], pos: 3 - page.pageNumber,
    metadata: JSON.stringify({accountId: "account", sourceContentHash: source.contentHash}), contentOrigin: "extracted"}));
  rows.push({...rows[0], id: "generated", content: "Generated interpretation of the results", contentOrigin: "generated"});
  const search = vi.fn(async (query: string) => ({count: query === "*" ? rows.length : undefined,
    results: (async function* () {for (const row of rows) yield {document: row};})()}));
  const lookup = new SourcePartitionSearch({search} as any, "account", "source", {semanticConfiguration: "Primary"});
  const vectors = vi.fn(async (texts: readonly string[]) => texts.map(() => [0.1, 0.2]));
  const records = new Map<string, unknown>();
  const store = {getStage: vi.fn(async (identity, _window, stage) => records.get(identity.runFingerprint + stage) ?? null),
    putStage: vi.fn(async (identity, _window, stage, value) => {records.set(identity.runFingerprint + stage, value);})} as unknown as EvidenceCheckpointStore;
  const report = vi.fn();
  const create = async (model = "embedding-v1", cutoff: number | null = null) => new SearchSourceContext(source, lookup, await lookup.snapshot(), "account", {vectors}, model, store, report, cutoff);
  const request = {pageNumber: 1, query: "Morgan score", purpose: "review" as const};
  return {source, rows, search, lookup, vectors, store, create, request, records, report};
}

describe("Search context for reconciliation", () => {
  it("changes decision identity and reapplies the cutoff using cached raw hits without new retrieval", async () => {
    const {create, request, rows, search, vectors, lookup, report} = fixture();
    search.mockImplementation(async query => ({count: query === "*" ? rows.length : undefined,
      results: (async function* () {for (const document of rows) yield {document, rerankerScore: 1};})()}));
    const unfiltered = await create(), baseline = await unfiltered.search(request), filtered = await create("embedding-v1", 2);
    expect(filtered.fingerprint).not.toBe(unfiltered.fingerprint);
    expect(baseline.passages.length).toBeGreaterThan(0);
    expect(await filtered.search(request)).toEqual({passages: []});
    const citation = {pageNumber: 1, sourceOffset: 0, sourceQuote: "Morgan scored 42."};
    expect((await filtered.search({...request, citations: [citation]})).passages).toHaveLength(1);
    expect(await filtered.search(request)).toEqual({passages: []});
    expect(vectors).toHaveBeenCalledTimes(1); expect(lookup.stats.hybridQueries).toBe(1);
    expect(report.mock.calls.at(-2)?.[0]).toMatchObject({minimumRerankerScore: 2, returnedHits: 3,
      retainedHits: 1, filteredHits: 2, citationProtectedHits: 1});
  });

  it("batches concurrent unique queries and reuses a repeated query across pages", async () => {
    const {create, request, vectors, lookup} = fixture();
    const context = await create();
    const results = await Promise.all([context.search(request), context.search({...request, pageNumber: 2}),
      context.search({...request, query: "Who reported the score?"})]);
    expect(vectors).toHaveBeenCalledExactlyOnceWith(["Morgan score", "Who reported the score?"]);
    expect(lookup.stats.hybridQueries).toBe(2);
    expect(context.stats).toEqual({requests: 3, cacheHits: 1, searchBatches: 1});
    expect(results[0]).toEqual(results[1]);
    expect(results[0].passages[0]).toMatchObject({pageNumber: 1, sourceOffset: 0, sourceQuote: "Morgan scored 42."});
  });

  it("restores complete query results on restart without embeddings or new ranked queries", async () => {
    const {create, request, vectors, lookup} = fixture();
    const first = await (await create()).search(request);
    const restarted = await create();
    expect(await restarted.search(request)).toEqual(first);
    expect(vectors).toHaveBeenCalledTimes(1);
    expect(lookup.stats.hybridQueries).toBe(1);
    expect(restarted.stats.cacheHits).toBe(1);
    expect(lookup.stats.snapshotQueries).toBe(4); // Both restarts verify the full corpus.
  });

  it("retains scores across restart and reports aggregates without adding scores to model context", async () => {
    const {create, request, rows, search, lookup, records, report} = fixture();
    search.mockImplementation(async query => ({count: query === "*" ? rows.length : undefined,
      results: (async function* () {for (const [index, document] of rows.entries()) yield {document,
        score: 0.02, ...(index < 2 ? {rerankerScore: index === 0 ? 3 : 0} : {})};})()}));
    const first = await (await create()).search(request);
    expect(await (await create()).search(request)).toEqual(first);
    expect(lookup.stats.hybridQueries).toBe(1);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1][0]).toEqual(report.mock.calls[0][0]);
    expect(report.mock.calls[0][0]).toMatchObject({returnedHits: 3, rerankedHits: 2, missingRerankerScores: 1,
      rerankerScoreSum: 3, rerankerScoreMin: 0, rerankerScoreMax: 3, passageCount: 2, unverifiedCount: 1});
    expect(JSON.stringify(first)).not.toContain("Score");
    expect([...records.values()][0]).toMatchObject({version: 2, hits: [
      {id: "1", searchScore: 0.02, rerankerScore: 3}, {id: "2", searchScore: 0.02, rerankerScore: 0},
      {id: "generated", searchScore: 0.02}]});
    expect(JSON.stringify(report.mock.calls)).not.toContain("Morgan");
  });

  it.each(["score", "id", "content", "type", "duplicate", "legacy"])("rejects corrupt or legacy scored cache entries: %s", async scenario => {
    const {create, request, records, vectors} = fixture();
    await (await create()).search(request);
    const [key, saved] = [...records.entries()][0];
    const entry = JSON.parse(JSON.stringify(saved));
    if (scenario === "score") entry.hits[0].rerankerScore = 4; // Hash mismatch.
    if (scenario === "id") entry.hits[0].id = "foreign";
    if (scenario === "content") entry.hits[0].content = "Injected citation";
    if (scenario === "type") entry.hits[0].rerankerScore = "3";
    if (scenario === "duplicate") entry.hits.push(entry.hits[0]);
    if (scenario !== "score") entry.hash = createHash("sha256").update(JSON.stringify(entry.hits)).digest("hex");
    records.set(key, scenario === "legacy" ? {ids: entry.hits.map(hit => hit.id), hash: entry.hash} : entry);
    await expect((await create()).search(request)).rejects.toThrow("Invalid cached source lookup");
    expect(vectors).toHaveBeenCalledTimes(1);
  });

  it("invalidates durable query reuse when model identity or source content changes", async () => {
    const {create, request, vectors, rows} = fixture();
    await (await create()).search(request);
    await (await create("embedding-v2")).search(request);
    rows[0].content += " Additional indexed context.";
    await (await create()).search(request);
    expect(vectors).toHaveBeenCalledTimes(3);
  });

  it("fails hybrid queries with missing vectors instead of silently running lexical search", async () => {
    const {create, request, vectors, lookup} = fixture();
    vectors.mockResolvedValueOnce([null] as any);
    await expect((await create()).search(request)).rejects.toThrow("query vector");
    expect(lookup.stats.hybridQueries).toBe(0);
    expect(lookup.stats.lexicalQueries).toBe(0);
  });

  it("refuses another source revision and incomplete readiness manifests", async () => {
    const {source, lookup, rows, create} = fixture();
    const snapshot = await lookup.snapshot();
    const manifest = {sourceContentHash: source.contentHash, count: rows.length, idsHash: partitionIdsHash(rows.map(row => row.id))};
    expect(() => validatePartitionManifest(snapshot, manifest, source)).not.toThrow();
    for (const value of [null, {...manifest, count: 1}, {...manifest, idsHash: "other"}, {...manifest, sourceContentHash: "other"}])
      expect(() => validatePartitionManifest(snapshot, value, source)).toThrow("fully visible");
    rows[0].metadata = JSON.stringify({sourceContentHash: "other"});
    await expect(create()).rejects.toThrow("another document revision");
  });

  it("detects changes before a model decision can be saved, including after memory-cache reuse", async () => {
    const {create, rows, request} = fixture();
    const context = await create();
    await context.search(request);
    rows[0].content += " changed";
    await expect(context.verify()).rejects.toThrow("changed");
  });

  it("preserves generated provenance without fabricating source offsets or relying on pos", () => {
    const {source, rows} = fixture();
    rows[0].content = "Morgan   scored 42.";
    const result = sourcePartitionPassages(source, [rows[2], rows[0], {...rows[1], content: "Text not in the original"}], "Morgan");
    expect(result.passages).toEqual([{id: "1", pageNumber: 1, sourceOffset: 0, sourceQuote: "Morgan scored 42.", contentOrigin: "extracted"}]);
    expect(result.unverifiedContext).toEqual([
      {id: "generated", contentOrigin: "generated", pages: [1], text: "Generated interpretation of the results"},
      {id: "2", contentOrigin: "extracted", pages: [2], text: "Text not in the original"},
    ]);
    expect(JSON.stringify(result.unverifiedContext)).not.toContain("sourceOffset");
  });

  it("bounds query inputs and respects a cancelled tool before doing work", async () => {
    const {create, request, vectors} = fixture();
    const context = await create();
    for (const query of ["", "x".repeat(4001)]) await expect(context.search({...request, query})).rejects.toThrow("Invalid");
    await expect(context.search(request, AbortSignal.abort())).rejects.toThrow();
    expect(vectors).not.toHaveBeenCalled();
  });

  it("rejects only the cancelled request and keeps serving the rest of its batch", async () => {
    const {create, request, vectors} = fixture();
    const context = await create(), controller = new AbortController();
    const cancelled = expect(context.search(request, controller.signal)).rejects.toThrow("deadline");
    const other = context.search({...request, query: "Who reported the score?"});
    controller.abort(new Error("deadline"));
    await cancelled;
    expect((await other).passages.length).toBeGreaterThan(0);
    expect(vectors).toHaveBeenCalledExactlyOnceWith(["Who reported the score?"]);
  });

  it("lets a caller that shared a cancelled lookup run it again", async () => {
    const {create, request} = fixture();
    const context = await create(), controller = new AbortController();
    const cancelled = expect(context.search(request, controller.signal)).rejects.toThrow("deadline");
    const sharer = context.search({...request, pageNumber: 2});
    controller.abort(new Error("deadline"));
    await cancelled;
    expect((await sharer).passages[0]).toMatchObject({sourceQuote: "Morgan scored 42."});
  });

  it("keeps other queries and shared waiters alive when the embedding owner's deadline expires in flight", async () => {
    vi.useFakeTimers();
    const {create, request, vectors, store, lookup} = fixture();
    let finish!: () => void;
    const inFlight = new Promise<void>(resolve => {finish = resolve;});
    const provider = {embedBatch: vi.fn(async (texts: string[]) => {
      if (provider.embedBatch.mock.calls.length === 1) await inFlight;
      return texts.map(() => [0.1, 0.2]);
    })};
    const embeddings = new EvidenceEmbeddingCache("account", "source", {endpoint: "https://example.test",
      deployment: "embedding", model: "embedding", apiVersion: "test", dimensions: 2, inputVersion: "strip-newlines-v1"}, provider, store);
    const embeddingSignals: (AbortSignal | undefined)[] = [];
    vectors.mockImplementation(texts => {
      embeddingSignals.push(reconciliationSignal());
      return embeddings.vectors(texts, reconciliationCheckpointGuard()) as Promise<number[][]>;
    });
    const context = await create();
    const expired = withReconciliationDeadline(100, () => context.search(request, reconciliationSignal()), vi.fn())
      .catch(error => error);
    let activeSignal: AbortSignal | undefined;
    const active = withReconciliationDeadline(1000, () => {
      activeSignal = reconciliationSignal();
      return Promise.all([context.search({...request, pageNumber: 2}, activeSignal), context.search(request, activeSignal),
        context.search({...request, query: "Who reported the score?"}, activeSignal)]);
    }, vi.fn()).then(value => ({value}), error => ({error}));
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.embedBatch).toHaveBeenCalledExactlyOnceWith(["Morgan score", "Who reported the score?"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(await expired).toBeInstanceOf(EvidenceReconciliationTimeoutError);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await active;
    expect(result).not.toHaveProperty("error");
    if (!("value" in result)) throw result.error;
    expect(result.value.map(value => value.passages.length)).toEqual([2, 2, 2]);
    expect(result.value[0]).toEqual(result.value[1]);
    expect(embeddingSignals[0]?.aborted).toBe(true);
    expect(embeddingSignals.slice(1)).toEqual([activeSignal, activeSignal]);
    expect(activeSignal?.aborted).toBe(false);
    expect(provider.embedBatch).toHaveBeenCalledTimes(3);
    expect(lookup.stats.hybridQueries).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates genuine embedding failures to active callers without retrying them", async () => {
    const {create, request, vectors, lookup} = fixture();
    const failure = new Error("Embedding service unavailable");
    vectors.mockRejectedValue(failure);
    const context = await create();
    const results = await Promise.allSettled([context.search(request), context.search({...request, pageNumber: 2}),
      context.search({...request, query: "Who reported the score?"})]);
    expect(results).toEqual(Array.from({length: 3}, () => ({status: "rejected", reason: failure})));
    expect(vectors).toHaveBeenCalledOnce();
    expect(lookup.stats.hybridQueries).toBe(0);
  });

  it("drops a query cancelled during successful embedding work without shifting the remaining vectors", async () => {
    const {create, request, vectors, lookup} = fixture();
    const controller = new AbortController(), context = await create(), search = vi.spyOn(lookup, "lookup");
    vectors.mockImplementationOnce(async () => {
      controller.abort(new Error("deadline"));
      return [[1, 0], [0, 1]];
    });
    const cancelled = expect(context.search(request, controller.signal)).rejects.toThrow("deadline");
    const active = context.search({...request, query: "Who reported the score?"});
    await cancelled;
    expect((await active).passages.length).toBeGreaterThan(0);
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0][1]).toEqual([expect.objectContaining({text: "Who reported the score?", vector: [0, 1]})]);
    expect(vectors).toHaveBeenCalledOnce();
  });

  it("routes the existing source tool to Search and preserves its six-read budget", async () => {
    const {source, create, request} = fixture();
    const context = await create(), search = vi.spyOn(context, "search"), budget = {reads: 5};
    const tool = source.contextSearchTool(budget, undefined, "json", context);
    const result = JSON.parse(await tool.invoke(request));
    expect(result.passages.length).toBeGreaterThan(0);
    expect(result.scope).toContain("generated content");
    expect(JSON.parse(await tool.invoke(request)).error).toContain("budget exhausted");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("uses an explicit rollout setting and rejects configuration typos", () => {
    vi.stubEnv("EVIDENCE_SOURCE_LOOKUP_MODE", ""); expect(sourceLookupMode()).toBe("local");
    vi.stubEnv("EVIDENCE_SOURCE_LOOKUP_MODE", "hybrid"); expect(sourceLookupMode()).toBe("hybrid");
    vi.stubEnv("EVIDENCE_SOURCE_LOOKUP_MODE", "typo"); expect(sourceLookupMode).toThrow("local or hybrid");
  });
});
