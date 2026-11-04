import { createHash } from "node:crypto";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { QueueServiceClient } from "@azure/storage-queue";
import { createBlobServiceClient, createQueueServiceClient } from "../../storage.js";
import type { RequestContext } from "../../requestContext.js";
import { withEvidenceTaskOwnership, withEvidenceTaskCancellation, EvidenceReviewPending,
  type EvidenceReviewDispatcher, type EvidenceReviewTask } from "./evidenceAsync.js";
import { positiveIntegerSetting } from "./evidenceRetryPolicy.js";
import { budgetErrorCode, EvidenceBudgetError, evidenceCostBudget, selectedEvidenceBudget } from "./evidenceCostBudget.js";
import { isEvidenceContentFilter } from "./evidenceContentFilter.js";
import { isEvidenceUnresolvedError } from "./evidenceUnresolvedError.js";
import { EvidenceGatheringOutputLimitError, EvidenceGatheringPartitionScheduledError } from "./evidenceGathering.js";

export type EvidenceTaskLane = "gather" | "reconcile" | "review" | "repair" | "finalize";
export type EvidenceTaskDefinition = {
  lane: EvidenceTaskLane; payload: unknown; correlation: RequestContext;
  maxAttempts: number; allowFailover: boolean;
};
export interface EvidenceTaskRecord {
  id: string; definition: EvidenceTaskDefinition; lane: EvidenceTaskLane;
  status: "pending" | "completed" | "failed"; attempts: number;
  createdAt: number; updatedAt: number; availableAt: number; dispatchedAt: number;
  result?: unknown; resultHash?: string; error?: string; poisonSent?: boolean;
}
export interface EvidenceTaskStore {
  create(record: EvidenceTaskRecord): Promise<void>;
  get(id: string): Promise<EvidenceTaskRecord | null>;
  withLease(id: string, run: (record: EvidenceTaskRecord, save: () => Promise<void>, assertOwned: () => void) => Promise<void>): Promise<boolean>;
  list(lane?: EvidenceTaskLane, pendingOnly?: boolean): AsyncIterable<EvidenceTaskRecord>;
  putArtifact(id: string, value: unknown): Promise<void>;
  artifact(id: string): Promise<unknown>;
  stopJob(correlation: RequestContext, reason: string): Promise<void>;
  isJobStopped(correlation: RequestContext): Promise<boolean>;
}
export interface EvidenceTaskTransport {
  send(lane: EvidenceTaskLane | "poison", id: string): Promise<void>;
}
export const evidenceTaskHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class EvidenceTaskFailed extends Error {
  constructor(readonly taskId: string) { super(`Evidence review task ${taskId} exhausted its retry budget`); this.name = "EvidenceTaskFailed"; }
}
export class EvidenceJobStopped extends Error {
  constructor() { super("Evidence job was stopped after a terminal task failure"); this.name = "EvidenceJobStopped"; }
}
export function isEvidenceJobStopped(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    if (current instanceof EvidenceJobStopped) return true;
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
/** Handler knows the durable job retry budget, which can differ from component budgets. */
export class EvidenceTaskRetry extends Error {
  constructor(readonly terminal: boolean, cause: unknown) { super("Evidence task attempt failed", {cause}); }
}
const validId = (id: string): string => {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid evidence task ID");
  return id;
};
const jobKey = (correlation: RequestContext): string => {
  if (!correlation.accountId || !correlation.sourceId || !correlation.jobId)
    throw new Error("Evidence task requires account, source, and job identity");
  return createHash("sha256").update(JSON.stringify([correlation.accountId,correlation.sourceId,correlation.jobId])).digest("hex");
};
const canFailover = (record: EvidenceTaskRecord, lane: EvidenceTaskLane): boolean =>
  record.definition.allowFailover && (lane === "review" || (lane === "gather"
    && (record.definition.payload as Partial<EvidenceReviewTask> | null)?.component === "fast-window"));
const invalidGatheringSchema = (error: unknown): boolean => error instanceof Error && (
  (error.name === "EvidenceStructuredResponseError" && (error as Error & {reason?: string}).reason === "invalid")
  || (error.message.includes("Failed to parse structured output for tool")
    && error.message.includes("Model output did not satisfy the provided response schema")));
const failedGatheringUnitRetired = (record: EvidenceTaskRecord, lane: EvidenceTaskLane): boolean =>
  (lane === "gather" || lane === "repair")
  && (record.error === "evidence_structured_invalid" || record.error === "evidence_output_limit")
  && (record.definition.payload as Partial<EvidenceReviewTask> | null)?.component === "gathering-unit"
  && record.attempts >= Math.min(3, record.definition.maxAttempts);

function redispatchIntervalMs(): number {
  const value = positiveIntegerSetting("EVIDENCE_TASK_REDISPATCH_MS", 900_000);
  if (value < 60_000 || value > 86_400_000)
    throw new Error("EVIDENCE_TASK_REDISPATCH_MS must be between 60000 and 86400000");
  return value;
}

/** The blob manifest is the authority. Queues are recoverable wake-up notifications. */
export class EvidenceTaskQueue {
  private readonly redispatchMs: number;
  constructor(readonly store: EvidenceTaskStore, readonly transport: EvidenceTaskTransport,
    private readonly observe: (name: string, task: EvidenceTaskRecord) => void = () => undefined,
    private readonly now: () => number = Date.now) {
    this.redispatchMs = redispatchIntervalMs();
  }

  async submit(definition: EvidenceTaskDefinition): Promise<string> {
    if (!Number.isInteger(definition.maxAttempts) || definition.maxAttempts < 1) throw new Error("Invalid evidence task retry budget");
    const id = evidenceTaskHash(definition);
    const now = this.now();
    const stopped = definition.lane !== "finalize" && await this.store.isJobStopped(definition.correlation);
    const record: EvidenceTaskRecord = { id, definition, lane: definition.lane, status: stopped ? "failed" : "pending", attempts: 0,
      createdAt: now, updatedAt: now, availableAt: now, dispatchedAt: 0 };
    if (stopped) record.error = "evidence_job_stopped";
    await this.store.create(record);
    try { await this.dispatch(id); }
    catch {
      // The manifest is already durable. A failed wake-up must not make the
      // Event Hub bridge publish failure while outbox recovery can still run it.
      this.observe("EvidenceTaskDispatchDeferred", record);
    }
    return id;
  }

  private async dispatch(id: string): Promise<void> {
    await this.store.withLease(id, async (record, save) => {
      if (record.status === "completed") return;
      if (record.status === "failed") {
        if (!record.poisonSent) {
          await this.transport.send("poison", id);
          record.poisonSent = true;
          record.updatedAt = this.now();
          await save();
        }
        return;
      }
      // A successfully sent notification already waits in Queue Storage. Recovery
      // should not append another copy every minute while model units wait their turn.
      // State transitions reset dispatchedAt, so normal retries keep their own backoff.
      if (record.availableAt > this.now() || record.dispatchedAt > this.now() - this.redispatchMs) return;
      // Save after send: a crash can duplicate a notification, never lose the task.
      await this.transport.send(record.lane, id);
      record.dispatchedAt = this.now();
      await save();
      this.observe("EvidenceTaskQueued", record);
    });
  }

  /** Repairs a crash between manifest creation/state transition and Queue send. */
  async recover(lane?: EvidenceTaskLane): Promise<void> {
    const jobs = new Map<string, string[]>();
    for await (const record of this.store.list(lane, true)) {
      if (record.status === "completed" || lane && record.lane !== lane) continue;
      if (record.status === "failed") { await this.dispatch(record.id); continue; }
      if (record.availableAt > this.now() || record.dispatchedAt > this.now() - this.redispatchMs) continue;
      const {accountId, sourceId, jobId} = record.definition.correlation;
      const key = JSON.stringify([accountId, sourceId, jobId]);
      const ids = jobs.get(key) ?? [];
      ids.push(record.id);
      jobs.set(key, ids);
    }
    // A large document must not put every recovered unit ahead of another source.
    const groups = [...jobs.values()].sort((a, b) => a.length - b.length);
    for (let index = 0; groups.some(ids => index < ids.length); index++)
      for (const ids of groups) if (index < ids.length) await this.dispatch(ids[index]);
  }

  private async exhaustAttempts(record: EvidenceTaskRecord, lane: EvidenceTaskLane,
    terminal: (record: EvidenceTaskRecord) => Promise<{result: unknown} | void>,
    save: () => Promise<void>, assertOwned: () => void): Promise<boolean> {
    if (canFailover(record, lane)) {
      record.lane = "repair";
      record.attempts = 0;
      record.availableAt = this.now();
      record.dispatchedAt = 0;
      await save();
      this.observe("EvidenceTaskFailover", record);
      return true;
    }
    const recovered = await terminal(record);
    assertOwned();
    record.status = recovered ? "completed" : "failed";
    if (recovered) { record.result = recovered.result; record.resultHash = evidenceTaskHash(recovered.result); }
    else await this.store.stopJob(record.definition.correlation, `terminal ${lane} task ${record.id}`);
    record.updatedAt = this.now();
    await save();
    this.observe(record.status === "completed" ? "EvidenceTaskCompleted" : "EvidenceTaskFailed", record);
    return true;
  }

  private handleExecutionErrorFailover(record: EvidenceTaskRecord, retryAfterMs: number): void {
    record.lane = "repair";
    record.attempts = 0;
    record.availableAt = this.now() + retryAfterMs;
    this.observe("EvidenceTaskFailover", record);
  }

  private handleExecutionErrorRetryScheduled(record: EvidenceTaskRecord): void {
    // The extraction job owns its page-based durable attempt budget.
    record.attempts = 0;
    record.availableAt = this.now() + 30_000;
    this.observe("EvidenceTaskRetryScheduled", record);
  }

  private async handleExecutionErrorExhausted(record: EvidenceTaskRecord,
    terminal: (record: EvidenceTaskRecord) => Promise<{result: unknown} | void>,
    save: () => Promise<void>, assertOwned: () => void, exhaustBudget = true): Promise<void> {
    // Persist the terminal decision before side effects; recovery retries its notification only.
    if (exhaustBudget) record.attempts = record.definition.maxAttempts;
    await save();
    const recovered = await terminal(record);
    assertOwned();
    record.status = recovered ? "completed" : "failed";
    if (recovered) { record.result = recovered.result; record.resultHash = evidenceTaskHash(recovered.result); }
    else this.observe("EvidenceTaskFailed", record);
  }

  private handleExecutionErrorBackoff(record: EvidenceTaskRecord, retryAfterMs: number): void {
    record.availableAt = this.now() + Math.max(Math.min(60_000, 5000 * 2 ** (record.attempts - 1)),
      retryAfterMs);
    this.observe("EvidenceTaskRetryScheduled", record);
  }

  private async handleExecutionError(error: unknown, record: EvidenceTaskRecord, lane: EvidenceTaskLane,
    terminal: (record: EvidenceTaskRecord) => Promise<{result: unknown} | void>,
    save: () => Promise<void>, assertOwned: () => void): Promise<void> {
    if (isEvidenceJobStopped(error)) {
      record.error = "evidence_job_stopped";
      // A sibling can stop the job after the pre-delivery check. The active
      // finalizer still owns terminal notification (or indexed-result recovery).
      // Persist that phase before notifying so delivery failure retries cleanup,
      // never extraction, and cannot leave ingestion waiting without a status.
      if (lane === "finalize") await this.handleExecutionErrorExhausted(record, terminal, save, assertOwned);
      else record.status = "failed";
      if (record.status === "failed") this.observe("EvidenceTaskJobStopped",record);
      return;
    }
    const costError=budgetErrorCode(error);
    if(costError) {
      record.error=costError;
      if(costError==="evidence_budget_busy"||costError==="evidence_budget_unavailable") {
        record.attempts--;
        record.availableAt=this.now()+15_000;
        this.observe("EvidenceTaskBudgetWaiting",record);
      } else {
        // This is an operator spending stop, not a model failure eligible for
        // escalation. Keep checkpoints/input and do not publish cleanup.
        record.status="failed";
        this.observe("EvidenceTaskBudgetStopped",record);
      }
      return;
    }
    if (error instanceof EvidenceReviewPending) {
      record.attempts--; // Waiting on dependencies is not a failed model attempt.
      record.availableAt = this.now() + 15_000;
      this.observe("EvidenceTaskWaiting", record);
      return;
    }
    if ((lane === "gather" || lane === "repair")
      && (record.definition.payload as Partial<EvidenceReviewTask> | null)?.component === "gathering-unit"
      && error instanceof EvidenceGatheringOutputLimitError) {
      if (error instanceof EvidenceGatheringPartitionScheduledError) {
        // The partition checkpoint is durable; the next attempt dispatches children.
        record.error = "evidence_output_limit_partitioned";
        record.availableAt = this.now();
        this.observe("EvidenceTaskRetryScheduled", record);
      } else if (lane === "gather" && record.definition.allowFailover) {
        record.error = "evidence_output_limit";
        this.handleExecutionErrorFailover(record, 0);
      } else if (record.attempts >= Math.min(3, record.definition.maxAttempts)) {
        record.error = "evidence_output_limit";
        await this.handleExecutionErrorExhausted(record, terminal, save, assertOwned, false);
      } else {
        record.error = "evidence_output_limit";
        this.handleExecutionErrorBackoff(record, 0);
      }
      return;
    }
    if (isEvidenceContentFilter(error)) {
      record.error = "content_filter";
      if (lane === "gather" && (canFailover(record, lane) || record.definition.allowFailover
        && (record.definition.payload as Partial<EvidenceReviewTask> | null)?.component === "gathering-unit")) {
        this.handleExecutionErrorFailover(record, 0);
      } else if (lane === "repair" && (record.definition.payload as Partial<EvidenceReviewTask> | null)?.component === "gathering-unit") {
        await this.handleExecutionErrorExhausted(record, terminal, save, assertOwned);
      } else {
        // A second attempt with the same filtered input cannot recover this task.
        record.status = "failed";
        this.observe("EvidenceTaskContentFiltered", record);
      }
      return;
    }
    if (isEvidenceUnresolvedError(error)) {
      record.error = "evidence_unresolved";
      if (canFailover(record, lane)) this.handleExecutionErrorFailover(record, 0);
      else {
        record.status = "failed";
        this.observe("EvidenceTaskUnresolved", record);
      }
      return;
    }
    if ((lane === "gather" || lane === "repair")
      && (record.definition.payload as Partial<EvidenceReviewTask> | null)?.component === "gathering-unit"
      && invalidGatheringSchema(error)) {
      record.error = "evidence_structured_invalid";
      if (record.attempts >= Math.min(3, record.definition.maxAttempts)) {
        // Repeating the same malformed response many times wastes tokens and
        // must not stop the other source units after the bounded checks fail.
        await this.handleExecutionErrorExhausted(record, terminal, save, assertOwned, false);
      } else this.handleExecutionErrorBackoff(record,0);
      return;
    }
    record.error = error instanceof Error ? error.name : "UnknownError";
    const requestedDelay = (error as {retryAfterMs?: unknown} | null)?.retryAfterMs;
    const retryAfterMs = typeof requestedDelay === "number" && Number.isFinite(requestedDelay) ? Math.max(0,requestedDelay) : 0;
    const isDurableRetry = error instanceof EvidenceTaskRetry && !error.terminal;
    const isTerminalRetry = error instanceof EvidenceTaskRetry && error.terminal;
    const exhausted = record.attempts >= record.definition.maxAttempts;
    if (canFailover(record, lane) && (lane === "review" || exhausted)) {
      record.lane = "repair";
      record.attempts = 0;
      record.availableAt = this.now() + retryAfterMs;
      this.observe("EvidenceTaskFailover", record);
    } else if (isDurableRetry) {
      // The extraction job owns its page-based durable attempt budget.
      record.attempts = 0;
      record.availableAt = this.now() + 30_000;
      this.observe("EvidenceTaskRetryScheduled", record);
    } else if (isTerminalRetry || exhausted) {
      await this.handleExecutionErrorExhausted(record, terminal, save, assertOwned);
    } else {
      this.handleExecutionErrorBackoff(record, retryAfterMs);
    }
  }

  private async attemptExecution(record: EvidenceTaskRecord, lane: EvidenceTaskLane,
    execute: (record: EvidenceTaskRecord) => Promise<unknown>,
    terminal: (record: EvidenceTaskRecord) => Promise<{result: unknown} | void>,
    save: () => Promise<void>, assertOwned: () => void): Promise<void> {
    record.attempts++;
    record.updatedAt = this.now();
    await save(); // A killed worker consumes a persisted attempt.
    this.observe("EvidenceTaskStarted", record);
    try {
      if(selectedEvidenceBudget(record.definition.correlation))
        await evidenceCostBudget().assertOpen(record.definition.correlation);
      const result = await this.runUnlessStopped(record, () => withEvidenceTaskOwnership(assertOwned, () => execute(record)));
      assertOwned();
      record.result = result;
      record.resultHash = evidenceTaskHash(result);
      record.status = "completed";
      record.error = undefined;
    } catch (error) {
      assertOwned();
      await this.handleExecutionError(error, record, lane, terminal, save, assertOwned);
    }
    if (record.status === "failed" && !budgetErrorCode({code:record.error}) && record.error !== "evidence_job_stopped")
      await this.store.stopJob(record.definition.correlation, `terminal ${lane} task ${record.id}: ${record.error ?? "unknown"}`);
    record.updatedAt = this.now();
    record.dispatchedAt = 0;
    await save(); // Commit result before deleting the queue message.
    if (record.status === "completed") this.observe("EvidenceTaskCompleted", record);
  }

  private async runUnlessStopped<T>(record: EvidenceTaskRecord, action: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const assertOpen = async () => {
      controller.signal.throwIfAborted();
      if (await this.store.isJobStopped(record.definition.correlation)) {
        const error = new EvidenceJobStopped();
        controller.abort(error);
        throw error;
      }
    };
    await assertOpen();
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void assertOpen().catch(error => controller.abort(error)).finally(() => { polling = false; });
    }, 3_000);
    try {
      const result = await withEvidenceTaskCancellation({signal:controller.signal,assertOpen}, action);
      await assertOpen();
      return result;
    } finally { clearInterval(timer); }
  }

  /** False leaves the notification unacknowledged for redelivery after lease contention. */
  async process(id: string, lane: EvidenceTaskLane,
    execute: (record: EvidenceTaskRecord) => Promise<unknown>,
    terminal: (record: EvidenceTaskRecord) => Promise<{result: unknown} | void> = () => Promise.resolve(undefined)): Promise<boolean> {
    validId(id);
    const existing = await this.store.get(id);
    if (!existing) throw new Error("Evidence task manifest is missing");
    const acquired = await this.store.withLease(id, async (record, save, assertOwned) => {
      // Old review notifications cannot execute a task already handed to repair.
      if (record.status !== "pending" || record.lane !== lane || record.availableAt > this.now()) return;
      if (await this.store.isJobStopped(record.definition.correlation)) {
        if (lane === "finalize") {
          const recovered = await terminal(record);
          assertOwned();
          record.status = recovered ? "completed" : "failed";
          if (recovered) { record.result = recovered.result; record.resultHash = evidenceTaskHash(recovered.result); }
        } else {
          record.status = "failed";
          record.error = "evidence_job_stopped";
        }
        record.updatedAt = this.now();
        record.dispatchedAt = 0;
        await save();
        this.observe(record.status === "completed" ? "EvidenceTaskCompleted" : "EvidenceTaskJobStopped",record);
        return;
      }
      // A failed terminal callback must be retried without buying another model call.
      if (failedGatheringUnitRetired(record, lane) || record.attempts >= record.definition.maxAttempts) {
        await this.exhaustAttempts(record, lane, terminal, save, assertOwned);
        return;
      }
      await this.attemptExecution(record, lane, execute, terminal, save, assertOwned);
    });
    // Dispatch itself holds this lease while sending the notification. A fast
    // consumer must not delete that notification before dispatch releases it.
    if (!acquired) return false;
    await this.dispatch(id);
    return true;
  }

  dispatcher(correlation: RequestContext, maxAttempts = 3): EvidenceReviewDispatcher {
    const sources = new Map<string, Promise<void>>();
    return { result: async (task, source, attemptLimit = maxAttempts) => {
      const sourceArtifact = evidenceTaskHash({ identity: task.context.identity, source });
      if (!sources.has(sourceArtifact)) sources.set(sourceArtifact, this.store.putArtifact(sourceArtifact, source));
      await sources.get(sourceArtifact);
      const payload: EvidenceReviewTask = { ...task, sourceArtifact };
      let lane: "gather" | "reconcile" | "repair" | "review";
      if (task.component === "gathering" || task.component === "gathering-unit" || task.component === "fast-window") lane = "gather";
      else if (task.component === "source-support") lane = "reconcile";
      else if (task.component === "support-repair") lane = "repair";
      else lane = "review";
      const id = await this.submit({lane,
        payload, correlation: {...correlation, batchId: task.batchId, componentId: `${task.batchId}:${task.component}`},
        maxAttempts: attemptLimit, allowFailover: task.allowFailover });
      const record = await this.store.get(id);
      if (record?.status === "completed") {
        if (!record.resultHash || evidenceTaskHash(record.result) !== record.resultHash) throw new Error("Queued evidence result checksum mismatch");
        return record.result;
      }
      if (record?.status === "failed") {
        const code = budgetErrorCode({code:record.error});
        if (code) throw new EvidenceBudgetError(code, `Evidence task ${id} stopped by its token budget`);
        throw new EvidenceTaskFailed(id);
      }
      throw new EvidenceReviewPending();
    } };
  }
}

