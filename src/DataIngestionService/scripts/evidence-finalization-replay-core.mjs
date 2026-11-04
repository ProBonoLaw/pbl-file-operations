import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {Document} from "@langchain/core/documents";
import {EvidenceSource} from "../dist/src/processors/evidence/evidenceSource.js";
import {usdMicros} from "../dist/src/processors/evidence/evidenceCostBudget.js";
import {attachEvidenceLocations} from "../dist/src/processors/extractionPackage.js";

export const digest = value => createHash("sha256").update(value).digest("hex");
export const jsonDigest = value => digest(JSON.stringify(value));

/** Compare approved amounts in integer micros, matching the durable budget ledger. */
export function validateReplayBudget(manifest, selected) {
  const amounts = ["limitUsd", "reviewLimitUsd", "indexLimitUsd"].map(field => {
    const value = manifest[field];
    assert.ok(typeof value === "number" && Number.isFinite(value) && value > 0
      && /^\d+(?:\.\d{1,6})?$/.test(String(value)),
    `Replay ${field} must be a positive USD number with at most six decimal places`);
    return usdMicros(String(value));
  });
  const [limitMicros, reviewMicros, indexMicros] = amounts;
  const stageMicros = reviewMicros + indexMicros;
  assert.ok(Number.isSafeInteger(stageMicros), "Replay stage budget total is too large");
  assert.equal(stageMicros, limitMicros, "Replay stage limits must equal approval");
  assert.equal(selected.limitMicros, reviewMicros, "Replay spending limit changed");
  assert.equal(selected.fingerprint, manifest.budgetFingerprint, "Replay prices or budget changed");
}

/** Location mapping mutates its output; keep frozen review inputs reusable on failure. */
export function attachReplayLocations(documents, pkg) {
  return attachEvidenceLocations(documents.map(document => new Document(structuredClone(document))), pkg);
}

/** Match ingestion's lookup policy while forbidding a new extraction. */
export function createReplayExtractor(Extractor, request, checkpoints, embeddings) {
  const extractor = new Extractor(request.accountId, request.sourceId, undefined, checkpoints,
    undefined, "thorough", embeddings, request.isCurrentOrder ? async () => undefined : undefined);
  extractor.generateDocuments = async () => {throw new Error("Extraction is forbidden during finalization replay");};
  return extractor;
}

