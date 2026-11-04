import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DataIngestionRequest, BaseRequest, EventOrder, EvidenceIndexRequest } from "./models/request.js";
import type { Document } from "@langchain/core/documents";
import type { EvidenceWorkStore } from "./processors/evidence/evidenceWorkStore.js";
import type {
  DataIngestionResponse,
  DataRemovalResponse,
} from "./models/response.js";
import { withRequestContext } from "./requestContext.js";
import { budgetErrorCode } from "./processors/evidence/evidenceCostBudget.js";
import { AccountOperationQueue } from "./accountOperationQueue.js";
import { compareEventOrder, type AppliedEventOrder, type OperationKind,
  type OperationOrderStore } from "./operationOrderStore.js";
import type { EvidenceCheckpointStore } from "./processors/evidence/evidenceCheckpoint.js";
import type { EvidenceTaskStore } from "./processors/evidence/evidenceTaskQueue.js";

const maximumRequestBytes = 1024 * 1024;

class InvalidRequestError extends Error {}
class IngestionJobStopped extends Error {
  constructor() { super("ingestion_job_stopped"); }
}

export interface ApiTelemetry {
  trackTrace(telemetry: {
    message: string;
    properties: Record<string, string>;
  }): void;
  trackEvent(telemetry: {
    name: string;
    properties: Record<string, string>;
    measurements: Record<string, number>;
  }): void;
  trackException(telemetry: {
    exception: Error;
    properties: Record<string, string>;
  }): void;
}

export interface DuplicateDocumentOperations {
  open(): Promise<void>;
  delete(): Promise<void>;
  removeEntries(sourceId: string): Promise<boolean>;
}

export interface IngestionOperations {
  processDocument(checkOpen?: () => Promise<void>): Promise<string[]>;
  indexEvidenceDocuments?(documents: Document[], jobId: string, checkOpen?: () => Promise<void>): Promise<string[]>;
}

export interface DataIngestionApiDependencies {
  telemetryClient: ApiTelemetry;
  createDuplicateDocumentProcessor(accountId: string): DuplicateDocumentOperations;
  createDocumentIngressProcessor(request: DataIngestionRequest): IngestionOperations;
  operationOrderStore?: OperationOrderStore;
  evidenceCheckpointStore?: EvidenceCheckpointStore;
  evidenceWorkStore?: EvidenceWorkStore;
  evidenceTaskStore?: Pick<EvidenceTaskStore, "isJobStopped">;
}

