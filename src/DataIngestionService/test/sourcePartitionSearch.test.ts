import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it, vi} from "vitest";
import {SourcePartitionSearch, SourcePartitionVisibilityError, type IndexedSourcePartition} from "../src/processors/evidence/sourcePartitionSearch.ts";
import {runSourcePartitionSearch} from "../scripts/test-source-partition-search.mjs";

function fixture(count = 3, options = {}) {
  const rows: IndexedSourcePartition[] = Array.from({length: count}, (_, index) => ({
    id: String(index), sourceId: "source'1", tags: [], content: `Partition ${index}`,
    metadata: JSON.stringify({sourceId: "source'1", tags: []}), pos: count - index, pages: [index + 1],
    contentOrigin: index === 1 ? "generated" : "extracted",
  }));
  const response = (records: IndexedSourcePartition[], count?: number) => ({count,
    results: (async function* () { for (const document of records) { await Promise.resolve(); yield {document}; } })()});
  const search = vi.fn(async (query: string, options?: unknown) => {
    void options;
    return response(query === "*" ? rows : rows.slice(0, 8), query === "*" ? rows.length : undefined);
  });
  const lookup = new SourcePartitionSearch({search} as any, "account", "source'1", options);
  return {rows, search, lookup, response};
}

describe("untagged source partition lookup", () => {
  it("enumerates all matching rows without requiring evidence facets, hashes, or valid source order", async () => {
    const {lookup, search, rows} = fixture(60);
    const snapshot = await lookup.snapshot();
    expect(snapshot.records).toHaveLength(60);
    expect(snapshot.records.find(row => row.id === "0")?.pos).toBe(rows[0].pos);
    expect(search.mock.calls[0][1]).toMatchObject({filter: "sourceId eq 'source''1' and not tags/any()",
      includeTotalCount: true, orderBy: ["pos asc"], select: expect.arrayContaining(["tags", "content", "metadata"])});
    expect(search.mock.calls[0][1]).not.toHaveProperty("top");
    expect((search.mock.calls[0][1] as any).select).not.toContain("content_vector");
  });

  it("uses the same whole-source filter for semantic and hybrid lookups and retains generated provenance", async () => {
    const {lookup, search} = fixture(3, {semanticConfiguration: "Primary"});
    const result = await lookup.lookup(await lookup.snapshot(), [{id: "plain", text: "A source assertion"},
      {id: "hybrid", text: "Another assertion", vector: [1, 0]}]);
    expect(result[0].hits.map(row => row.pages?.[0])).toEqual([1, 2, 3]);
    expect(result[0].hits[1].contentOrigin).toBe("generated");
    for (const [query, options] of search.mock.calls) {
      expect((options as any).filter).toBe("sourceId eq 'source''1' and not tags/any()");
      if (query !== "*") expect(options).toMatchObject({select: ["id"], queryType: "semantic",
        semanticSearchOptions: {configurationName: "Primary", errorMode: "fail"}});
    }
    expect(search.mock.calls.find(([query]) => query === "Another assertion")?.[1]).toMatchObject({vectorSearchOptions: {
      filterMode: "preFilter", queries: [{kind: "vector", vector: [1, 0], fields: ["content_vector"], kNearestNeighborsCount: 50}]}});
    expect(lookup.stats).toEqual({snapshotQueries: 2, lexicalQueries: 1, hybridQueries: 1});
  });

  it("retains query-specific scores without changing snapshot records or applying a cutoff", async () => {
    const {lookup, search, rows, response} = fixture(3, {semanticConfiguration: "Primary"});
    const snapshot = await lookup.snapshot();
    search.mockImplementation(async query => query === "*" ? response(rows, rows.length) : {results: (async function* () {
      yield {document: rows[0], score: 0.03, rerankerScore: query === "first" ? 3.2 : 1.1};
      yield {document: rows[1], score: 0, rerankerScore: 0};
      yield {document: rows[2], score: NaN, rerankerScore: Infinity};
    })()});
    const results = await lookup.lookup(snapshot, [{id: "one", text: "first"}, {id: "two", text: "second"}]);
    expect(results[0].hits).toHaveLength(3);
    expect(results[0].hits[0]).toMatchObject({searchScore: 0.03, rerankerScore: 3.2});
    expect(results[1].hits[0].rerankerScore).toBe(1.1);
    expect(results[0].hits[1]).toMatchObject({searchScore: 0, rerankerScore: 0});
    expect(results[0].hits[2]).not.toHaveProperty("rerankerScore");
    expect(results[0].hits[2]).not.toHaveProperty("searchScore");
    expect(snapshot.records.every(row => !("rerankerScore" in row) && !("searchScore" in row))).toBe(true);
  });

  it.each(["fact", "CurrentOrder", ""])("excludes records containing any tag, including %j", async tag => {
    const {lookup, rows} = fixture();
    rows[0].tags = [tag];
    await expect(lookup.snapshot()).rejects.toThrow("tagged");
  });

  it("rejects incomplete pagination, duplicate records, and source mismatches", async () => {
    for (const scenario of ["count", "duplicate", "source", "account", "limit"]) {
      const {lookup, rows, search, response} = fixture(3, {maxRecords: scenario === "limit" ? 2 : 100});
      if (scenario === "count") search.mockResolvedValueOnce(response(rows.slice(0, 2), 3));
      if (scenario === "duplicate") search.mockResolvedValueOnce(response([rows[0], rows[0]], 2));
      if (scenario === "source") rows[0].sourceId = "another";
      if (scenario === "account") rows[0].metadata = JSON.stringify({accountId: "another"});
      const failure = await lookup.snapshot().then(() => undefined, error => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof SourcePartitionVisibilityError).toBe(["count", "duplicate"].includes(scenario));
    }
  });

  it("passes the caller's overall readiness deadline into Search requests", async () => {
    const {lookup, search} = fixture();
    const controller = new AbortController(), stopped = new Error("readiness deadline expired");
    await lookup.snapshot(controller.signal);
    const signal = (search.mock.calls[0][1] as any).abortSignal as AbortSignal;
    controller.abort(stopped);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(stopped);
  });

  it("rejects another account's snapshot and oversized query batches before sending query text", async () => {
    const {lookup, search} = fixture();
    const snapshot = await lookup.snapshot(), queries = [{id: "1", text: "Assertion"}, {id: "2", text: "Assertion two"}];
    const other = new SourcePartitionSearch({search} as any, "other-account", "source'1");
    await expect(other.lookup(snapshot, queries)).rejects.toThrow("scope");
    const bounded = new SourcePartitionSearch({search} as any, "account", "source'1", {maxQueries: 1});
    await expect(bounded.lookup(snapshot, queries)).rejects.toThrow("budget");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("rejects source changes after collecting hit IDs", async () => {
    const {lookup, search, rows, response} = fixture();
    const snapshot = await lookup.snapshot();
    search.mockImplementation(async query => response(query === "*" ? [{...rows[0], content: "changed"}, ...rows.slice(1)] : rows));
    await expect(lookup.lookup(snapshot, [{id: "q", text: "Assertion"}])).rejects.toThrow("changed");
  });

  it("rejects unknown hit IDs and partial semantic responses", async () => {
    for (const partial of [false, true]) {
      const {lookup, search, rows, response} = fixture(3, {semanticConfiguration: "Primary"});
      const snapshot = await lookup.snapshot();
      search.mockResolvedValue(partial ? {...response(rows), semanticErrorReason: "capacityOverloaded"} as any
        : response([{id: "foreign"} as IndexedSourcePartition]));
      await expect(lookup.lookup(snapshot, [{id: "q", text: "Assertion"}])).rejects.toThrow(partial ? "partial" : "unknown");
    }
  });

  it("saves a read-only test report for untagged partitions without invoking evidence deduplication", async () => {
    const {lookup} = fixture();
    const directory = await mkdtemp(join(tmpdir(), "source-partition-search-"));
    try {
      const report = await runSourcePartitionSearch({endpoint: "https://example.search.windows.net", index: "account-index",
        "account-id": "account", "source-id": "source'1", output: join(directory, "output")}, {lookup});
      expect(report).toMatchObject({filter: "sourceId eq 'source''1' and not tags/any()", records: 3,
        origins: {extracted: 2, generated: 1}, chatModelCalls: 0, newEmbeddingCalls: 0, indexChanged: false, reconstructedSource: false});
      expect(JSON.parse(await readFile(join(directory, "output", "snapshot.json"), "utf8")).records).toHaveLength(3);
    } finally { await rm(directory, {recursive: true, force: true}); }
  });
});
