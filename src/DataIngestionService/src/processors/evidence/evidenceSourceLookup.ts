import {createHash} from "node:crypto";
import {AsyncLocalStorage} from "node:async_hooks";
import type {EvidenceCheckpointStore, EvidenceCheckpointWriteGuard} from "./evidenceCheckpoint.js";
import {reconciliationCheckpointGuard} from "./evidenceReconciliationDeadline.js";
import type {DuplicateEmbeddingProvider} from "./evidenceDocumentDeduplication.js";
import type {EvidenceSource, SourceSpan} from "./evidenceSource.js";
import {locateSourcePartition, selectSourcePartitionHits, type SourceLookupCitation} from "./evidenceSourceRanking.js";
import {SourcePartitionSearch, SourcePartitionVisibilityError, type IndexedSourcePartition, type SourcePartitionHit, type SourcePartitionSnapshot} from "./sourcePartitionSearch.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface SourceContextRequest {pageNumber: number; query: string; purpose: "dates" | "attribution" | "review";
  citations?: readonly SourceLookupCitation[]}
export interface SourceContextResult {
  passages: (SourceSpan & {id: string; contentOrigin?: string})[];
  unverifiedContext?: {id: string; contentOrigin: string; pages: number[]; text: string}[];
}
export interface SourceLookupMeasurements {
  returnedHits: number; rerankedHits: number; missingRerankerScores: number; rerankerScoreSum: number;
  rerankerScoreMin?: number; rerankerScoreMax?: number;
  passageCount: number; unverifiedCount: number; contextCharacters: number;
  retainedHits: number; filteredHits: number; citationProtectedHits: number; minimumRerankerScore?: number;
}
export interface EvidenceSourceLookup {
  readonly fingerprint: string;
  search(request: SourceContextRequest, signal?: AbortSignal): Promise<SourceContextResult>;
  verify(): Promise<void>;
}
export type EvidenceSourceLookupFactory = (source: EvidenceSource) => Promise<EvidenceSourceLookup | undefined>;
export class EvidenceSourceLookupError extends Error {
  constructor(cause: unknown) {super("Source-context lookup failed; review must be retried after retrieval recovers", {cause});}
}

export function sourceLookupMode(): "local" | "hybrid" {
  const mode = process.env.EVIDENCE_SOURCE_LOOKUP_MODE?.trim() || "local";
  if (mode !== "local" && mode !== "hybrid") throw new Error("EVIDENCE_SOURCE_LOOKUP_MODE must be local or hybrid");
  return mode;
}

export const partitionManifestIdentity = (accountId: string, sourceId: string, contentHash: string) =>
  ({accountId, sourceId, runFingerprint: "source-partitions-v1-" + contentHash});
export const partitionIdsHash = (ids: string[]) => hash([...ids].sort());

/** Readiness describes the entire untagged corpus, never a narrower Search filter. */
export function validatePartitionManifest(snapshot: SourcePartitionSnapshot, manifest: unknown, source: EvidenceSource): void {
  const expected = manifest as {sourceContentHash?: unknown; count?: unknown; idsHash?: unknown; snapshotFingerprint?: unknown} | null;
  if (!expected || expected.sourceContentHash !== source.contentHash || expected.count !== snapshot.records.length
    || expected.idsHash !== partitionIdsHash(snapshot.records.map(row => row.id))
    || expected.snapshotFingerprint !== undefined && expected.snapshotFingerprint !== snapshot.fingerprint)
    throw new SourcePartitionVisibilityError("Source partitions are not fully visible for this document; ingestion must finish before reconciliation");
}

/** Queries use the complete untagged source corpus. Only verified original text
 * gets citation offsets; generated and unmappable content stays labelled context.
 */
export class SearchSourceContext implements EvidenceSourceLookup {
  readonly fingerprint: string;
  private readonly queryFingerprint: string;
  readonly stats = {requests: 0, cacheHits: 0, searchBatches: 0};
  private readonly cache = new Map<string, Promise<SourcePartitionHit[]>>();
  private readonly pending: {key: string; text: string; signal?: AbortSignal; guard?: EvidenceCheckpointWriteGuard;
    run: ReturnType<typeof AsyncLocalStorage.snapshot>;
    resolve: (hits: SourcePartitionHit[]) => void; reject: (error: unknown) => void}[] = [];
  private readonly cancelledLookups = new WeakSet<Promise<SourcePartitionHit[]>>();
  private scheduled = false;

