import {setImmediate as nextTurn} from "node:timers/promises";
import {currentEvidenceTaskCancellation} from "./evidenceAsync.js";
import {assertReconciliationActive} from "./evidenceReconciliationDeadline.js";

/** The same deterministic steps serve synchronous callers and queue workers. */
export function finishEvidenceComputation<T>(steps: Generator<void,T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Let HTTP health probes, lease renewals and cancellation run during CPU work. */
export async function runEvidenceComputation<T>(steps: Generator<void,T>): Promise<T> {
  let yieldAt = performance.now() + 20;
  for (;;) {
    assertReconciliationActive();
    currentEvidenceTaskCancellation()?.signal.throwIfAborted();
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() >= yieldAt) {
      await nextTurn();
      yieldAt = performance.now() + 20;
    }
  }
}
