import { assertReconciliationActive, reconciliationSignal, withReconciliationDeadline } from "./evidenceReconciliationDeadline.js";

import { reconciliationAdmissionLimit } from "./evidenceConcurrency.js";

// Shared across sources and extractor instances in this worker process. A slot
// covers the entire parent review, including its concurrent follow-up components.
let active = 0;
const waiting: Array<() => void> = [];

function release(): void {
  const next = waiting.shift();
  if (next) next(); // Transfer this slot to the oldest waiter.
  else active--;
}

export type ReconciliationAdmissionEvent = {
  state: "queued" | "admitted" | "released";
  activeBatches: number;
  maxActiveBatches: number;
  waitingBatches: number;
  admissionWaitMs: number;
};

/** Admission wait precedes the deadline; nested reviews retain the parent's slot. */
export async function withReconciliationBatch<T>(timeoutMs: number, operation: () => Promise<T>,
  onTimeout: () => void, observe?: (event: ReconciliationAdmissionEvent) => void): Promise<T> {
  assertReconciliationActive();
  if (reconciliationSignal()) return operation();

  const maxActiveBatches = reconciliationAdmissionLimit();
  const queuedAt = Date.now();
  const report = (state: ReconciliationAdmissionEvent["state"]) => observe?.({ state,
    activeBatches: active,
    maxActiveBatches,
    waitingBatches: waiting.length + (state === "queued" && active >= maxActiveBatches ? 1 : 0),
    admissionWaitMs: Date.now() - queuedAt });
  report("queued");
  if (active < maxActiveBatches) active++;
  else await new Promise<void>(resolve => { waiting.push(resolve); });
  const admissionWaitMs = Date.now() - queuedAt;
  try {
    report("admitted");
    return await withReconciliationDeadline(timeoutMs, operation, onTimeout);
  } finally {
    release();
    observe?.({ state: "released", activeBatches: active, maxActiveBatches, waitingBatches: waiting.length, admissionWaitMs });
  }
}
