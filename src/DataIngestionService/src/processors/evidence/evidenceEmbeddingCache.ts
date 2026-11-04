import {createHash} from "node:crypto";
import {get_encoding} from "tiktoken";
import type {EvidenceCheckpointIdentity, EvidenceCheckpointStore, EvidenceCheckpointWriteGuard} from "./evidenceCheckpoint.js";
import {assertReconciliationActive} from "./evidenceReconciliationDeadline.js";
import {currentEvidenceTaskCancellation} from "./evidenceAsync.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const MAX_PARALLEL_BATCHES = 4;
export interface EvidenceEmbeddingModelIdentity {
  endpoint: string; deployment: string; model: string; apiVersion: string; dimensions: number;
  inputVersion: "strip-newlines-v1";
  epoch?: string;
}
export interface EvidenceEmbeddingCacheStats {
  inputCount: number; uniqueCount: number; cacheHitCount: number; generatedCount: number; requestCount: number; oversizedCount: number;
}
const validVector = (value: unknown, dimensions: number): value is number[] =>
  Array.isArray(value) && value.length === dimensions && value.every(n => typeof n === "number" && Number.isFinite(n))
    && value.some(n => n !== 0);

/** Cache is account/source scoped and invalidated by every embedding input or
 * model setting. It uses existing private checkpoints and their purge/expiry. */
export class EvidenceEmbeddingCache {
  private readonly identity: EvidenceCheckpointIdentity;
  private readonly recent = new Map<string, number[]>();
  private permits = MAX_PARALLEL_BATCHES;
  private readonly waiting: (() => void)[] = [];
  get fingerprint(): string {return this.identity.runFingerprint;}

  private async acquire(): Promise<void> {
    if (this.permits > 0) {this.permits--; return;}
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); else this.permits++;
  }
  constructor(accountId: string, sourceId: string, private readonly model: EvidenceEmbeddingModelIdentity,
    private readonly provider: {embedBatch(texts: string[]): Promise<number[][]>},
    private readonly store?: EvidenceCheckpointStore,
    private readonly report?: (stats: EvidenceEmbeddingCacheStats) => void) {
    this.identity = {accountId, sourceId, runFingerprint:hash(["embedding-cache-v1", model])};
  }

  async vectors(texts: readonly string[], guard?: EvidenceCheckpointWriteGuard): Promise<(number[] | null)[]> {
    const assertActive = () => {
      assertReconciliationActive();
      currentEvidenceTaskCancellation()?.signal.throwIfAborted();
      guard?.assertActive();
    };
    assertActive();
    const inputs = texts.map(text => text.replace(/\n/g, " "));
    const entries = new Map<string, {text: string; vector: number[] | null}>();
    // Each indexing chunk has at most 25 records. Bound storage I/O as well as
    // provider calls so durable reuse does not serialize one round trip per row.
    const unique = [...new Set(inputs)];
    for (const text of unique) entries.set(hash(text), {text, vector:null});
    for (let start = 0; start < unique.length; start += 16) await Promise.all(unique.slice(start, start + 16).map(async text => {
      const key = hash(text);
      let vector: number[] | null = this.recent.get(key) ?? null;
      if (!vector && this.store?.getStage && this.store.putStage) {
        const saved = await this.store.getStage(this.identity, 0, "embedding:" + key, guard?.abortSignal);
        if (saved && typeof saved === "object" && "inputHash" in saved && saved.inputHash === key
          && "vector" in saved && validVector(saved.vector, this.model.dimensions)
          && "vectorHash" in saved && saved.vectorHash === hash(saved.vector)) vector = saved.vector;
      }
      entries.get(key)!.vector = vector;
    }));
    const cacheHitCount = [...entries.values()].filter(entry => entry.vector !== null).length;
    let requestCount = 0;
    let generatedCount = 0;
    const encoder = get_encoding("cl100k_base");
    try {
      const pending = [...entries].filter(([, entry]) => entry.vector === null
        && encoder.encode(entry.text, [], []).length <= 8000);
      // Bound requests to 16 inputs / 128,000 tokens, with four batches in
      // flight per cache instance (including callers sharing this cache).
      let next = 0, failed = false;
      let failure: unknown;
      const fail = (error: unknown) => {if (!failed) {failed = true; failure = error;}};
      const worker = async () => {
        while (!failed && next < pending.length) {
          const batch = pending.slice(next, next + 16); next += 16;
          await this.acquire();
          try {
            if (failed) return;
            assertActive();
            const vectors = await this.provider.embedBatch(batch.map(([, entry]) => entry.text));
            assertActive();
            requestCount++;
            if (vectors.length !== batch.length || vectors.some(vector => !validVector(vector, this.model.dimensions)))
              throw new Error("Invalid evidence embedding response");
            // Drain every admitted request and cache write before returning
            // ownership; successful siblings remain reusable after a failure.
            const writes = await Promise.allSettled(batch.map(async ([key, entry], index) => {
              entry.vector = vectors[index];
              if (this.store?.getStage && this.store.putStage) await this.store.putStage(this.identity, 0, "embedding:" + key,
                {inputHash:key, vector:entry.vector, vectorHash:hash(entry.vector)}, guard);
              if (this.recent.size >= 256) this.recent.delete(this.recent.keys().next().value!);
              this.recent.set(key, entry.vector);
            }).map(write => write.catch(error => {fail(error); throw error;})));
            const rejected = writes.find(write => write.status === "rejected");
            if (rejected?.status === "rejected") throw rejected.reason;
            generatedCount += batch.length;
          } catch (error) {
            fail(error);
          } finally {this.release();}
        }
      };
      await Promise.all(Array.from({length: Math.min(MAX_PARALLEL_BATCHES, Math.ceil(pending.length / 16))}, worker));
      if (failed) throw failure;
    } finally { encoder.free(); }
    this.report?.({inputCount:texts.length, uniqueCount:entries.size, cacheHitCount, generatedCount, requestCount,
      oversizedCount:[...entries.values()].filter(entry => entry.vector === null).length});
    // Oversized records follow the existing deterministic split path.
    return inputs.map(text => entries.get(hash(text))!.vector);
  }
}