const hasStatus = (error: unknown, ...codes: number[]) => typeof error === "object" && error !== null
  && "statusCode" in error && codes.includes(Number(error.statusCode));

export class BlobEvidenceTaskStore implements EvidenceTaskStore {
  private readonly container: ContainerClient;
  private initialized?: Promise<void>;
  constructor(blobs: BlobServiceClient = createBlobServiceClient()) {
    this.container = blobs
      .getContainerClient(process.env.EVIDENCE_TASK_CONTAINER || "file-operations-evidence-tasks");
  }
  private ready(): Promise<void> {
    this.initialized ??= this.container.createIfNotExists().then(() => undefined).catch((error: unknown) => {
      this.initialized = undefined; throw error;
    });
    return this.initialized;
  }
  async create(record: EvidenceTaskRecord): Promise<void> {
    await this.ready();
    try {
      await this.container.getBlockBlobClient(`tasks/${validId(record.id)}.json`).uploadData(Buffer.from(JSON.stringify(record)),
        { conditions: {ifNoneMatch: "*"}, blobHTTPHeaders: {blobContentType: "application/json"}, metadata: this.taskMetadata(record) });
    } catch (error) {
      if (!hasStatus(error, 409, 412)) throw error;
      const existing = await this.get(record.id);
      if (!existing || JSON.stringify(existing.definition) !== JSON.stringify(record.definition))
        throw new Error("Evidence task ID reused with different input", {cause: error});
    }
  }
  async get(id: string): Promise<EvidenceTaskRecord | null> {
    await this.ready();
    try { return JSON.parse((await this.container.getBlobClient(`tasks/${validId(id)}.json`).downloadToBuffer()).toString()); }
    catch (error) {
      if (hasStatus(error, 404)) return null;
      throw error;
    }
  }
  async stopJob(correlation: RequestContext, reason: string): Promise<void> {
    await this.ready();
    const marker = this.container.getBlockBlobClient(`stopped-jobs/${jobKey(correlation)}.json`);
    try {
      await marker.uploadData(Buffer.from(JSON.stringify({accountId:correlation.accountId,
        sourceId:correlation.sourceId,jobId:correlation.jobId,reason,stoppedAt:new Date().toISOString()})),
      {conditions:{ifNoneMatch:"*"},blobHTTPHeaders:{blobContentType:"application/json"}});
    } catch(error) { if (!hasStatus(error,409,412)) throw error; }
  }
  async isJobStopped(correlation: RequestContext): Promise<boolean> {
    await this.ready();
    return this.container.getBlobClient(`stopped-jobs/${jobKey(correlation)}.json`).exists();
  }
  private taskMetadata(record: EvidenceTaskRecord): Record<string, string> {
    return {status: record.status, lane: record.lane, poisonSent: String(record.poisonSent ?? false)};
  }
  async *list(lane?: EvidenceTaskLane, pendingOnly = false): AsyncIterable<EvidenceTaskRecord> {
    await this.ready();
    for await (const blob of this.container.listBlobsFlat({prefix: "tasks/", includeMetadata: true})) {
      if (lane && blob.metadata?.lane && blob.metadata.lane !== lane) continue;
      if (pendingOnly && (blob.metadata?.status === "completed" || blob.metadata?.status === "failed" && blob.metadata.poisonSent === "true")) continue;
      const id = blob.name.slice(6, -5);
      const record = await this.get(id);
      if (record) yield record;
    }
  }
  async withLease(id: string, run: (record: EvidenceTaskRecord, save: () => Promise<void>, assertOwned: () => void) => Promise<void>): Promise<boolean> {
    await this.ready();
    const blob = this.container.getBlockBlobClient(`tasks/${validId(id)}.json`);
    const lease = blob.getBlobLeaseClient();
    try { await lease.acquireLease(60); }
    catch (error) {
      if (hasStatus(error, 409, 412)) return false;
      throw error;
    }
    let lost: unknown;
    let renewal: Promise<void> | undefined;
    const assertOwned = () => { if (lost) throw new Error("Evidence task lease lost", {cause: lost}); };
    const timer = setInterval(() => {
      renewal ??= lease.renewLease().then(() => undefined).catch((error: unknown) => { lost = error; })
        .finally(() => { renewal = undefined; });
    }, 20_000);
    try {
      const record = await this.get(id);
      if (!record) throw new Error("Evidence task disappeared");
      await run(record, async () => {
        assertOwned();
        await blob.uploadData(Buffer.from(JSON.stringify(record)), {conditions: {leaseId: lease.leaseId},
          blobHTTPHeaders: {blobContentType: "application/json"}, metadata: this.taskMetadata(record) });
      }, assertOwned);
      return true;
    } finally {
      clearInterval(timer);
      await renewal;
      await lease.releaseLease().catch(() => undefined);
    }
  }
  async putArtifact(id: string, value: unknown): Promise<void> {
    await this.ready();
    try {
      await this.container.getBlockBlobClient(`sources/${validId(id)}.json`).uploadData(Buffer.from(JSON.stringify(value)),
        {conditions: {ifNoneMatch: "*"}, blobHTTPHeaders: {blobContentType: "application/json"}});
    } catch (error) {
      if (!hasStatus(error, 409, 412)) throw error;
      // Refresh before publishing a new reference; also fences orphan pruning.
      await this.container.getBlobClient(`sources/${validId(id)}.json`).setMetadata({});
    }
  }
  private async pruneTerminalRecord(record: EvidenceTaskRecord, cutoff: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const blob = this.container.getBlobClient(`tasks/${record.id}.json`);
    const lease = blob.getBlobLeaseClient();
    try {
      await lease.acquireLease(60);
      signal?.throwIfAborted();
      const current = await this.get(record.id);
      if (current && current.status !== "pending" && current.updatedAt < cutoff)
        await blob.deleteIfExists({conditions: {leaseId: lease.leaseId}});
    } catch (error) { if (!hasStatus(error, 404, 409, 412)) throw error; }
    finally { if (lease.leaseId) await lease.releaseLease().catch(() => undefined); }
  }
  private async pruneOrphanSources(referencedSources: Set<string>, cutoff: number, signal?: AbortSignal): Promise<void> {
    for await (const blob of this.container.listBlobsFlat({prefix: "sources/"})) {
      signal?.throwIfAborted();
      if (referencedSources.has(blob.name.slice(8, -5)) || !blob.properties.lastModified || blob.properties.lastModified.getTime() >= cutoff) continue;
      try { await this.container.getBlobClient(blob.name).deleteIfExists({conditions: {ifMatch: blob.properties.etag}}); }
      catch (error) { if (!hasStatus(error, 409, 412)) throw error; }
    }
  }
  /** Retain terminal task receipts for 30 days. Never prune pending task inputs. */
  async pruneTerminal(signal?: AbortSignal, maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<void> {
    await this.ready();
    const referencedSources = new Set<string>();
    const cutoff = Date.now() - maxAgeMs;
    for await (const record of this.list()) {
      signal?.throwIfAborted();
      if ((record.status === "completed" || record.status === "failed" && record.poisonSent) && record.updatedAt < cutoff) {
        await this.pruneTerminalRecord(record, cutoff, signal);
      }
      const payload = record.definition.payload as {sourceArtifact?: unknown} | null;
      if (typeof payload?.sourceArtifact === "string") referencedSources.add(payload.sourceArtifact);
    }
    signal?.throwIfAborted();
    await this.pruneOrphanSources(referencedSources, cutoff, signal);
  }

  async artifact(id: string): Promise<unknown> {
    await this.ready();
    return JSON.parse((await this.container.getBlobClient(`sources/${validId(id)}.json`).downloadToBuffer()).toString());
  }
}

export class StorageEvidenceTaskTransport implements EvidenceTaskTransport {
  private readonly service: QueueServiceClient;
  private readonly prefix: string;
  private readonly notificationTtlSeconds: number;
  private readonly initialized = new Map<string, Promise<unknown>>();
  constructor(queues: QueueServiceClient = createQueueServiceClient()) {
    this.prefix = process.env.EVIDENCE_QUEUE_PREFIX || "evidence";
    this.notificationTtlSeconds = Math.ceil(redispatchIntervalMs() / 1000);
    this.service = queues;
  }
  async client(lane: EvidenceTaskLane | "poison") {
    const queue = this.service.getQueueClient(`${this.prefix}-${lane}`);
    if (!this.initialized.has(lane)) this.initialized.set(lane, queue.createIfNotExists().catch((error: unknown) => {
      this.initialized.delete(lane); throw error;
    }));
    await this.initialized.get(lane);
    return queue;
  }
  async send(lane: EvidenceTaskLane | "poison", id: string): Promise<void> {
    const queue = await this.client(lane);
    // Task manifests are durable; expired wake-ups are rebuilt by outbox recovery.
    // An infinite lifetime accumulates stale copies every redispatch interval.
    await queue.sendMessage(JSON.stringify({version: 1, taskId: validId(id)}),
      {messageTimeToLive: lane === "poison" ? 30 * 24 * 60 * 60 : this.notificationTtlSeconds});
  }
}