export function createDataIngestionApiServer(
  dependencies: DataIngestionApiDependencies,
): Server & { waitForRequests(): Promise<void> } {
  const accountOperations = new AccountOperationQueue(
    Number(process.env.DATA_INGESTION_MAX_CONCURRENCY ?? "2"));
  const activeRequests = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const operation = handleRequest(request, response, dependencies, accountOperations).catch((error: unknown) => {
      console.error("Unhandled Data Ingestion API request failure", error);
      sendJson(response, 500, { error: "Internal server error" });
    }).finally(() => { activeRequests.delete(operation); });
    activeRequests.add(operation);
  });
  return Object.assign(server, {
    // A caller can disconnect while its queued or active indexing continues.
    // Closing HTTP connections alone does not mean those operations have drained.
    async waitForRequests(): Promise<void> { await Promise.allSettled(activeRequests); },
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: DataIngestionApiDependencies,
  accountOperations: AccountOperationQueue,
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "GET" && pathname === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  const isIngestion =
    request.method === "POST" && pathname === "/internal/data-ingestion/ingest";
  const isRemoval =
    request.method === "DELETE" && pathname === "/internal/data-ingestion/remove";
  const isEvidenceIndex = request.method === "POST" && pathname === "/internal/data-ingestion/evidence";
  if (!isIngestion && !isRemoval && !isEvidenceIndex) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const status = error instanceof InvalidRequestError ? 400 : 500;
    sendJson(response, status, { error: errorMessage(error) });
    return;
  }

  const identity = requestIdentity(body);
  await withRequestContext({...identity,
    ...((isEvidenceIndex || isIngestion) && isRecord(body) && typeof body.jobId === "string" ? {jobId:body.jobId} : {}),
    ...(isIngestion && isRecord(body) && body.evidenceBudgetOverride === true ? {evidenceBudgetOverride:true} : {}),
  }, async () => {
    const startedAt = Date.now();
    const operation = isEvidenceIndex ? "indexEvidence" : isIngestion ? "ingest" : "remove";
    const requestLabel = isEvidenceIndex ? "Evidence indexing" : "Data Ingestion API";
    const requestProperties = {
      operation,
      accountId: identity.accountId ?? "unknown",
      sourceId: identity.sourceId ?? "unknown",
      ...(isEvidenceIndex && isRecord(body) && typeof body.jobId === "string" ? { jobId: body.jobId } : {}),
    };
    dependencies.telemetryClient.trackTrace({
      message: `${requestLabel} request started`,
      properties: requestProperties,
    });
    console.info(`${requestLabel} request started`, { operation });
    try {
      let result: DataIngestionResponse | DataRemovalResponse;
      if (isEvidenceIndex) {
        const validated = validateEvidenceIndexRequest(body);
        result = await accountOperations.runSource(validated.accountId, validated.sourceId, () =>
          runUnlessStopped(validated, dependencies, checkOpen => indexEvidence(validated, dependencies, checkOpen)));
      } else if (isIngestion) {
        const validated = validateIngestionRequest(body);
        result = await accountOperations.runSource(validated.accountId, validated.sourceId, () =>
          runUnlessStopped(validated, dependencies, checkOpen =>
            applyOrdered<DataIngestionResponse>(validated, "ingest", { indexes: [] }, dependencies,
              () => ingestDocument(validated, dependencies, checkOpen), checkOpen)));
      } else {
        const validated = validateBaseRequest(body);
        result = await accountOperations.runSource(validated.accountId, validated.sourceId, () =>
          applyOrdered<DataRemovalResponse>(validated, "remove", { removedFromGeneralIndex: false }, dependencies,
            () => removeDocument(validated, dependencies)));
      }
      dependencies.telemetryClient.trackEvent({
        name: isEvidenceIndex ? "EvidenceIndexingCompleted" : "DataIngestionApiRequestCompleted",
        properties: { ...requestProperties, ...(isEvidenceIndex ? {
          outcome: "superseded" in result && result.superseded ? "SUPERSEDED" : "SUCCESS",
        } : {}) },
        measurements: { durationMs: Date.now() - startedAt },
      });
      dependencies.telemetryClient.trackTrace({
        message: `${requestLabel} request completed`,
        properties: requestProperties,
      });
      console.info(`${requestLabel} request completed`, {
        operation,
        durationMs: Date.now() - startedAt,
      });
      sendJson(response, 200, result);
    } catch (error) {
      const code = budgetErrorCode(error);
      const status = code ? 402 : error instanceof IngestionJobStopped ? 409 : error instanceof InvalidRequestError ? 400 : 500;
      dependencies.telemetryClient.trackException({
        exception: error instanceof Error ? error : new Error(String(error)),
        properties: requestProperties,
      });
      console.error(`${requestLabel} request failed`, {
        operation,
        durationMs: Date.now() - startedAt,
        error,
      });
      sendJson(response, status, { error: errorMessage(error), ...(code ? {code} : {}) });
    }
  });
}

async function runUnlessStopped<T>(request: BaseRequest & {jobId?: string},
  dependencies: DataIngestionApiDependencies, action: (checkOpen: () => Promise<void>) => Promise<T>): Promise<T> {
  if (!request.jobId || !dependencies.evidenceTaskStore) return action(async () => {});
  const controller = new AbortController();
  const correlation = {accountId:request.accountId,sourceId:request.sourceId,jobId:request.jobId};
  const checkOpen = async (): Promise<void> => {
    controller.signal.throwIfAborted();
    if (await dependencies.evidenceTaskStore!.isJobStopped(correlation)) {
      const stopped = new IngestionJobStopped();
      controller.abort(stopped);
      throw stopped;
    }
  };
  let polling = false;
  const poll = setInterval(() => {
    if (polling) return;
    polling = true;
    void checkOpen().catch(error => controller.abort(error)).finally(() => { polling = false; });
  }, 3_000);
  try {
    await checkOpen();
    const result = await action(checkOpen);
    await checkOpen();
    return result;
  } finally { clearInterval(poll); }
}

