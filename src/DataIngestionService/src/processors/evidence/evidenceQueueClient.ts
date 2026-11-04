import { createHash } from "node:crypto";
import type { RequestContext } from "../../requestContext.js";
import type { FileIngestionWork } from "../../models/request.js";
import { telemetryClient } from "../appInsights.js";
import { BlobEvidenceTaskStore, EvidenceTaskQueue, StorageEvidenceTaskTransport } from "./evidenceTaskQueue.js";

export function createEvidenceTaskQueue(): EvidenceTaskQueue {
  return new EvidenceTaskQueue(new BlobEvidenceTaskStore(), new StorageEvidenceTaskTransport(),
    (name, task) => telemetryClient.trackEvent({name, properties: {...task.definition.correlation, taskId: task.id,
      lane: task.lane, state: task.status, attempt: String(task.attempts), errorType: task.error ?? ""},
      measurements: {ageMs: Date.now() - task.createdAt}}));
}
export async function enqueueEvidenceJob(queue: EvidenceTaskQueue, request: FileIngestionWork): Promise<void> {
  const correlation: RequestContext = {accountId: request.accountId, sourceId: request.sourceId, jobId: request.jobId,
    evidenceBudgetOverride:request.evidenceBudgetOverride,
    operationId: createHash("sha256").update(request.jobId).digest("hex").slice(0, 32)};
  await queue.submit({lane: "finalize", payload: request, correlation, maxAttempts: 3, allowFailover: false});
}
