import { createEvidenceTaskQueue } from "./evidenceQueueClient.js";
import { evidenceQueueConcurrency } from "./evidenceConcurrency.js";
import { context as traceContext, trace, TraceFlags, SpanStatusCode } from "@opentelemetry/api";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { DefaultAzureCredential } from "@azure/identity";
import { EventHubProducerClient } from "@azure/event-hubs";
import { EvidenceSourceCache } from "./evidenceSourceCache.js";
import { z } from "zod";
import { withRequestContext } from "../../requestContext.js";
import { createProcessShutdown } from "../../processShutdown.js";
import { telemetryClient } from "../appInsights.js";
import { EvidenceReviewPending, withEvidenceReviewDispatcher, type EvidenceReviewTask } from "./evidenceAsync.js";
import { EvidenceExtractor } from "./evidenceExtractor.js";
import { BlobEvidenceCheckpointStore } from "./evidenceCheckpoint.js";
import { BlobEvidenceWorkStore } from "./evidenceWorkStore.js";
import { createEvidenceJobOperations, EvidenceJobAttemptError, EvidenceJobOwnedError, processEvidenceJob, recoverEvidenceCompletion, validateEvidenceWork, type EvidenceJobOperations } from "./evidenceWorker.js";
import { BlobEvidenceTaskStore, EvidenceTaskFailed, EvidenceTaskRetry, StorageEvidenceTaskTransport,
  type EvidenceTaskLane, type EvidenceTaskRecord } from "./evidenceTaskQueue.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const positiveSetting = (name: string, fallback: number, maximum: number): number => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be between 1 and ${maximum}`);
  return value;
};
const reviewTaskSchema = z.object({
  version: z.literal(1), component: z.enum(["gathering", "gathering-unit", "fast-window", "source-support", "support-repair", "classification", "dates", "classified-event-dates", "attribution", "canonicalization"]),
  context: z.object({identity: z.object({accountId: z.string(), sourceId: z.string(), runFingerprint: z.string()}), windowIndex: z.number().int().nonnegative()}),
  batchId: z.string(), candidates: z.array(z.unknown()), sourceArtifact: z.string().regex(/^[a-f0-9]{64}$/),
  initialReviewer: z.enum(["reconciliation", "independent", "fallback"]), allowFailover: z.boolean(),
  dateReview: z.enum(["resolve", "defer", "conflict"]).optional(),
  gathering: z.object({stage: z.enum(["primary-events", "primary-facts", "primary-claims", "independent"]),
    startOffset: z.number().int().nonnegative(), characterCount: z.number().int().positive(), depth: z.number().int().min(0).max(2)}).optional(),
});