  constructor(private readonly source: EvidenceSource, private readonly lookup: SourcePartitionSearch,
    private readonly snapshot: SourcePartitionSnapshot, private readonly accountId: string,
    private readonly embeddings: DuplicateEmbeddingProvider | undefined,
    modelIdentity: unknown, private readonly store?: EvidenceCheckpointStore,
    private readonly report?: (measurements: SourceLookupMeasurements) => void,
    private readonly minimumRerankerScore: number | null = null) {
    if (minimumRerankerScore !== null && (!Number.isFinite(minimumRerankerScore) || minimumRerankerScore < 0 || minimumRerankerScore > 4))
      throw new Error("Invalid minimum source reranker score");
    if (source.document.metadata.accountId && source.document.metadata.accountId !== accountId)
      throw new Error("Source context belongs to another account");
    if (!snapshot.records.length) throw new Error("No untagged source partitions are searchable");
    for (const row of snapshot.records) {
      const metadata = JSON.parse(row.metadata);
      if (row.sourceId !== source.document.metadata.sourceId || metadata.accountId && metadata.accountId !== accountId)
        throw new Error("Source context belongs to another account or source");
      if (metadata.sourceContentHash && metadata.sourceContentHash !== source.contentHash)
        throw new Error("Indexed source partitions belong to another document revision");
    }
    this.queryFingerprint = hash(["source-context-v2", source.contentHash, snapshot.fingerprint, modelIdentity,
      embeddings ? "hybrid" : "lexical", lookup.configurationFingerprint]);
    this.fingerprint = hash([this.queryFingerprint, "citation-protected-cutoff-v1", minimumRerankerScore]);
  }

  async verify(): Promise<void> {
    if ((await this.lookup.snapshot()).fingerprint !== this.snapshot.fingerprint)
      throw new Error("Source partitions changed during reconciliation");
  }

