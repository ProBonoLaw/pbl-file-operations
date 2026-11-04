import { evidenceQueueEnabled, EvidenceReviewPending } from "./evidenceAsync.js";
import { budgetErrorCode, EvidenceBudgetError } from "./evidenceCostBudget.js";
import { createEvidenceTaskQueue, enqueueEvidenceJob } from "./evidenceQueueClient.js";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { createBlobServiceClient, createCheckpointBlobServiceClient } from "../../storage.js";
import { DefaultAzureCredential } from "@azure/identity";
import { earliestEventPosition, EventHubConsumerClient, EventHubProducerClient, type ReceivedEventData, type PartitionContext } from "@azure/event-hubs";
import { BlobCheckpointStore } from "@azure/eventhubs-checkpointstore-blob";
import { validateIngestionRequest } from "../../api.js";
import type { FileIngestionWork } from "../../models/request.js";
import { withRequestContext } from "../../requestContext.js";
import { DocumentIngressProcessor } from "../dataIngestionProcessor.js";
import { telemetryClient } from "../appInsights.js";
import { BlobEvidenceCheckpointStore } from "./evidenceCheckpoint.js";
import { BlobEvidenceWorkStore, type EvidenceJobStore } from "./evidenceWorkStore.js";
import { withEvidenceExtractionTelemetry } from "./evidenceExtractionTelemetry.js";
import { resolveEvidenceExtractionMode, routeEvidenceExtractionModeForBudget,
  type EvidenceExtractionSelection } from "./evidenceExtractionMode.js";
import { createProcessShutdown } from "../../processShutdown.js";
import { evidenceRetryPolicy, evidenceRetryBudget, type EvidenceRetryPolicy, type EvidenceRetryBudget } from "./evidenceRetryPolicy.js";

export class EvidenceJobOwnedError extends Error {}

export class EvidenceJobAttemptError extends Error {
  constructor(cause: unknown, readonly attempt: number, readonly budget: EvidenceRetryBudget) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "EvidenceJobAttemptError";
  }
  get exhausted(): boolean { return this.attempt >= this.budget.maxAttempts; }
}

export function validateEvidenceWork(body: unknown): FileIngestionWork {
  const request = validateIngestionRequest(body);
  const value = body as Record<string, unknown>;
  const string = (name: string): string => {
    if (typeof value[name] !== "string" || !value[name].trim()) throw new Error(`${name} is required`);
    return value[name];
  };
  if (!request.eventOrder || request.isWebSite || request.sourceId === "PURGE_ACCOUNT")
    throw new Error("Evidence extraction requires an ordered uploaded document");
  if (!Array.isArray(value.cleanupBlobs) || value.cleanupBlobs.length < 1 || value.cleanupBlobs.length > 4 ||
      value.cleanupBlobs.some(blob => !blob || typeof blob.containerName !== "string" || !blob.containerName ||
        typeof blob.containerPath !== "string" || !blob.containerPath)) throw new Error("Invalid cleanup blob locations");
  return { ...request, jobId: string("jobId"), identifier: string("identifier"), filepath: string("filepath"),
    progressPartition: string("progressPartition"), progressRow: string("progressRow"), cleanupBlobs: value.cleanupBlobs };
}

export interface EvidenceJobOperations {
  resolveMode(request: FileIngestionWork): Promise<EvidenceExtractionSelection>;
  extract(request: FileIngestionWork, onSource: (pageCount: number, characterCount: number) => Promise<EvidenceExtractionSelection>): Promise<import("@langchain/core/documents").Document[]>;
  index(request: FileIngestionWork): Promise<"SUCCESS" | "SUPERSEDED">;
  publishCleanup(request: FileIngestionWork, status: "SUCCESS" | "SUPERSEDED" | "FAILED", evidenceExtractionSkipped?: boolean): Promise<void>;
}

