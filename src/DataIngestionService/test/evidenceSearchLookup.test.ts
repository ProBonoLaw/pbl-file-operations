import type { SearchClient } from "@azure/search-documents";
import { Document } from "@langchain/core/documents";
import { describe, expect, it, vi } from "vitest";
import { EvidenceSearchLookup, type IndexedEvidenceRecord, type EvidenceSearchLookupOptions } from "../src/processors/evidence/evidenceSearchLookup.ts";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { formatEvidenceContent } from "../src/processors/evidence/evidenceContent.ts";
import { findCanonicalizationPairs, applyCanonicalizationDecisions } from "../src/processors/evidence/evidenceCanonicalization.ts";

function fixture(options: EvidenceSearchLookupOptions = {}) {
  const quotes = ["The company terminated Casey.", "Casey was fired by the employer.", "Casey began a course."];
  const source = new Document({pageContent: quotes.join("\n\n"), metadata: {sourceId: "source'1", pages: [1]}});
  const hash = new EvidenceSource(source).contentHash;
  const rows: IndexedEvidenceRecord[] = quotes.map((quote, index) => {
    const sourceOffset = source.pageContent.indexOf(quote);
    const metadata = {accountId: "account", sourceId: "source'1", sourceContentHash: hash,
      what: quote, who: ["Casey"], subject: ["Casey"], reportedBy: [], factType: "attribute",
      where: "Unknown", why: "Unknown", tags: ["fact"], pages: [1], sourceQuote: quote, sourceOffset,
      sourceSpans: [{pageNumber: 1, sourceOffset, sourceQuote: quote}], evidenceJobId: "job-1"};
    return {id: String(index), sourceId: "source'1", sourceContentHash: hash, evidenceKind: "fact",
      content: formatEvidenceContent(metadata), metadata: JSON.stringify(metadata), content_vector: [1, index / 100]};
  });
  const response = (documents: IndexedEvidenceRecord[], count?: number) => ({count,
    results: (async function* () { for (const document of documents) { await Promise.resolve(); yield {document}; } })()});
  const search = vi.fn(async (query: string, options: unknown) => {
    return response(query === "*" ? [...rows].reverse() : rows.slice(0, (options as {top?: number}).top),
      query === "*" ? rows.length : undefined);
  });
  const lookup = new EvidenceSearchLookup({search} as unknown as Pick<SearchClient<IndexedEvidenceRecord>, "search">,
    "account", source, options);
  return {source, rows, search, lookup, response};
}