/** Separate deployments consume each lane; model permits are local to each worker process. */
export async function startEvidenceQueueWorker(lane: EvidenceTaskLane,
  overrides: {operations?: EvidenceJobOperations} = {}): Promise<void> {
  const lifecycle = createProcessShutdown(`evidence-${lane}`);
  const concurrency = evidenceQueueConcurrency(lane);
  const queue = createEvidenceTaskQueue();
  const sources = new EvidenceSourceCache(id => queue.store.artifact(id));
  const transport = queue.transport as StorageEvidenceTaskTransport;
  const client = await transport.client(lane);
  const controller = new AbortController();
  // Stopping intake must not abort indexing and turn a deployment into a failed
  // job attempt. Active tasks drain until the process shutdown deadline.
  const operationController = new AbortController();
  const checkpoints = new BlobEvidenceCheckpointStore();
  const work = new BlobEvidenceWorkStore();
  const producer = lane === "finalize" && !overrides.operations ? new EventHubProducerClient(required("EVENTHUB_NAMESPACE"),
    process.env.EVENTHUB_NAME || "file-operations", new DefaultAzureCredential()) : null;
  const operations = overrides.operations ?? (producer ? createEvidenceJobOperations(checkpoints, producer, operationController) : null);
  const attempts = positiveSetting("EVIDENCE_REVIEW_MAX_ATTEMPTS", 3, 20);
  const execute = async (task: EvidenceTaskRecord) => withRequestContext({...task.definition.correlation, taskId: task.id}, async () => {
    if (lane === "finalize") {
      const request = validateEvidenceWork(task.definition.payload);
      try {
        await withEvidenceReviewDispatcher(queue.dispatcher(task.definition.correlation, attempts),
          () => processEvidenceJob(request, work, operations!));
      } catch (error) {
        if (error instanceof EvidenceJobOwnedError) throw new EvidenceReviewPending();
        if (error instanceof EvidenceJobAttemptError) throw new EvidenceTaskRetry(error.exhausted || error.cause instanceof EvidenceTaskFailed, error);
        throw error;
      }
      telemetryClient.trackEvent({name: "EvidenceExtractionJobCompleted", properties: {...task.definition.correlation}});
      return {jobId: request.jobId};
    }
    const payload: EvidenceReviewTask = reviewTaskSchema.parse(task.definition.payload);
    if (payload.component === "fast-window" || payload.component === "gathering-unit" ? lane !== "gather" && lane !== "repair"
      : (lane === "gather") !== (payload.component === "gathering") ||
      (lane === "reconcile") !== (payload.component === "source-support"))
      throw new Error("Evidence task component does not match its queue lane");
    if (payload.context.identity.accountId !== task.definition.correlation.accountId ||
      payload.context.identity.sourceId !== task.definition.correlation.sourceId) throw new Error("Review task correlation does not match its source");
    const source = await sources.get(payload.sourceArtifact);
    const extractor = new EvidenceExtractor(payload.context.identity.accountId, payload.context.identity.sourceId, undefined, checkpoints,
      undefined, payload.component === "fast-window" ? "fast" : "thorough");
    if (lane === "gather" || lane === "reconcile" || lane === "repair" && payload.component === "gathering-unit") {
      return withEvidenceReviewDispatcher(queue.dispatcher(task.definition.correlation, attempts),
        () => extractor.executeReviewTask(payload, source, lane === "repair"));
    }
    return extractor.executeReviewTask(payload, source, lane === "repair");
  });
  const terminal = async (task: EvidenceTaskRecord) => {
    if ((lane === "gather" && (task.error === "evidence_structured_invalid" || task.error === "evidence_output_limit")
      || lane === "repair" && (task.error === "evidence_structured_invalid" || task.error === "evidence_output_limit" || task.error === "content_filter"))
      && (task.definition.payload as Partial<EvidenceReviewTask> | null)?.component === "gathering-unit") {
      const payload = reviewTaskSchema.parse(task.definition.payload);
      if (payload.component !== "gathering-unit" || !payload.gathering)
        throw new Error("Only a failed gathering unit can be omitted");
      const stage = payload.gathering.stage;
      const source = await sources.get(payload.sourceArtifact);
      if (source.pages.length <= 1) {
        telemetryClient.trackEvent({name:"EvidenceGatheringUnitRejected",properties:{...task.definition.correlation,
          taskId:task.id,batchId:payload.batchId,stage,reason:task.error}});
        return;
      }
      telemetryClient.trackEvent({name:"EvidenceGatheringUnitDropped",properties:{...task.definition.correlation,
        taskId:task.id,batchId:payload.batchId,stage,
        characterCount:String(payload.gathering.characterCount),reason:task.error}});
      return {result:stage === "independent" ? {events:[],facts:[],claims:[]}
        : {[stage === "primary-events" ? "events" : stage === "primary-facts" ? "facts" : "claims"]:[]}};
    }
    if (lane === "finalize") {
      const request = validateEvidenceWork(task.definition.payload);
      if (await recoverEvidenceCompletion(request, work, operations!)) {
        return {result: {jobId: request.jobId}};
      }
      // Fence sibling workers before publishing terminal cleanup. A failed
      // cleanup notification can retry without allowing new paid model calls.
      await queue.store.stopJob(task.definition.correlation, `terminal finalize task ${task.id}`);
      await operations!.publishCleanup(request, "FAILED");
    }
  };
  let healthy = true;
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/healthz" && healthy ? 200 : 503); response.end(healthy ? "ok" : "unhealthy");
  });
  server.listen(Number(process.env.PORT || "8080"), "0.0.0.0");
  const shutdown = (signal: string) => {
    if (!lifecycle.begin(signal)) return;
    healthy = false;
    controller.abort();
    server.close();
  };
  const terminate = () => shutdown("SIGTERM");
  const interrupt = () => shutdown("SIGINT");
  process.once("SIGTERM", terminate); process.once("SIGINT", interrupt);
  const recover = async () => {
    while (!controller.signal.aborted) {
      try { await queue.recover(lane); }
      catch (error) { console.error("Evidence task outbox recovery failed", error); }
      await delay(30_000, undefined, {signal: controller.signal}).catch(() => undefined);
    }
  };
  const prune = async () => {
    while (!controller.signal.aborted) {
      try { await (queue.store as BlobEvidenceTaskStore).pruneTerminal(controller.signal); }
      catch (error) {
        if (!controller.signal.aborted) console.error("Evidence task cleanup failed", error);
      }
      await delay(24 * 60 * 60 * 1000, undefined, {signal: controller.signal}).catch(() => undefined);
    }
  };
  const consume = async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await client.receiveMessages({numberOfMessages: 1, visibilityTimeout: 60});
        // A receive already in flight may finish after SIGTERM. Leave its
        // message unacknowledged for redelivery rather than starting new work.
        if (controller.signal.aborted) break;
        const message = response.receivedMessageItems[0];
        if (!message) { await delay(2000, undefined, {signal: controller.signal}).catch(() => undefined); continue; }
        let receipt = message.popReceipt;
        let renewal: Promise<void> | undefined;
        let renewalError: unknown;
        const timer = setInterval(() => {
          renewal ??= client.updateMessage(message.messageId, receipt, undefined, 60).then(result => {
            receipt = result.popReceipt!;
          }).catch((error: unknown) => { renewalError = error; }).finally(() => { renewal = undefined; });
        }, 20_000);
        try {
          const quarantine = async () => {
            const id = createHash("sha256").update(`${lane}:${message.messageId}`).digest("hex");
            await queue.store.putArtifact(id, {kind: "invalid-queue-message", lane, messageId: message.messageId, messageText: message.messageText});
            await transport.send("poison", id);
            clearInterval(timer);
            await renewal;
            if (renewalError) throw renewalError;
            await client.deleteMessage(message.messageId, receipt);
          };
          let envelope: {version: 1; taskId: string};
          try { envelope = z.object({version: z.literal(1), taskId: z.string().regex(/^[a-f0-9]{64}$/)}).parse(JSON.parse(message.messageText)); }
          catch { await quarantine(); continue; }
          const task = await queue.store.get(envelope.taskId);
          if (controller.signal.aborted) continue;
          if (!task) { await quarantine(); continue; }
          const correlation = {...task.definition.correlation, taskId: task.id};
          const parent = trace.setSpanContext(traceContext.active(), {
            traceId: correlation.operationId ?? createHash("sha256").update(task.id).digest("hex").slice(0, 32),
            spanId: createHash("sha256").update(`parent:${correlation.jobId ?? task.id}`).digest("hex").slice(0, 16),
            traceFlags: TraceFlags.SAMPLED, isRemote: true,
          });
          const processed = await withRequestContext(correlation, () => traceContext.with(parent, () =>
            trace.getTracer("evidence-queue").startActiveSpan(`evidence.${lane}`, async span => {
              span.setAttributes(Object.fromEntries(Object.entries(correlation).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
              try { return await queue.process(envelope.taskId, lane, execute, terminal); }
              catch (error) { span.setStatus({code: SpanStatusCode.ERROR}); throw error; }
              finally { span.end(); }
            })));

          // Another worker or the notification sender still owns the manifest
          // lease. Keep this message for redelivery instead of losing its wake-up.
          if (processed === false) continue;

          clearInterval(timer);
          await renewal;
          if (renewalError) throw renewalError;
          await client.deleteMessage(message.messageId, receipt);
        } finally { clearInterval(timer); await renewal; }
      } catch (error) {
        console.error("Evidence queue delivery failed", error);
        await delay(5000, undefined, {signal: controller.signal}).catch(() => undefined);
      }
    }
  };
  let failed = false;
  const drainWorker = async (worker: () => Promise<void>) => {
    try { await worker(); }
    catch (error) { failed = true; shutdown("worker failure"); throw error; }
  };
  try {
    const workers = await Promise.allSettled([recover, ...(lane === "finalize" ? [prune] : []),
      ...Array.from({length: concurrency}, () => consume)].map(drainWorker));
    const failure = workers.find(worker => worker.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } finally {
    healthy = false;
    server.close();
    const closed = await Promise.allSettled([
      Promise.resolve().then(() => producer?.close()),
      Promise.resolve().then(() => telemetryClient.shutdown()),
    ]);
    for (const resource of closed) if (resource.status === "rejected") {
      failed = true;
      console.error("Evidence queue worker resource shutdown failed", resource.reason);
    }
    process.removeListener("SIGTERM", terminate); process.removeListener("SIGINT", interrupt);
    console.info(`Evidence ${lane} worker drained; exiting`);
    lifecycle.finish(failed ? 1 : Number(process.exitCode ?? 0));
  }
}