export async function processEvidenceJob(request: FileIngestionWork, work: EvidenceJobStore,
  operations: EvidenceJobOperations, policy: EvidenceRetryPolicy = evidenceRetryPolicy()): Promise<void> {
  await work.enqueue(request);
  const processed = await work.withLease(request.jobId, async (record, save, assertOwned) => {
    if (!record.retryBudget) {
      record.retryBudget = evidenceRetryBudget(policy);
      // Existing jobs get one opportunity to load their source and establish a
      // size-based budget; that bootstrap allowance is persisted, never renewed.
      record.retryBudget.maxAttempts = Math.max(record.retryBudget.maxAttempts, record.attempts + 1);
    }
    const alreadyIndexed = record.status === "extracted" && await work.indexResult(request.jobId) !== null;
    if (!alreadyIndexed && record.attempts >= record.retryBudget.maxAttempts)
      throw new EvidenceJobAttemptError(new Error("Evidence job retry budget exhausted"), record.attempts, record.retryBudget);
    if (!alreadyIndexed) record.attempts++;
    await save(record);
    try {
      if (record.status === "queued") {
        const properties: Record<string, string> = {
          accountId: request.accountId, sourceId: request.sourceId, jobId: request.jobId,
          attempt: String(record.attempts), executionMode: "worker",
          evidenceExtractionMode:record.extractionMode ?? request.evidenceExtractionMode ?? "auto",
          maxAttempts: String(record.retryBudget.maxAttempts),
          ...(record.retryBudget.pageCount !== null ? {pageCount:String(record.retryBudget.pageCount)} : {}),
        };
        const documents = await withEvidenceExtractionTelemetry(properties, async () => {
          if (!record.extractionMode) {
            record.extractionMode = await operations.resolveMode(request);
            assertOwned();
            await save(record);
          }
          properties.evidenceExtractionMode = record.extractionMode;
          telemetryClient.trackEvent({name:"EvidenceExtractionModeSelected",properties:{...properties}});
          if (record.extractionMode === "skip") return [];
          return operations.extract({...request,evidenceExtractionMode:record.extractionMode}, async (pageCount,characterCount) => {
            const budget = evidenceRetryBudget(record.retryBudget!, pageCount);
            if (record.retryBudget!.pageCount === null) {
              record.retryBudget = budget;
              assertOwned();
              await save(record);
              assertOwned();
              properties.pageCount = String(pageCount);
              properties.maxAttempts = String(budget.maxAttempts);
              telemetryClient.trackEvent({name:"EvidenceExtractionRetryBudgetResolved",properties:{...properties}});
            }
            if (record.attempts > record.retryBudget!.maxAttempts)
              throw new Error("Evidence job retry budget exhausted after resolving source size");
            const routed=await routeEvidenceExtractionModeForBudget(record.extractionMode!,pageCount,characterCount);
            if (routed!==record.extractionMode) {
              record.extractionMode=routed;
              assertOwned();
              await save(record);
              properties.evidenceExtractionMode=routed;
              telemetryClient.trackEvent({name:"EvidenceExtractionBudgetModeRouted",properties:{...properties,
                characterCount:String(characterCount)}});
            }
            return record.extractionMode!;
          });
        });
        assertOwned();
        await work.saveDocuments(request.jobId, documents);
        record.status = "extracted";
        await save(record);
      }
      assertOwned();
      const status = await operations.index(request);
      assertOwned();
      await operations.publishCleanup(request, status, record.extractionMode === "skip");
      record.status = "completed";
      await save(record);
      // A completed marker prevents re-extraction after broker replay.
      await work.removeDocuments(request.jobId);
    } catch (error) {
      // Result deletion after completion must remain retryable even if the
      // successful extraction/indexing used the final permitted attempt.
      if (record.status === "completed") throw error;
      if (error instanceof EvidenceReviewPending || budgetErrorCode(error)) {
        record.attempts--;
        assertOwned();
        await save(record);
        throw error;
      }
      throw new EvidenceJobAttemptError(error, record.attempts, record.retryBudget);
    }
  });
  if (!processed) {
    if ((await work.get(request.jobId))?.status === "completed") {
      // Completion is recorded before result deletion. Broker redelivery must
      // finish that cleanup without re-extracting or re-indexing the evidence.
      await work.removeDocuments(request.jobId);
      return;
    }
    throw new EvidenceJobOwnedError("Evidence job is owned by another worker");
  }
}

