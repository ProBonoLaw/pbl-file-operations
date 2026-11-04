import {createHash} from "node:crypto";
import type {SearchClient} from "@azure/search-documents";

export interface IndexedSourcePartition {
  id: string;
  sourceId: string;
  tags: string[];
  content: string;
  metadata: string;
  pos?: number;
  pages?: number[];
  contentOrigin?: string | null;
  content_vector?: number[];
}
export interface SourcePartitionSnapshot {
  scope: string;
  fingerprint: string;
  records: IndexedSourcePartition[];
}
/** A changing Search view is retryable while waiting for a just-uploaded source.
 * Reconciliation still rejects this error rather than accepting a partial corpus. */
export class SourcePartitionVisibilityError extends Error {
  constructor(message: string) {super(message); this.name = "SourcePartitionVisibilityError";}
}
/** Query-specific ranking metadata, never part of the indexed source snapshot. */
export interface SourcePartitionHit extends IndexedSourcePartition {
  searchScore?: number;
  rerankerScore?: number;
}
export interface SourcePartitionQuery {id: string; text: string; vector?: number[]}
interface Options {maxRecords?: number; maxQueries?: number; topK?: number; concurrency?: number; timeoutMs?: number; semanticConfiguration?: string}
type Client = Pick<SearchClient<IndexedSourcePartition>, "search"> & Partial<Pick<SearchClient<IndexedSourcePartition>, "endpoint" | "indexName">>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fields: (keyof IndexedSourcePartition)[] = ["id", "sourceId", "tags", "content", "metadata", "pos", "pages", "contentOrigin"];
const fingerprint = (scope: string, records: IndexedSourcePartition[]) => digest([scope, records.map(row => fields.map(field => row[field] ?? null))]);

/** The caller resolves the account's index. Untagged source partitions are
 * lookup context; they are not formatted evidence records or a lossless source
 * reconstruction. Preserve generated/extracted provenance and original text.
 */
export class SourcePartitionSearch {
  readonly filter: string;
  readonly configurationFingerprint: string;
  readonly stats = {snapshotQueries: 0, lexicalQueries: 0, hybridQueries: 0};
  private readonly scope: string;
  private readonly options: Required<Omit<Options, "semanticConfiguration">> & Pick<Options, "semanticConfiguration">;