/** Observe an accepted upload before entering the worker's attempt accounting. */
export async function resumeReplayIndexing({work, jobId, checkOpen, signal, complete,
  timeoutMs = 60 * 60 * 1000, pollMs = 10_000, now = Date.now,
  pause = ms => delay(ms, undefined, {signal})}) {
  await checkOpen();
  const record = await work.get(jobId);
  assert.ok(record && ["extracted", "completed"].includes(record.status),
    "Receipt-wait recovery requires an extracted or completed replay job");
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    signal?.throwIfAborted();
    await checkOpen();
    const indexed = await work.indexResult(jobId);
    await checkOpen();
    signal?.throwIfAborted();
    if (indexed) return complete(indexed);
    await pause(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  throw new Error("Indexing receipt did not arrive before the recovery deadline; finalized output remains saved");
}

/** The caller pins the checksum outside the input. No extraction fallback exists. */
export function validateReplayInput(bytes, expected) {
  assert.equal(digest(bytes), expected.inputHash, "Replay input checksum changed");
  const input = JSON.parse(bytes.toString());
  for (const field of ["accountId", "sourceId", "sourceJobId", "sourceContentHash"])
    assert.equal(input[field], expected[field], `Replay ${field} changed`);
  assert.equal(input.version, 1);
  assert.notEqual(expected.jobId, input.sourceJobId, "A replay must not reopen the stopped job");
  const source = new EvidenceSource(new Document(input.source));
  assert.equal(source.contentHash, expected.sourceContentHash, "Replay source changed");
  assert.equal(String(source.document.metadata.sourceId), expected.sourceId);
  assert.ok(Array.isArray(input.documents) && input.documents.length === expected.documentCount,
    "Replay input is incomplete");
  const documents = input.documents.map(row => {
    assert.ok(row && typeof row.pageContent === "string" && row.metadata);
    for (const field of ["accountId", "sourceId", "sourceContentHash"])
      assert.equal(row.metadata[field], expected[field], `Replay document ${field} changed`);
    assert.ok(Array.isArray(row.metadata.sourceSpans) && row.metadata.sourceSpans.length,
      "Replay document lacks source citations");
    return new Document(row);
  });
  return {source, documents};
}

/** Private replay checkpoints survive ordinary ingestion cleanup and code updates.
 * Cancellable writes become visible only after the deadline scope publishes them.
 */
export class ReplayCheckpoints {
  constructor(storage, scope, assertActive, sharedStage = async () => null) {
    this.storage = storage; this.scope = scope; this.assertActive = assertActive; this.sharedStage = sharedStage;
    this.staged = new WeakMap();
  }
  key(identity, index, stage) {
    assert.equal(identity.accountId, this.scope.accountId); assert.equal(identity.sourceId, this.scope.sourceId);
    return `checkpoints/${jsonDigest([identity, index, stage ?? null])}.json`;
  }
  async get(identity, index) { return this.storage.read(this.key(identity, index)); }
  async put(identity, index, value) {
    this.assertActive(); await this.storage.write(this.key(identity, index), value); this.assertActive();
  }
  async getStage(identity, index, stage, signal) {
    signal?.throwIfAborted();
    const key = this.key(identity, index, stage);
    const local = signal && this.staged.get(signal);
    if (local?.has(key)) return local.get(key);
    const saved = await this.storage.read(key);
    if (saved === null) return this.sharedStage(identity, index, stage);
    if (saved.checkpointReferenceVersion !== 1) return saved;
    assert.ok(typeof saved.blob === "string" && saved.blob.startsWith(key + ".pending/"));
    const value = await this.storage.read(saved.blob);
    assert.ok(value !== null && jsonDigest(value) === saved.sha256, "Replay checkpoint checksum changed");
    return value;
  }
  async putStage(identity, index, stage, value, guard) {
    this.assertActive(); guard?.assertActive();
    const key = this.key(identity, index, stage);
    if (!guard) { await this.storage.write(key, value); this.assertActive(); return; }
    const blob = key + ".pending/" + randomUUID() + ".json";
    await this.storage.write(blob, value, guard.abortSignal);
    this.assertActive(); guard.assertActive();
    guard.deferPublication(key, async () => {
      this.assertActive();
      await this.storage.write(key, {checkpointReferenceVersion:1, blob, sha256:jsonDigest(value)});
    });
    let local = this.staged.get(guard.abortSignal);
    if (!local) { local = new Map(); this.staged.set(guard.abortSignal, local); }
    local.set(key, value);
  }
  async clearSource() { throw new Error("Replay checkpoints must be retained"); }
  async clearSourceWork() { throw new Error("Replay checkpoints must be retained"); }
  async clearAccount() { throw new Error("Replay checkpoints must be retained"); }
}

/** Execute the deployed canonicalization task protocol with durable results.
 * This dispatcher cannot submit gathering or extraction tasks.
 */
export function replayReviewDispatcher({storage, source, execute, checkOpen, track = () => {}}) {
  const sourceHash = jsonDigest(source.document);
  return {async result(task, document) {
    assert.equal(task.component, "canonicalization", "Replay cannot dispatch extraction");
    assert.equal(jsonDigest(document), sourceHash, "Replay task source changed");
    const key = `reviews/${jsonDigest([task, sourceHash])}.json`;
    await checkOpen();
    const saved = await storage.read(key);
    if (saved) {
      assert.equal(jsonDigest(saved.result), saved.resultHash, "Saved replay review changed");
      track("restored", task.batchId); return saved.result;
    }
    const result = await execute({...task, sourceArtifact:sourceHash}, source);
    await checkOpen();
    assert.ok(Array.isArray(result.decisions) && Array.isArray(result.failedPairIds));
    // Match ingestion: unresolved comparisons retain both evidence records.
    // Preserve their IDs for a later targeted repair without blocking indexing.
    await storage.write(key, {result, resultHash:jsonDigest(result)});
    track("completed", task.batchId); return result;
  }};
}