async function indexEvidence(request: EvidenceIndexRequest,
  dependencies: DataIngestionApiDependencies, checkOpen: () => Promise<void>): Promise<DataIngestionResponse> {
  const work = dependencies.evidenceWorkStore;
  const store = dependencies.operationOrderStore;
  if (!work || !store) throw new Error("Evidence work and order storage are required");
  const record = await work.get(request.jobId);
  if (!record || record.request.accountId !== request.accountId || record.request.sourceId !== request.sourceId)
    throw new InvalidRequestError("Evidence job does not match the requested source");
  if (!record.request.eventOrder || !request.eventOrder ||
      JSON.stringify(record.request.eventOrder) !== JSON.stringify(request.eventOrder))
    throw new InvalidRequestError("Evidence indexing requires the original ingestion order");
  const current = await store.get(request.accountId, request.sourceId);
  const order = { ...request.eventOrder, operation: "ingest" as const };
  const accountOrder = await store.get(request.accountId, "PURGE_ACCOUNT");
  if (accountOrder && compareEventOrder(order, accountOrder) <= 0) return { indexes: [], superseded: true };
  if (!current) throw new Error("Source ingestion has not completed");
  const comparison = compareEventOrder(order, current);
  if (comparison < 0 || (comparison === 0 && current.operation !== "ingest")) {
    console.info("Skipping evidence for a replaced or deleted source", { jobId: request.jobId });
    return { indexes: [], superseded: true };
  }
  if (comparison > 0) throw new Error("Source ingestion has not reached the evidence job order");
  // Check the order fence before reusing a completion receipt. A disconnected
  // caller can retry after success, including after temporary results are gone.
  const indexed = await work.indexResult(request.jobId);
  if (indexed) return indexed;
  await checkOpen();
  const documents = await work.documents(request.jobId);
  const processor = dependencies.createDocumentIngressProcessor(record.request);
  if (!processor.indexEvidenceDocuments) throw new Error("Evidence indexing is not configured");
  const result = { indexes: await processor.indexEvidenceDocuments(documents, request.jobId, checkOpen) };
  await checkOpen();
  await work.saveIndexResult(request.jobId, result);
  return result;
}

async function applyOrdered<T>(request: BaseRequest, operation: OperationKind,
  staleResult: T, dependencies: DataIngestionApiDependencies,
  apply: () => Promise<T>, checkOpen: () => Promise<void> = async () => {}): Promise<T> {
  const store = dependencies.operationOrderStore;
  if (!request.eventOrder) {
    // Let the old workers drain during rollout, but do not let one overwrite a
    // source once an ordered worker has established its durable position.
    if (store && await store.get(request.accountId, request.sourceId))
      throw new Error("eventOrder is required for a source with ordered events");
    return apply();
  }
  if (!store) throw new Error("Operation order storage is not configured");
  const current: AppliedEventOrder = { ...request.eventOrder, operation };
  const previous = await store.get(request.accountId, request.sourceId);
  if (previous && compareEventOrder(current, previous) <= 0) {
    console.info("Skipping stale Data Ingestion API event", {
      operation, accountId: request.accountId, sourceId: request.sourceId,
      partitionId: current.partitionId, sequenceNumber: current.sequenceNumber,
    });
    return staleResult;
  }
  const result = await apply();
  await checkOpen();
  await store.put(request.accountId, request.sourceId, current);
  return result;
}

async function ingestDocument(
  request: DataIngestionRequest,
  dependencies: DataIngestionApiDependencies, checkOpen: () => Promise<void>,
): Promise<DataIngestionResponse> {
  const duplicateProcessor = dependencies.createDuplicateDocumentProcessor(
    request.accountId,
  );
  await duplicateProcessor.open();
  if (request.sourceId === "PURGE_ACCOUNT") {
    await duplicateProcessor.delete();
    await dependencies.evidenceCheckpointStore?.clearAccount(request.accountId);
  } else {
    await duplicateProcessor.removeEntries(request.sourceId);
  }

  await checkOpen();
  console.info("Ingesting document into the account search index");
  const processor = dependencies.createDocumentIngressProcessor(request);
  const indexes = await processor.processDocument(checkOpen);
  return { indexes };
}

async function removeDocument(
  request: BaseRequest,
  dependencies: DataIngestionApiDependencies,
): Promise<DataRemovalResponse> {
  const duplicateProcessor = dependencies.createDuplicateDocumentProcessor(
    request.accountId,
  );
  await duplicateProcessor.open();
  if (request.sourceId === "PURGE_ACCOUNT") {
    await duplicateProcessor.delete();
    await dependencies.evidenceCheckpointStore?.clearAccount(request.accountId);
    return { removedFromGeneralIndex: true };
  }

  const removedFromGeneralIndex = await duplicateProcessor.removeEntries(request.sourceId);
  await dependencies.evidenceCheckpointStore?.clearSource(request.accountId, request.sourceId);
  return { removedFromGeneralIndex };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumRequestBytes) {
      throw new InvalidRequestError("Request body is too large");
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new InvalidRequestError("Request body must be valid JSON");
  }
}