describe("Search-backed evidence lookup", () => {
  it("enumerates all records and validates source text without reconstructing lossy chunks", async () => {
    const {lookup, search, rows} = fixture();
    const snapshot = await lookup.snapshot();
    expect(snapshot.records.map(row => row.id)).toEqual(rows.map(row => row.id));
    expect(snapshot.documents.map(doc => doc.pageContent)).toEqual(rows.map(row => row.content));
    expect(search.mock.calls[0][1]).toMatchObject({includeTotalCount: true,
      orderBy: ["pos asc"],
      filter: expect.stringContaining("sourceId eq 'source''1' and sourceContentHash eq '"),
      select: expect.arrayContaining(["content_vector", "metadata"])});
    expect(search.mock.calls[0][1]).not.toHaveProperty("top");
  });

  it("uses canonical citations when partition ordinals are out of source order", async () => {
    const {lookup, rows, search} = fixture();
    for (const [index, row] of rows.entries()) {
      row.pos = [900, 4, 71][index];
      row.metadata = JSON.stringify({...JSON.parse(row.metadata), pos: row.pos});
    }
    const snapshot = await lookup.snapshot();
    expect(snapshot.documents.map(doc => doc.metadata.sourceOffset)).toEqual(rows.map(row => JSON.parse(row.metadata).sourceOffset));
    expect(await lookup.duplicatePairs(snapshot)).toHaveLength(3);
    for (const [, options] of search.mock.calls.filter(([query]) => query !== "*"))
      expect((options as any).filter).toContain("pages/any(p: p eq 1)");
  });

  it("supports non-retrievable vectors explicitly without requesting or generating embeddings", async () => {
    const {lookup, rows, search} = fixture({includeVectors: false, semanticConfiguration: "Primary"});
    for (const row of rows) delete row.content_vector;
    await lookup.duplicatePairs(await lookup.snapshot());
    expect((search.mock.calls[0][1] as any).select).not.toContain("content_vector");
    for (const [, options] of search.mock.calls.filter(([query]) => query !== "*")) {
      expect(options).not.toHaveProperty("vectorSearchOptions");
      expect(options).toMatchObject({queryType: "semantic"});
    }
    expect(lookup.stats).toMatchObject({hybridQueries: 0, lexicalQueries: 3, recordsWithoutVectors: 3});
  });

  it("enforces the query budget for lexical-only lookups", async () => {
    const {lookup, rows} = fixture({includeVectors: false, maxQueries: 1});
    for (const row of rows) delete row.content_vector;
    await expect(lookup.duplicatePairs(await lookup.snapshot())).rejects.toThrow("budget exhausted");
    expect(lookup.stats).toMatchObject({hybridQueries: 0, lexicalQueries: 1});
  });

  it("shares identical page queries across records while retaining all pairs", async () => {
    const {lookup, rows, search} = fixture({includeVectors: false, maxQueries: 2});
    for (const row of rows) delete row.content_vector;
    const metadata = {...JSON.parse(rows[1].metadata), what: JSON.parse(rows[0].metadata).what};
    rows[1].metadata = JSON.stringify(metadata);
    rows[1].content = formatEvidenceContent(metadata);
    expect(await lookup.duplicatePairs(await lookup.snapshot())).toHaveLength(3);
    expect(search).toHaveBeenCalledTimes(4); // Two snapshots plus two distinct queries.
    expect(lookup.stats).toMatchObject({hybridQueries: 0, lexicalQueries: 2, cachedQueries: 1});
  });

  it("reuses stored vectors, preserves lexical leads, and requires review before merging", async () => {
    const {lookup, search} = fixture({topK: 1, semanticConfiguration: "Primary"});
    const snapshot = await lookup.snapshot();
    const pairs = await lookup.duplicatePairs(snapshot);
    const planned = findCanonicalizationPairs(snapshot.documents, {searchPairs: pairs, source: lookup.source});
    expect(planned.find(pair => pair.id === "0:1")?.matchReasons).toContain("search");
    expect(applyCanonicalizationDecisions(snapshot.documents, planned, []).documents).toHaveLength(3);
    expect(search.mock.calls[1][1]).toMatchObject({queryType: "semantic", semanticSearchOptions: {configurationName: "Primary"},
      scoringStatistics: "global", sessionId: expect.stringMatching(/^[a-f0-9]{64}$/),
      filter: expect.stringContaining("pages/any(p: p eq 1)"), top: 2,
      vectorSearchOptions: {filterMode: "preFilter", queries: [{kind: "vector", vector: snapshot.records[0].content_vector,
        fields: ["content_vector"], kNearestNeighborsCount: 50}]}});
    expect((search.mock.calls[1][1] as any).select).not.toContain("content_vector");
    expect((search.mock.calls[1][1] as any).select).toEqual(["id"]);
    expect((search.mock.calls[1][1] as any).semanticSearchOptions.errorMode).toBe("fail");
    expect(lookup.stats.snapshotQueries).toBe(2);
    const calls = search.mock.calls.length;
    expect(await lookup.duplicatePairs(snapshot)).toEqual(pairs);
    expect(search).toHaveBeenCalledTimes(calls + 1); // Cached leads still need a current snapshot check.
    expect(lookup.stats).toMatchObject({hybridQueries: 3, cachedQueries: 3, snapshotQueries: 3, recordsWithoutVectors: 0});
  });

  it("rejects cached neighbor leads when the index changed after an earlier verified call", async () => {
    const {lookup, rows} = fixture({topK: 1});
    const snapshot = await lookup.snapshot();
    await lookup.duplicatePairs(snapshot);
    rows.pop();
    await expect(lookup.duplicatePairs(snapshot)).rejects.toThrow("Search evidence changed after the snapshot");
  });

  it.each(["account", "source", "revision", "citation", "fragment", "job"])("rejects invalid or mixed %s records", async change => {
    const {rows, lookup} = fixture();
    const metadata = JSON.parse(rows[0].metadata);
    if (change === "account") metadata.accountId = "another";
    if (change === "source") rows[0].sourceId = "another";
    if (change === "revision") rows[0].sourceContentHash = "another";
    if (change === "citation") metadata.sourceSpans.push({pageNumber: 1, sourceOffset: 0, sourceQuote: "Invented quotation"});
    if (change === "fragment") rows[0].content = rows[0].content.slice(0, 20);
    if (change === "job") metadata.evidenceJobId = "new-job";
    rows[0].metadata = JSON.stringify(metadata);
    if (change === "citation") rows[0].content = formatEvidenceContent(metadata);
    await expect(lookup.snapshot()).rejects.toThrow();
  });

  it("rejects missing pages, duplicate IDs and record limits instead of returning a partial snapshot", async () => {
    for (const kind of ["count", "duplicate", "limit"]) {
      const {lookup, search, rows, response} = fixture({maxRecords: kind === "limit" ? 2 : 10});
      if (kind === "count") search.mockResolvedValueOnce(response(rows.slice(0, 2), 3));
      if (kind === "duplicate") search.mockResolvedValueOnce(response([rows[0], rows[0]], 2));
      await expect(lookup.snapshot()).rejects.toThrow();
    }
  });

  it("rejects evidence changed during retrieval and an altered snapshot", async () => {
    const {lookup, search, response, rows} = fixture();
    const snapshot = await lookup.snapshot();
    search.mockImplementation(async () => response([{...rows[0], metadata: rows[0].metadata + " "}]));
    await expect(lookup.duplicatePairs(snapshot)).rejects.toThrow("changed");
    // Cached hit IDs must not bypass a failed final snapshot verification.
    await expect(lookup.duplicatePairs(snapshot)).rejects.toThrow("changed");
    snapshot.documents[0].metadata.what = "Changed assertion";
    await expect(lookup.duplicatePairs(snapshot)).rejects.toThrow("modified");
  });

  it("rejects IDs outside the snapshot before reviewing", async () => {
    const {lookup, search, response} = fixture();
    const snapshot = await lookup.snapshot();
    search.mockResolvedValue(response([{id: "foreign"} as IndexedEvidenceRecord]));
    await expect(lookup.duplicatePairs(snapshot)).rejects.toThrow("changed");
  });

  it("validates IDs restored from a durable cache against the current snapshot", async () => {
    const {source, search} = fixture();
    const lookup = new EvidenceSearchLookup({search} as any, "account", source, {},
      {get: async () => ["foreign"], put: vi.fn()});
    await expect(lookup.duplicatePairs(await lookup.snapshot())).rejects.toThrow("changed");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("rejects partial semantic responses instead of labeling them a complete semantic search", async () => {
    const {lookup, search, response, rows} = fixture({semanticConfiguration: "Primary"});
    const snapshot = await lookup.snapshot();
    search.mockResolvedValue({...response(rows), semanticErrorReason: "capacityOverloaded"} as any);
    await expect(lookup.duplicatePairs(snapshot)).rejects.toThrow("partial");
  });

  it("rejects a snapshot from a different account before sending any query text", async () => {
    const {lookup, source} = fixture();
    const snapshot = await lookup.snapshot();
    const search = vi.fn();
    const other = new EvidenceSearchLookup({search} as any, "another-account", source);
    await expect(other.duplicatePairs(snapshot)).rejects.toThrow("identity");
    expect(search).not.toHaveBeenCalled();
  });

  it("uses lexical search for missing vectors and reports that coverage", async () => {
    const {lookup, rows, search} = fixture();
    for (const row of rows) delete row.content_vector;
    await lookup.duplicatePairs(await lookup.snapshot());
    expect(lookup.stats.recordsWithoutVectors).toBe(3);
    for (const [, options] of search.mock.calls.filter(([query]) => query !== "*")) expect(options).not.toHaveProperty("vectorSearchOptions");
  });

  it("bounds queries and drains active failures instead of approving an incomplete review", async () => {
    const {lookup} = fixture({maxQueries: 1});
    await expect(lookup.duplicatePairs(await lookup.snapshot())).rejects.toThrow("budget exhausted");
    expect(lookup.stats.hybridQueries).toBe(1);
  });

  it("keeps scheduling within the concurrency bound while another lookup is slow", async () => {
    const {lookup, search, response, rows} = fixture({concurrency: 2});
    const snapshot = await lookup.snapshot();
    let release!: () => void, started = 0, active = 0, maximum = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    search.mockImplementation(async query => {
      if (query === "*") return response(rows, rows.length);
      const index = started++;
      maximum = Math.max(maximum, ++active);
      if (index === 0) await held;
      active--;
      return response(rows);
    });
    const operation = lookup.duplicatePairs(snapshot);
    try { await vi.waitFor(() => expect(started).toBe(3)); }
    finally { release(); }
    expect(await operation).toHaveLength(3);
    expect(maximum).toBe(2);
  });

  it("retains material differences even when Search retrieves identical-looking assertions", async () => {
    const {lookup, rows} = fixture();
    const original = JSON.parse(rows[0].metadata);
    const conflicting = {...original, what: "The company did not terminate Casey."};
    rows[1] = {...rows[1], content: formatEvidenceContent(conflicting), metadata: JSON.stringify(conflicting)};
    const snapshot = await lookup.snapshot();
    const pairs = findCanonicalizationPairs(snapshot.documents, {searchPairs: await lookup.duplicatePairs(snapshot), source: lookup.source});
    expect(pairs.some(pair => pair.id === "0:1")).toBe(false);
  });
});