  async search(request: SourceContextRequest, signal?: AbortSignal): Promise<SourceContextResult> {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(request.pageNumber) || request.pageNumber < 0 || !request.query.trim()
      || request.query.length > 4000 || !["dates", "attribution", "review"].includes(request.purpose))
      throw new Error("Invalid source-context query");
    this.stats.requests++;
    // Purpose changes retrieval language, but page number never restricts Search.
    const text = request.query.trim() + (request.purpose === "dates" ? " dates" : request.purpose === "attribution" ? " author speaker" : "");
    const key = hash([this.queryFingerprint, text]);
    let hits = this.cache.get(key);
    const owner = !hits;
    if (hits) this.stats.cacheHits++;
    else {
      hits = new Promise<SourcePartitionHit[]>((resolve, reject) => this.pending.push({key, text, signal,
        guard: reconciliationCheckpointGuard(), run: AsyncLocalStorage.snapshot(), resolve, reject}));
      if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, hits);
      if (!this.scheduled) { this.scheduled = true; queueMicrotask(() => { void this.flush(); }); }
    }
    try {
      const rows = await hits;
      signal?.throwIfAborted();
      const selected = selectSourcePartitionHits(this.source, rows, this.minimumRerankerScore, request.citations);
      const context = sourcePartitionPassages(this.source, selected.hits, request.query);
      const scores = rows.flatMap(row => row.rerankerScore === undefined ? [] : [row.rerankerScore]);
      this.report?.({returnedHits: rows.length, rerankedHits: scores.length, missingRerankerScores: rows.length - scores.length,
        rerankerScoreSum: scores.reduce((sum, score) => sum + score, 0),
        retainedHits: selected.hits.length, filteredHits: rows.length - selected.hits.length, citationProtectedHits: selected.protectedHits,
        ...(this.minimumRerankerScore === null ? {} : {minimumRerankerScore: this.minimumRerankerScore}),
        ...(scores.length ? {rerankerScoreMin: Math.min(...scores), rerankerScoreMax: Math.max(...scores)} : {}),
        passageCount: context.passages.length, unverifiedCount: context.unverifiedContext?.length ?? 0,
        contextCharacters: context.passages.reduce((sum, span) => sum + span.sourceQuote.length, 0)
          + (context.unverifiedContext ?? []).reduce((sum, span) => sum + span.text.length, 0)});
      return context;
    } catch (error) {
      if (this.cache.get(key) === hits) this.cache.delete(key);
      // The lookup was shared with a caller that was cancelled; this caller was not.
      if (!owner && hits && this.cancelledLookups.has(hits) && !signal?.aborted) return this.search(request, signal);
      throw error;
    }
  }

  /** Cancellation is per request: a stopped item is rejected alone while the
   * batch keeps serving callers that share its drain.
   */
  private cancelled(item: (typeof this.pending)[number]): boolean {
    try { item.run(() => {item.signal?.throwIfAborted(); item.guard?.assertActive();}); return false; }
    catch (error) {
      const lookup = this.cache.get(item.key);
      if (lookup) this.cancelledLookups.add(lookup);
      this.cache.delete(item.key);
      item.reject(error);
      return true;
    }
  }

  private async flush(): Promise<void> {
    // One drain batches concurrent requests from independent review tools. The
    // existing embedding cache batches unique inputs and persists query vectors.
    while (this.pending.length) {
      const batch = this.pending.splice(0, 32).filter(item => !this.cancelled(item));
      if (!batch.length) continue;
      const dropped = new Set<(typeof batch)[number]>();
      const active = (item: (typeof batch)[number]) => {
        if (dropped.has(item)) return false;
        if (!this.cancelled(item)) return true;
        dropped.add(item);
        return false;
      };
      const identity = {accountId: this.accountId, sourceId: String(this.source.document.metadata.sourceId), runFingerprint: this.queryFingerprint};
      try {
        const available = new Map(this.snapshot.records.map(row => [row.id, row]));
        const saved = await Promise.all(batch.map(item => item.run(async () => {
          let value: unknown;
          try { value = await this.store?.getStage?.(identity, 0, "source-query:" + item.key, item.signal); }
          catch (error) { if (!active(item)) return null; throw error; }
          if (!active(item) || !value) return null;
          const entry = value as {version: number; hits: Pick<SourcePartitionHit, "id" | "searchScore" | "rerankerScore">[]; hash: string};
          if (entry.version !== 2 || !Array.isArray(entry.hits) || entry.hits.length > 50
            || entry.hits.some(hit => !hit || typeof hit.id !== "string" || !available.has(hit.id)
              || Object.keys(hit).some(key => !["id", "searchScore", "rerankerScore"].includes(key))
              || [hit.searchScore, hit.rerankerScore].some(score => score !== undefined && (typeof score !== "number" || !Number.isFinite(score))))
            || new Set(entry.hits.map(hit => hit.id)).size !== entry.hits.length || entry.hash !== hash(entry.hits))
            throw new Error("Invalid cached source lookup");
          this.stats.cacheHits++;
          return entry.hits.map(hit => ({...available.get(hit.id)!, ...hit}));
        })));
        let missing = batch.filter((item, index) => saved[index] === null && active(item));
        let vectors: (number[] | null)[] | undefined;
        while (this.embeddings && missing.length) {
          const owner = missing[0];
          try {
            // The drain may belong to an expired review. Run shared embedding
            // work in an active caller's scope, including its checkpoint guard.
            vectors = await owner.run(() => this.embeddings!.vectors(missing.map(item => item.text)));
            break;
          } catch (error) {
            missing = missing.filter(active);
            if (!dropped.has(owner)) throw error;
            // Only an expired owner warrants retry; provider failures still stop
            // review. Each retry removes that owner and preserves active waiters.
          }
        }
        if (vectors && (vectors.length !== missing.length || vectors.some(vector => vector === null)))
          throw new Error("Hybrid source lookups require a query vector for every query");
        const queries = missing.flatMap((item, index) => active(item)
          ? [{id: item.key, text: item.text, ...(vectors ? {vector: vectors[index]!} : {})}] : []);
        const found = queries.length ? await this.lookup.lookup(this.snapshot, queries) : [];
        if (!queries.length) await this.verify();
        if (queries.length) this.stats.searchBatches++;
        const results = new Map(found.map(result => [result.id, result.hits]));
        // Drain all checkpoint writes before resolving any tools or releasing an
        // error to the caller; a retry cannot race abandoned cache writes.
        const writes = await Promise.allSettled(found.map(async result => {
          const item = batch.find(item => item.key === result.id)!;
          if (!active(item)) return;
          const hits = result.hits.map(({id, searchScore, rerankerScore}) => ({id,
            ...(searchScore === undefined ? {} : {searchScore}), ...(rerankerScore === undefined ? {} : {rerankerScore})}));
          try { await item.run(() => this.store?.putStage?.(identity, 0, "source-query:" + result.id,
            {version: 2, hits, hash: hash(hits)}, item.guard)); }
          catch (error) { if (active(item)) throw error; }
        }));
        const failure = writes.find(write => write.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        batch.forEach((item, index) => { if (active(item)) item.resolve(saved[index] ?? results.get(item.key)!); });
      } catch (error) { batch.forEach(item => { if (!active(item)) return; this.cache.delete(item.key); item.reject(error); }); }
    }
    this.scheduled = false;
  }
}

export function sourcePartitionPassages(source: EvidenceSource, hits: IndexedSourcePartition[], query: string): SourceContextResult {
  const passages: SourceContextResult["passages"] = [], unverifiedContext: NonNullable<SourceContextResult["unverifiedContext"]> = [];
  const seen = new Set<string>(), terms = new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  for (const hit of hits) {
    const located = locateSourcePartition(source, hit);
    const score = (span: SourceSpan) => (span.sourceQuote.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(term => terms.has(term)).length;
    located.sort((a, b) => score(b) - score(a) || a.pageNumber - b.pageNumber || a.sourceOffset - b.sourceOffset);
    const span = located.find(span => !seen.has(`${span.pageNumber}:${span.sourceOffset}`));
    if (span && passages.length < 4) {
      seen.add(`${span.pageNumber}:${span.sourceOffset}`);
      passages.push({...span, id: hit.id, contentOrigin: "extracted"});
    } else if (!located.length && unverifiedContext.length < 2) unverifiedContext.push({id: hit.id,
      contentOrigin: hit.contentOrigin ?? "unknown", pages: hit.pages ?? [], text: hit.content.slice(0, 1100)});
  }
  return {passages, ...(unverifiedContext.length ? {unverifiedContext} : {})};
}