export function validateIngestionRequest(body: unknown): DataIngestionRequest {
  const request = validateBaseRequest(body);
  if (!isRecord(body)) throw new InvalidRequestError("Request body must be an object");
  if (Object.hasOwn(body, "shardData")) {
    throw new InvalidRequestError("shardData is not supported");
  }
  if (body.evidenceExtractionMode != null && !["auto", "fast", "thorough"].some(mode=>body.evidenceExtractionMode === mode))
    throw new InvalidRequestError("evidenceExtractionMode must be auto, fast, or thorough");
  if (body.evidenceBudgetOverride != null && typeof body.evidenceBudgetOverride !== "boolean")
    throw new InvalidRequestError("evidenceBudgetOverride must be a boolean");
  return {
    ...request,
    ...(body.evidenceExtractionMode == null ? {} : {
      evidenceExtractionMode: body.evidenceExtractionMode as DataIngestionRequest["evidenceExtractionMode"],
    }),
    ...(body.evidenceBudgetOverride == null ? {} : {evidenceBudgetOverride:body.evidenceBudgetOverride}),
    ...(body.jobId == null ? {} : {jobId:requiredString(body,"jobId")}),
    containerName: requiredString(body, "containerName"),
    containerPath: requiredString(body, "containerPath"),
    documentName: requiredString(body, "documentName"),
    sourceUrl: requiredString(body, "sourceUrl"),
    ...(body.extractionContainerPath == null ? {} : {
      extractionContainerPath: requiredString(body, "extractionContainerPath"),
    }),
    isCurrentOrder: optionalBoolean(body, "isCurrentOrder"),
    isWebSite: optionalBoolean(body, "isWebSite"),
    ...(body.deferEvidenceExtraction === undefined ? {} : {
      deferEvidenceExtraction: optionalBoolean(body, "deferEvidenceExtraction"),
    }),
  };
}

function validateEvidenceIndexRequest(body: unknown): EvidenceIndexRequest {
  const request = validateBaseRequest(body);
  if (!isRecord(body)) throw new InvalidRequestError("Request body must be an object");
  return { ...request, jobId: requiredString(body, "jobId") };
}

function validateBaseRequest(body: unknown): BaseRequest {
  if (!isRecord(body)) throw new InvalidRequestError("Request body must be an object");
  const accountId = requiredString(body, "accountId");
  const sourceId = requiredStringOrNumber(body, "sourceId");
  const eventOrder = optionalEventOrder(body);
  return {
    accountId,
    sourceId,
    ...(eventOrder === undefined ? {} : { eventOrder }),
  };
}

function optionalEventOrder(body: Record<string, unknown>): EventOrder | undefined {
  const value = body.eventOrder;
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new InvalidRequestError("eventOrder must be an object");
  const enqueuedTicks = requiredDecimalString(value, "enqueuedTicks");
  const partitionId = requiredString(value, "partitionId");
  const sequenceNumber = requiredDecimalString(value, "sequenceNumber");
  return { enqueuedTicks, partitionId, sequenceNumber };
}

function requiredDecimalString(body: Record<string, unknown>, name: string): string {
  const value = requiredString(body, name);
  if (!/^\d+$/.test(value)) throw new InvalidRequestError(`${name} must be a decimal string`);
  return value;
}

function requestIdentity(body: unknown): { accountId?: string; sourceId?: string } {
  if (!isRecord(body)) return {};
  return {
    accountId: optionalStringOrNumber(body.accountId),
    sourceId: optionalStringOrNumber(body.sourceId),
  };
}

function requiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidRequestError(`${name} is required`);
  }
  return value;
}

function requiredStringOrNumber(body: Record<string, unknown>, name: string): string {
  const value = optionalStringOrNumber(body[name]);
  if (value === undefined) throw new InvalidRequestError(`${name} is required`);
  return value;
}

function optionalStringOrNumber(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function optionalBoolean(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new InvalidRequestError(`${name} must be a boolean`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}