  constructor(private readonly client: Client, private readonly accountId: string, private readonly sourceId: string, options: Options = {}) {
    if (!accountId.trim() || !sourceId.trim()) throw new Error("Source lookups require an account and source ID");
    this.filter = `sourceId eq '${sourceId.replace(/'/g, "''")}' and not tags/any()`;
    this.scope = digest([accountId, sourceId, client.endpoint, client.indexName]);
    this.options = {maxRecords: 2000, maxQueries: 100, topK: 8, concurrency: 4, timeoutMs: 30_000, ...options};
    for (const key of ["maxRecords", "maxQueries", "topK", "concurrency", "timeoutMs"] as const)
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1) throw new Error(`Invalid source lookup ${key}`);
    if (this.options.topK > 50 || this.options.concurrency > 8) throw new Error("Source lookup limits exceed supported bounds");
    this.configurationFingerprint = digest(this.options);
  }

  private validate(row: IndexedSourcePartition) {
    if (!row.id || row.sourceId !== this.sourceId || !Array.isArray(row.tags) || row.tags.length
      || typeof row.content !== "string") throw new Error("Search returned a tagged record or another source");
    const metadata = JSON.parse(row.metadata);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
      || metadata.accountId !== undefined && metadata.accountId !== this.accountId
      || metadata.sourceId !== undefined && metadata.sourceId !== this.sourceId)
      throw new Error("Source partition metadata belongs to another scope");
  }

  async snapshot(signal?: AbortSignal): Promise<SourcePartitionSnapshot> {
    this.stats.snapshotQueries++;
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const result = await this.client.search("*", {filter: this.filter, select: fields,
      includeTotalCount: true, orderBy: ["pos asc"], abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout});
    const rows = new Map<string, IndexedSourcePartition>();
    for await (const {document} of result.results) {
      this.validate(document);
      if (rows.has(document.id)) throw new SourcePartitionVisibilityError("Duplicate source partition while paging");
      rows.set(document.id, document);
      if (rows.size > this.options.maxRecords) throw new Error("Source partitions exceed maxRecords; snapshot is incomplete");
    }
    if (result.count !== undefined && result.count !== rows.size)
      throw new SourcePartitionVisibilityError(`Source partition count changed while paging (reported ${result.count}, read ${rows.size})`);
    // pos orders pagination only. Pairing/snapshots never infer source text order.
    const records = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
    return {scope: this.scope, fingerprint: fingerprint(this.scope, records), records};
  }

  async lookup(snapshot: SourcePartitionSnapshot, queries: readonly SourcePartitionQuery[]) {
    if (snapshot.scope !== this.scope || snapshot.fingerprint !== fingerprint(this.scope, snapshot.records))
      throw new Error("Source partition snapshot belongs to another scope or was modified");
    snapshot.records.forEach(row => this.validate(row));
    if (queries.length > this.options.maxQueries || new Set(queries.map(query => query.id)).size !== queries.length
      || queries.some(query => !query.id || !query.text?.trim() || query.vector && (!query.vector.length
        || !query.vector.every(Number.isFinite) || !query.vector.some(value => value !== 0))))
      throw new Error("Invalid source queries or query budget exceeded");
    const records = new Map(snapshot.records.map(row => [row.id, row]));
    const results: {id: string; hits: SourcePartitionHit[]}[] = new Array(queries.length);
    let next = 0, failed = false;
    let failure: unknown;
    const worker = async () => {
      while (!failed && next < queries.length) {
        const index = next++, query = queries[index];
        try {
          if (query.vector) this.stats.hybridQueries++; else this.stats.lexicalQueries++;
          const response = await this.client.search(query.text, {filter: this.filter, select: ["id"],
            top: this.options.topK, searchFields: ["content"], scoringStatistics: "global",
            sessionId: digest([snapshot.fingerprint, query.text, query.vector, this.options.semanticConfiguration]),
            ...(query.vector ? {vectorSearchOptions: {filterMode: "preFilter" as const,
              queries: [{kind: "vector" as const, vector: query.vector, fields: ["content_vector"], kNearestNeighborsCount: 50}]}} : {}),
            ...(this.options.semanticConfiguration ? {queryType: "semantic" as const, semanticSearchOptions: {
              configurationName: this.options.semanticConfiguration, errorMode: "fail" as const}} : {queryType: "simple" as const}),
            abortSignal: AbortSignal.timeout(this.options.timeoutMs)});
          if (response.semanticErrorReason) throw new Error("Source lookup returned partial semantic results");
          const hits: SourcePartitionHit[] = [], seen = new Set<string>();
          for await (const {document, score, rerankerScore} of response.results) {
            const row = records.get(document.id);
            if (!row || seen.has(row.id)) throw new Error("Source lookup returned unknown or duplicate hit IDs");
            seen.add(row.id);
            hits.push({...row,
              ...(typeof score === "number" && Number.isFinite(score) ? {searchScore: score} : {}),
              ...(typeof rerankerScore === "number" && Number.isFinite(rerankerScore) ? {rerankerScore} : {})});
          }
          results[index] = {id: query.id, hits};
        } catch (error) { if (!failed) { failed = true; failure = error; } }
      }
    };
    await Promise.all(Array.from({length: Math.min(queries.length, this.options.concurrency)}, worker));
    if (failed) throw failure;
    if (queries.length && (await this.snapshot()).fingerprint !== snapshot.fingerprint)
      throw new Error("Source partitions changed during lookup");
    return results;
  }
}
