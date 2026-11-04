import { createHash } from "node:crypto";
import type { SearchClient } from "@azure/search-documents";
import { Document } from "@langchain/core/documents";
import { formatEvidenceContent } from "./evidenceContent.js";
import { evidencePrimarySpan } from "./evidencePageIdentity.js";
import { EvidenceSource, type SourceSpan } from "./evidenceSource.js";
import type { RetrievedDuplicatePair } from "./evidenceDocumentDeduplication.js";

export interface IndexedEvidenceRecord {
  id: string;
  sourceId: string;
  sourceContentHash: string;
  evidenceKind: string;
  content: string;
  metadata: string;
  content_vector?: number[];
  pos?: number;
}
export interface IndexedEvidenceSnapshot {
  fingerprint: string;
  records: IndexedEvidenceRecord[];
  documents: Document[];
}
export interface EvidenceSearchQueryCache {
  get(key: string): Promise<unknown>;
  put(key: string, ids: readonly string[]): Promise<void>;
}
export interface EvidenceSearchLookupOptions {
  topK?: number;
  maxRecords?: number;
  maxQueries?: number;
  concurrency?: number;
  timeoutMs?: number;
  semanticConfiguration?: string;
  /** Explicit fallback for indexes whose stored vectors are not retrievable. */
  includeVectors?: boolean;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const literal = (value: string) => "'" + value.replace(/'/g, "''") + "'";
const fields: (keyof IndexedEvidenceRecord)[] = ["id", "sourceId", "sourceContentHash", "evidenceKind", "content", "metadata", "content_vector", "pos"];
const snapshotFingerprint = (records: IndexedEvidenceRecord[]) => digest(records.map(record => fields.map(field => record[field] ?? null)));

/** Read-only lookup, bound to an account's resolved index and one literal source
 * revision. The caller supplies the canonical source; lossy Search chunks are
 * never treated as a replacement for that quotation-validation source.
 */
export class EvidenceSearchLookup {
  readonly source: EvidenceSource;
  readonly stats = { snapshotQueries: 0, hybridQueries: 0, lexicalQueries: 0, cachedQueries: 0, recordsWithoutVectors: 0 };
  private readonly options: Required<Omit<EvidenceSearchLookupOptions, "semanticConfiguration">> & Pick<EvidenceSearchLookupOptions, "semanticConfiguration">;
  private readonly cache = new Map<string, Promise<string[]>>();
  private readonly filter: string;

  constructor(private readonly client: Pick<SearchClient<IndexedEvidenceRecord>, "search">
    & Partial<Pick<SearchClient<IndexedEvidenceRecord>, "endpoint" | "indexName">>,
    private readonly accountId: string, source: Document, options: EvidenceSearchLookupOptions = {},
    private readonly queryCache?: EvidenceSearchQueryCache) {
    if (!accountId.trim() || typeof source.metadata.sourceId !== "string" || !source.metadata.sourceId.trim())
      throw new Error("Search lookups require an account and source ID");
    this.source = new EvidenceSource(source);
    this.options = { topK: 8, maxRecords: 2000, maxQueries: 2000, concurrency: 4, timeoutMs: 30_000, includeVectors: true, ...options };
    for (const key of ["topK", "maxRecords", "maxQueries", "concurrency", "timeoutMs"] as const)
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1) throw new Error(`Invalid Search lookup ${key}`);
    if (this.options.topK > 50 || this.options.concurrency > 8) throw new Error("Search lookup limits exceed supported bounds");
    this.filter = `sourceId eq ${literal(source.metadata.sourceId)} and sourceContentHash eq ${literal(this.source.contentHash)} and evidenceKind ne null`;
  }

  private document(record: IndexedEvidenceRecord): Document {
    const metadata = JSON.parse(record.metadata);
    if (!record.id || !metadata || Array.isArray(metadata) || typeof metadata !== "object"
      || record.sourceId !== this.source.document.metadata.sourceId || record.sourceContentHash !== this.source.contentHash
      || metadata.accountId !== this.accountId || metadata.sourceId !== record.sourceId
      || metadata.sourceContentHash !== record.sourceContentHash || !evidencePrimarySpan(metadata))
      throw new Error("Search evidence identity or primary citation does not match this lookup");
    const kind = metadata.claimType ? "claim" : metadata.factType ? "fact" : metadata.tags?.includes("event") ? "event" : null;
    if (kind !== record.evidenceKind || !kind || record.content !== formatEvidenceContent(metadata))
      throw new Error("Search evidence is not a complete supported record; repair or re-ingest it first");
    for (const span of metadata.sourceSpans as SourceSpan[]) {
      const page = this.source.pages.find(page => page.pageNumber === span.pageNumber);
      if (!page || !Number.isSafeInteger(span.sourceOffset) || span.sourceOffset < 0 || !span.sourceQuote
        || page.text.slice(span.sourceOffset, span.sourceOffset + span.sourceQuote.length) !== span.sourceQuote)
        throw new Error("Search evidence quotation does not match the canonical source");
    }
    return new Document({ id: record.id, pageContent: record.content, metadata });
  }

  /** Enumerate every matching record, including all SDK continuation pages. */
  async snapshot(): Promise<IndexedEvidenceSnapshot> {
    this.stats.snapshotQueries++;
    const result = await this.client.search("*", { filter: this.filter,
      select: fields.filter(field => this.options.includeVectors || field !== "content_vector"), includeTotalCount: true,
      // A stable enumeration order avoids equal-score pagination omissions.
      // pos is only a paging key, never evidence of the original text order.
      orderBy: ["pos asc"],
      abortSignal: AbortSignal.timeout(this.options.timeoutMs) });
    const rows = new Map<string, IndexedEvidenceRecord>();
    for await (const {document} of result.results) {
      if (rows.has(document.id)) throw new Error("Search returned a duplicate record while paging; retry a stable source");
      rows.set(document.id, document);
      if (rows.size > this.options.maxRecords) throw new Error("Search evidence exceeds maxRecords; partial reviews are not complete reviews");
    }
    if (result.count !== undefined && result.count !== rows.size) throw new Error("Search evidence count changed while paging");
    const records = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
    const documents = records.map(record => this.document(record));
    const jobs = new Set(documents.map(document => document.metadata.evidenceJobId ?? "legacy"));
    if (jobs.size > 1) throw new Error("Search evidence contains multiple ingestion jobs; wait for a stable source");
    const dimensions = new Set(records.flatMap(record => record.content_vector?.length ? [record.content_vector.length] : []));
    if (dimensions.size > 1) throw new Error("Search evidence vectors have inconsistent dimensions");
    if (records.some(record => record.content_vector?.some(value => !Number.isFinite(value))))
      throw new Error("Search evidence has invalid vectors");
    this.stats.recordsWithoutVectors = records.filter(record => !record.content_vector?.some(value => value !== 0)).length;
    return { fingerprint: snapshotFingerprint(records), records, documents };
  }

  private async neighbors(snapshot: IndexedEvidenceSnapshot, index: number): Promise<string[]> {
    const record = snapshot.records[index], doc = snapshot.documents[index];
    const page = evidencePrimarySpan(doc.metadata)!.pageNumber;
    const vector = this.options.includeVectors && record.content_vector?.some(value => value !== 0) ? record.content_vector : undefined;
    // Identical requests can be shared across records as well as retries. Keep
    // the page and actual vector in the key so distinct occurrences stay scoped.
    const key = digest(["search-neighbors-v1", this.client.endpoint, this.client.indexName, snapshot.fingerprint, page, doc.metadata.what, vector,
      this.options.topK, this.options.semanticConfiguration, "global", "fail"]);
    const cached = this.cache.get(key);
    if (cached) { this.stats.cachedQueries++; return cached; }
    const validate = (ids: unknown): string[] => {
      if (!Array.isArray(ids) || ids.length > this.options.topK + 1 || ids.some(id => typeof id !== "string" || !id)
        || new Set(ids).size !== ids.length) throw new Error("Invalid saved Search hit IDs");
      return ids;
    };
    const query = (async () => {
      const saved = this.queryCache ? await this.queryCache.get(key) : null;
      if (saved !== null) { this.stats.cachedQueries++; return validate(saved); }
      if (this.stats.hybridQueries + this.stats.lexicalQueries >= this.options.maxQueries)
        throw new Error("Search query budget exhausted; candidate coverage is incomplete");
      if (vector) this.stats.hybridQueries++;
      else this.stats.lexicalQueries++;
      const result = await this.client.search(String(doc.metadata.what), {
        filter: `${this.filter} and pages/any(p: p eq ${page})`, select: ["id"], top: this.options.topK + 1,
        searchFields: ["content"],
        scoringStatistics: "global", sessionId: key,
        ...(vector ? { vectorSearchOptions: { filterMode: "preFilter" as const, queries: [{kind: "vector" as const,
          vector, fields: ["content_vector"], kNearestNeighborsCount: Math.max(50, this.options.topK + 1)}] } } : {}),
        ...(this.options.semanticConfiguration ? {queryType: "semantic" as const,
          semanticSearchOptions: {configurationName: this.options.semanticConfiguration, errorMode: "fail" as const}} : {queryType: "simple" as const}),
        abortSignal: AbortSignal.timeout(this.options.timeoutMs),
      });
      if (this.options.semanticConfiguration && result.semanticErrorReason)
        throw new Error("Search semantic ranking returned partial results; candidate coverage is incomplete");
      const matches: string[] = [];
      for await (const {document} of result.results) matches.push(document.id);
      validate(matches);
      await this.queryCache?.put(key, matches);
      return matches;
    })();
    this.cache.set(key, query);
    try { return await query; }
    catch (error) { this.cache.delete(key); throw error; }
  }

  /** Search discovers leads only. Confirm each hit belongs to the unchanged
   * snapshot, then let the existing metadata and semantic guards review it.
   * Hits return IDs only; a final full snapshot check detects updates/deletions
   * without repeatedly transferring quotation text for every neighbor query.
   */
  async duplicatePairs(snapshot: IndexedEvidenceSnapshot): Promise<RetrievedDuplicatePair[]> {
    if (snapshot.fingerprint !== snapshotFingerprint(snapshot.records) || snapshot.documents.length !== snapshot.records.length
      || snapshot.documents.some((document, index) => document.id !== snapshot.records[index].id
        || document.pageContent !== snapshot.records[index].content
        || JSON.stringify(document.metadata) !== JSON.stringify(JSON.parse(snapshot.records[index].metadata))))
      throw new Error("Search evidence snapshot was modified");
    // A valid snapshot from another lookup must not send its evidence text to
    // this account's Search client. Revalidate the source binding before reads.
    for (const record of snapshot.records) this.document(record);
    const indices = new Map(snapshot.records.map((record, index) => [record.id, index]));
    const pairs = new Map<string, RetrievedDuplicatePair>();
    const eligible = snapshot.documents.map((document, index) => ({index, page: evidencePrimarySpan(document.metadata)!.pageNumber}));
    const pageCounts = new Map<number, number>();
    for (const {page} of eligible) pageCounts.set(page, (pageCounts.get(page) ?? 0) + 1);
    const pending = eligible.filter(row => pageCounts.get(row.page)! > 1);
    let next = 0, failed = false;
    let failure: unknown;
    const worker = async () => {
      while (!failed && next < pending.length) {
        const {index, page} = pending[next++];
        try {
          const hits = await this.neighbors(snapshot, index);
          let accepted = 0;
          for (const hit of hits) {
            const other = indices.get(hit);
            if (other === undefined)
              throw new Error("Search results changed after the evidence snapshot; retry before reviewing");
            if (other === index || evidencePrimarySpan(snapshot.documents[other].metadata)!.pageNumber !== page) continue;
            const leftIndex = Math.min(index, other), rightIndex = Math.max(index, other);
            pairs.set(`${leftIndex}:${rightIndex}`, {leftIndex, rightIndex});
            if (++accepted >= this.options.topK) break;
          }
        } catch (error) {
          if (!failed) { failed = true; failure = error; }
        }
      }
    };
    // Keep every worker busy across slow requests. On failure stop scheduling,
    // but drain all active reads before returning control to the caller.
    await Promise.all(Array.from({length: Math.min(this.options.concurrency, pending.length)}, worker));
    if (failed) throw failure;
    // Cached neighbor IDs can outlive the index state they came from, so every
    // review confirms the current full snapshot, not only calls that queried Search.
    if (pending.length && (await this.snapshot()).fingerprint !== snapshot.fingerprint)
      throw new Error("Search evidence changed after the snapshot; retry before reviewing");
    return [...pairs.values()].sort((a, b) => a.leftIndex - b.leftIndex || a.rightIndex - b.rightIndex);
  }
}
