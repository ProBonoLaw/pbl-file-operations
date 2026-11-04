import { assertEvidenceTaskOwned } from "./evidenceAsync.js";
import { AsyncLocalStorage } from "node:async_hooks";

import type { EvidenceCheckpointWriteGuard } from "./evidenceCheckpoint.js";

interface ReconciliationScope {
  signal: AbortSignal;
  closed: boolean;
  publications: Map<string, () => Promise<void>>;
}
const currentDeadline = new AsyncLocalStorage<ReconciliationScope>();

export class EvidenceReconciliationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Evidence reconciliation exceeded its ${timeoutMs}ms batch deadline`);
    this.name = "EvidenceReconciliationTimeoutError";
  }
}

export class EvidenceGatheringTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Evidence gathering exceeded its ${timeoutMs}ms invocation deadline`);
    this.name = "EvidenceGatheringTimeoutError";
  }
}

export function reconciliationSignal(): AbortSignal | undefined { return currentDeadline.getStore()?.signal; }
export function assertReconciliationActive(): void {
  assertEvidenceTaskOwned();
  reconciliationSignal()?.throwIfAborted();
  if (currentDeadline.getStore()?.closed) throw new Error("Reconciliation scope has already closed");
}

/** Only uploads acknowledged while the batch is active may become restorable. */
export function reconciliationCheckpointGuard(): EvidenceCheckpointWriteGuard | undefined {
  const scope = currentDeadline.getStore();
  if (!scope) return undefined;
  const assertActive = () => {
    assertEvidenceTaskOwned();
    scope.signal.throwIfAborted();
    if (scope.closed) throw new Error("Reconciliation scope has already closed");
  };
  return { abortSignal: scope.signal, assertActive,
    deferPublication: (key, publish) => {
      assertActive();
      scope.publications.set(key, publish);
    } };
}

/** Also stops waiting if a provider fails to settle its promise on cancellation. */
export function awaitWithReconciliationSignal<T>(pending: Promise<T>, signal = reconciliationSignal()): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    pending.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(signal.aborted ? signal.reason : error);
    });
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, {once:true});
  });
}

/** Repairs and nested fallbacks inherit one deadline; concurrent batches stay independent. */
export async function withReconciliationDeadline<T>(timeoutMs: number, operation: () => Promise<T>,
  onTimeout: () => void): Promise<T> {
  return withEvidenceDeadline(timeoutMs, new EvidenceReconciliationTimeoutError(timeoutMs), operation, onTimeout);
}

/** Gathering starts its deadline after acquiring a model permit. */
export async function withGatheringDeadline<T>(timeoutMs: number, operation: () => Promise<T>,
  onTimeout: () => void): Promise<T> {
  return withEvidenceDeadline(timeoutMs, new EvidenceGatheringTimeoutError(timeoutMs), operation, onTimeout);
}

async function withEvidenceDeadline<T>(timeoutMs: number, timeoutError: Error, operation: () => Promise<T>,
  onTimeout: () => void): Promise<T> {
  assertReconciliationActive();
  if (reconciliationSignal()) return operation();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  timer.unref();
  const scope: ReconciliationScope = {signal: controller.signal, closed: false, publications: new Map()};
  let outcome: {value: T} | {error: unknown};
  try {
    outcome = {value: await currentDeadline.run(scope, () =>
      awaitWithReconciliationSignal(Promise.resolve().then(operation)))};
  } catch (error) {
    outcome = {error};
    if (controller.signal.aborted) {
      try { onTimeout(); } catch (error) { outcome = {error}; }
    }
  } finally {
    clearTimeout(timer);
    scope.closed = true;
  }
  // Close the acknowledged set before any publication I/O. Late uploads can
  // never join it, even if the SDK/server ignores cancellation. Earlier good
  // stages survive a sibling timeout; unfinished uploads remain private.
  const published = await Promise.allSettled([...scope.publications.values()].map(async publish => {
    assertEvidenceTaskOwned();
    await publish();
    assertEvidenceTaskOwned();
  }));
  if ("error" in outcome) throw outcome.error;
  const failure = published.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return outcome.value;
}