export function createEvidenceJobOperations(evidenceCheckpoints: BlobEvidenceCheckpointStore,
  producer: EventHubProducerClient, controller: AbortController): EvidenceJobOperations {
  return {
    resolveMode: request => resolveEvidenceExtractionMode(request.accountId, request.evidenceExtractionMode),
    extract: async (request, onSource) => new DocumentIngressProcessor(request.containerName, request.containerPath,
      request.documentName, request.sourceUrl, request.accountId, request.sourceId,
      request.isCurrentOrder ?? false, false, evidenceCheckpoints, true, request.extractionContainerPath,
      request.evidenceExtractionMode).extractEvidence(onSource),
    index: async request => {
      const endpoint = new URL("/internal/data-ingestion/evidence", required("DATA_INGESTION_SERVICE_URL"));
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: request.accountId, sourceId: request.sourceId,
          jobId: request.jobId, eventOrder: request.eventOrder }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60 * 60 * 1000)]) });
      if (!response.ok) {
        const text = await response.text();
        let code;
        try {code = budgetErrorCode(JSON.parse(text));} catch { /* Ordinary API error. */ }
        if (code) throw new EvidenceBudgetError(code, "Evidence indexing stopped by its token budget");
        throw new Error(`Evidence indexing returned HTTP ${response.status}: ${text.slice(0, 512)}`);
      }
      const result = await response.json() as { superseded?: boolean };
      return result.superseded ? "SUPERSEDED" : "SUCCESS";
    },
    publishCleanup: async (request, status, evidenceExtractionSkipped = false) => {
      const partitionKey = createHash("sha256").update(`${request.accountId}\0${request.sourceId}`).digest("hex").toUpperCase();
      await producer.sendBatch([{ body: { contentData: { ...request, eventKind: "FileIngestionCleanup", status, evidenceExtractionSkipped } } }],
        { partitionKey });
    },
  };
}

/** Recover committed indexing before a coordinator announces terminal failure. */
export async function recoverEvidenceCompletion(request: FileIngestionWork, work: EvidenceJobStore,
  operations: EvidenceJobOperations): Promise<boolean> {
  const record = await work.get(request.jobId);
  if (record?.status === "completed") {
    await work.removeDocuments(request.jobId);
    return true;
  }
  if (record?.status !== "extracted" || !await work.indexResult(request.jobId)) return false;
  // The API still checks source order before returning its saved result.
  await processEvidenceJob(request, work, operations);
  return true;
}

export async function startEvidenceWorker(): Promise<void> {
  const lifecycle = createProcessShutdown("evidence-extraction");
  const retryPolicy = evidenceRetryPolicy();
  const credential = new DefaultAzureCredential();
  const namespace = required("EVENTHUB_NAMESPACE");
  const hub = process.env.EVENTHUB_NAME || "file-operations";
  const blobs = createBlobServiceClient();
  const checkpointBlobs = createCheckpointBlobServiceClient();
  const checkpointContainer = checkpointBlobs
    .getContainerClient(process.env.EVIDENCE_EVENTHUB_CHECKPOINT_CONTAINER || "file-operations-evidence-event-checkpoints");
  await checkpointContainer.createIfNotExists();
  const work = new BlobEvidenceWorkStore(blobs);
  const evidenceCheckpoints = new BlobEvidenceCheckpointStore(checkpointBlobs);
  const consumerGroup = process.env.EVIDENCE_EVENTHUB_CONSUMER_GROUP || "evidence-extraction-group";
  const client = new EventHubConsumerClient(consumerGroup,
    namespace, hub, credential, new BlobCheckpointStore(checkpointContainer));
  const producer = new EventHubProducerClient(namespace, hub, credential);
  const controller = new AbortController();
  let healthy = true;
  const operations = createEvidenceJobOperations(evidenceCheckpoints, producer, controller);
  const taskQueue = evidenceQueueEnabled() ? createEvidenceTaskQueue() : null;
  const failureContainer = checkpointBlobs
    .getContainerClient(process.env.FAILED_EVENTS_CONTAINER || "file-operations-failed-events");
  const storeFailure = async (event: ReceivedEventData, context: PartitionContext, error: unknown): Promise<void> => {
    await failureContainer.createIfNotExists();
    const raw = Buffer.isBuffer(event.body) ? event.body : typeof event.body === "string"
      ? Buffer.from(event.body) : Buffer.from(JSON.stringify(event.body));
    await failureContainer.getBlockBlobClient(`evidence-extraction/${context.partitionId}/${event.sequenceNumber}.json`)
      .uploadData(Buffer.from(JSON.stringify({ role: "evidence-extraction", partitionId: context.partitionId,
        sequenceNumber: event.sequenceNumber, eventKind: "EvidenceExtraction",
        eventBodyBase64: raw.toString("base64"),
        error: error instanceof Error ? error.message : String(error), failedAt: new Date().toISOString() })),
        { blobHTTPHeaders: { blobContentType: "application/json" } });
  };
  const processEvent = async (event: ReceivedEventData, context: PartitionContext): Promise<void> => {
    if (controller.signal.aborted) return;
    let body;
    try {
      body = typeof event.body === "string" || Buffer.isBuffer(event.body)
        ? JSON.parse(event.body.toString()) : event.body;
    } catch (error) {
      await storeFailure(event, context, error);
      await context.updateCheckpoint(event);
      return;
    }
    const content = body?.contentData ?? body;
    if (content?.eventKind !== "EvidenceExtraction") {
      await context.updateCheckpoint(event);
      return;
    }
    await withRequestContext({ accountId: content.accountId, sourceId: String(content.sourceId ?? ""),
      jobId:typeof content.jobId === "string" ? content.jobId : undefined,
      evidenceBudgetOverride:content.evidenceBudgetOverride === true }, async () => {
      let untrackedFailures = 0;
      for (;;) {
        if (controller.signal.aborted) return;
        try {
          const request = validateEvidenceWork(content);
          const startedAt = Date.now();
          if (taskQueue) await enqueueEvidenceJob(taskQueue, request);
          else await processEvidenceJob(request, work, operations, retryPolicy);
          try { await context.updateCheckpoint(event); }
          catch (error) { throw new CheckpointFailure("Evidence checkpoint update failed", { cause: error }); }
          telemetryClient.trackEvent({ name: taskQueue ? "EvidenceExtractionJobQueued" : "EvidenceExtractionJobCompleted",
            properties: { jobId: request.jobId, accountId: request.accountId, sourceId: request.sourceId },
            measurements: { durationMs: Date.now() - startedAt } });
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof CheckpointFailure) throw error;
          const costError = budgetErrorCode(error);
          if (costError) {
            if (costError === "evidence_budget_busy" || costError === "evidence_budget_unavailable") {
              await delay(15_000, undefined, { signal: controller.signal });
              continue;
            }
            await storeFailure(event, context, error);
            telemetryClient.trackEvent({name:"EvidenceExtractionBudgetStopped",properties:{
              accountId:String(content.accountId ?? ""),sourceId:String(content.sourceId ?? ""),
              jobId:String(content.jobId ?? ""),code:costError,
            }});
            // Keep source files and checkpoints for operator review; never ask
            // cleanup to delete a job that was stopped by a spending policy.
            await context.updateCheckpoint(event);
            return;
          }
          if (error instanceof EvidenceJobOwnedError) {
            await delay(20_000, undefined, { signal: controller.signal });
            continue;
          }
          const attempt = error instanceof EvidenceJobAttemptError ? error.attempt : ++untrackedFailures;
          const budget = error instanceof EvidenceJobAttemptError ? error.budget : evidenceRetryBudget(retryPolicy);
          console.error("Evidence extraction event failed", { attempt, maxAttempts:budget.maxAttempts, error });
          telemetryClient.trackEvent({name:"EvidenceExtractionJobAttemptFailed",properties:{
            jobId:String(content.jobId ?? ""),accountId:String(content.accountId ?? ""),sourceId:String(content.sourceId ?? ""),
            attempt:String(attempt),maxAttempts:String(budget.maxAttempts),pageCount:String(budget.pageCount ?? "unknown"),
            exhausted:String(attempt >= budget.maxAttempts),
          }});
          if (attempt >= budget.maxAttempts) {
            let failedRequest: FileIngestionWork | undefined;
            try { failedRequest = validateEvidenceWork(content); }
            catch { /* Malformed events are retained in failed-event storage. */ }
            let recovered = false;
            if (failedRequest && !taskQueue) {
              try { recovered = await recoverEvidenceCompletion(failedRequest, work, operations); }
              catch (recoveryError) {
                // An unreadable receipt or unacknowledged completion is not a
                // terminal ingestion failure. Keep the event until recovery succeeds.
                console.error("Evidence completion recovery failed; retrying", recoveryError);
                await delay(60_000, undefined, { signal: controller.signal });
                continue;
              }
            }
            if (recovered && failedRequest) {
              await context.updateCheckpoint(event);
              telemetryClient.trackEvent({ name: "EvidenceExtractionJobCompleted", properties: {
                jobId: failedRequest.jobId, accountId: failedRequest.accountId, sourceId: failedRequest.sourceId,
              } });
              return;
            }
            await storeFailure(event, context, error);
            if (failedRequest) await operations.publishCleanup(failedRequest, "FAILED");
            // Preserve input blobs and extraction checkpoints; replay the stored event after repair.
            await context.updateCheckpoint(event);
            return;
          }
          await delay(Math.min(60_000, 5000 * 2 ** (attempt - 1)), undefined, { signal: controller.signal });
        }
      }
    });
  };
  const subscription = client.subscribe({
    processEvents: async (events, context) => {
      try { for (const event of events) await processEvent(event, context); }
      catch (error) {
        if (!controller.signal.aborted) {
          healthy = false;
          console.error("Evidence worker cannot checkpoint or store failures", error);
          controller.abort();
          process.exitCode = 1;
          setTimeout(() => process.exit(1), 1000).unref();
        }
      }
    },
    processError: async error => { console.error("Evidence Event Hub error", error); },
  }, { startPosition: earliestEventPosition, maxBatchSize: 1, maxWaitTimeInSeconds: 5 });
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/healthz" ? (healthy ? 200 : 503) : 404);
    response.end(healthy ? "ok" : "unhealthy");
  });
  server.listen(Number(process.env.PORT || "8080"), "0.0.0.0");
  console.info("Evidence extraction worker started", { consumerGroup });
  const shutdown = async (signal: string): Promise<void> => {
    if (!lifecycle.begin(signal)) return;
    healthy = false;
    console.info("Evidence worker stopping; draining event handlers");
    controller.abort();
    server.close();
    await subscription.close();
    await client.close();
    await producer.close();
    let telemetryDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        telemetryClient.shutdown(),
        new Promise<never>((_, reject) => {
          telemetryDeadline = setTimeout(() => reject(new Error("Telemetry shutdown exceeded 15 seconds")), 15_000);
        }),
      ]);
    } catch (error) {
      console.error("Evidence worker telemetry shutdown failed after handlers drained", error);
      process.exitCode = 1;
    } finally {
      clearTimeout(telemetryDeadline);
    }
    console.info("Evidence worker drained; exiting");
    // Bun/SDK background handles can keep the process alive after every owned
    // resource has closed. Exit after handlers/broker clients close and the bounded telemetry flush.
    lifecycle.finish();
  };
  const stop = (signal: string): void => { void shutdown(signal).catch((error: unknown) => {
    console.error("Evidence worker shutdown failed", error);
    lifecycle.finish(1);
  }); };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

class CheckpointFailure extends Error {}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
