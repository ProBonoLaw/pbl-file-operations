import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withReconciliationBatch } from "../src/processors/evidence/evidenceReconciliationAdmission.js";
import { evidenceQueueConcurrency } from "../src/processors/evidence/evidenceConcurrency.js";
import { EvidenceReconciliationTimeoutError, reconciliationSignal } from "../src/processors/evidence/evidenceReconciliationDeadline.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
beforeEach(() => {
  vi.stubEnv("ROLE", "");
  vi.stubEnv("EVIDENCE_QUEUE_CONCURRENCY", "");
  vi.stubEnv("EVIDENCE_REPAIR_CONCURRENCY", "");
  vi.stubEnv("EVIDENCE_GATHER_CONCURRENCY", "");
  vi.stubEnv("EVIDENCE_RECONCILIATION_CONCURRENCY", "");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("parent reconciliation admission", () => {
  it.each([
    { role: "evidence-repair", setting: "", capacity: 5 },
    { role: "evidence-repair", setting: "4", capacity: 4 },
    { role: "evidence-repair", setting: "2", capacity: 2 },
    { role: "evidence-repair", setting: "1", capacity: 1 },
    { role: "evidence-review", setting: "4", capacity: 2 },
    { role: "evidence-reconcile", setting: "4", capacity: 3 },
    { role: "evidence-finalize", setting: "4", capacity: 2 },
    { role: "evidence-extraction", setting: "4", capacity: 2 },
  ])("admits $capacity tasks in $role with repair setting '$setting'", async ({ role, setting, capacity }) => {
    vi.useFakeTimers();
    vi.stubEnv("ROLE", role);
    vi.stubEnv("EVIDENCE_REPAIR_CONCURRENCY", setting);
    // The legacy delivery setting cannot accidentally throttle the repair lane.
    vi.stubEnv("EVIDENCE_QUEUE_CONCURRENCY", "2");
    if (role === "evidence-repair") expect(evidenceQueueConcurrency("repair")).toBe(capacity);
    const gates = Array.from({length: capacity + 1}, deferred);
    const started: number[] = [];
    const observed = vi.fn();
    const tasks = gates.map((gate, index) => withReconciliationBatch(1_000, async () => {
      started.push(index);
      await gate.promise;
    }, vi.fn(), observed));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual(Array.from({length: capacity}, (_, index) => index));
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({
        state: "queued", activeBatches: capacity, maxActiveBatches: capacity, waitingBatches: 1,
      }));
      gates[0].resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toHaveLength(capacity + 1);
    } finally {
      gates.forEach(gate => gate.resolve());
      await Promise.all(tasks);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps review and coordinator delivery defaults independent of repair capacity", () => {
    expect(evidenceQueueConcurrency("gather")).toBe(4);
    expect(evidenceQueueConcurrency("review")).toBe(2);
    expect(evidenceQueueConcurrency("reconcile")).toBe(3);
    expect(evidenceQueueConcurrency("finalize")).toBe(1);
    expect(evidenceQueueConcurrency("repair")).toBe(5);
    vi.stubEnv("EVIDENCE_QUEUE_CONCURRENCY", "3");
    expect(evidenceQueueConcurrency("review")).toBe(3);
    expect(evidenceQueueConcurrency("repair")).toBe(5);
  });

  it("configures gathering independently of generic delivery and repair caps", () => {
    vi.stubEnv("EVIDENCE_QUEUE_CONCURRENCY", "1");
    expect(evidenceQueueConcurrency("gather")).toBe(4);
    vi.stubEnv("EVIDENCE_GATHER_CONCURRENCY", "2");
    expect(evidenceQueueConcurrency("gather")).toBe(2);
    expect(evidenceQueueConcurrency("repair")).toBe(5);
  });

  it.each(["0", "-1", "1.5", "5", "NaN"])("rejects invalid gathering concurrency %s", setting => {
    vi.stubEnv("EVIDENCE_GATHER_CONCURRENCY",setting);
    expect(() => evidenceQueueConcurrency("gather")).toThrow("EVIDENCE_GATHER_CONCURRENCY must be between 1 and 4");
  });

  it.each(["0", "-1", "1.5", "6", "NaN"])("rejects invalid repair concurrency %s before admission", async setting => {
    vi.stubEnv("ROLE", "evidence-repair");
    vi.stubEnv("EVIDENCE_REPAIR_CONCURRENCY", setting);
    const operation = vi.fn();
    expect(() => evidenceQueueConcurrency("repair")).toThrow("EVIDENCE_REPAIR_CONCURRENCY must be between 1 and 5");
    await expect(withReconciliationBatch(100, operation, vi.fn())).rejects.toThrow("EVIDENCE_REPAIR_CONCURRENCY");
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])("aligns source delivery and admission at %s independently of other lanes", async capacity => {
    vi.stubEnv("ROLE", "evidence-reconcile");
    vi.stubEnv("EVIDENCE_RECONCILIATION_CONCURRENCY", String(capacity));
    vi.stubEnv("EVIDENCE_QUEUE_CONCURRENCY", "1");
    expect(evidenceQueueConcurrency("reconcile")).toBe(capacity);
    expect(evidenceQueueConcurrency("review")).toBe(1);
    const observed = vi.fn();
    await withReconciliationBatch(100, async () => undefined, vi.fn(), observed);
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({state:"admitted",maxActiveBatches:capacity}));
  });

  it.each(["0", "-1", "1.5", "4", "NaN"])("rejects invalid source concurrency %s before admission", async setting => {
    vi.stubEnv("ROLE", "evidence-reconcile");
    vi.stubEnv("EVIDENCE_RECONCILIATION_CONCURRENCY", setting);
    const operation = vi.fn();
    expect(() => evidenceQueueConcurrency("reconcile")).toThrow("EVIDENCE_RECONCILIATION_CONCURRENCY must be between 1 and 3");
    await expect(withReconciliationBatch(100, operation, vi.fn())).rejects.toThrow("EVIDENCE_RECONCILIATION_CONCURRENCY");
    expect(operation).not.toHaveBeenCalled();
  });

  it("admits two parents globally and starts queued deadlines only after admission", async () => {
    vi.useFakeTimers();
    const first = deferred(), second = deferred();
    const started: number[] = [];
    const timeout = vi.fn(), observed = vi.fn();
    const a = withReconciliationBatch(1_000, async () => { started.push(1); await first.promise; }, timeout);
    const b = withReconciliationBatch(1_000, async () => { started.push(2); await second.promise; }, timeout);
    const c = withReconciliationBatch(100, async () => {
      started.push(3);
      expect(reconciliationSignal()?.aborted).toBe(false);
      await sleep(90);
      return "completed";
    }, timeout, observed);
    await vi.advanceTimersByTimeAsync(500);
    expect(started).toEqual([1, 2]);
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ state: "queued", waitingBatches: 1 }));
    expect(timeout).not.toHaveBeenCalled();
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([1, 2, 3]);
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ state: "admitted", admissionWaitMs: 500, activeBatches: 2 }));
    await vi.advanceTimersByTimeAsync(90);
    expect(await c).toBe("completed");
    second.resolve();
    await Promise.all([a, b]);
    expect(timeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets concurrent nested reviews share occupied parent slots and deadlines", async () => {
    const observed = vi.fn();
    const signals: AbortSignal[] = [];
    const result = await Promise.all([1, 2].map(parent => withReconciliationBatch(1_000, async () => {
      const signal = reconciliationSignal()!;
      signals.push(signal);
      return Promise.all([1, 2].map(child => withReconciliationBatch(1, async () => {
        expect(reconciliationSignal()).toBe(signal);
        return parent * 10 + child;
      }, vi.fn(), observed)));
    }, vi.fn(), observed)));
    expect(result).toEqual([[11, 12], [21, 22]]);
    expect(signals[0]).not.toBe(signals[1]);
    expect(observed.mock.calls.filter(([event]) => event.state === "admitted")).toHaveLength(2);
  });

  it("transfers a timed-out parent's slot to its oldest waiter", async () => {
    vi.useFakeTimers();
    const second = deferred(), late = deferred();
    const order: number[] = [];
    const first = withReconciliationBatch(100, () => late.promise, vi.fn()).catch(error => error);
    const other = withReconciliationBatch(1_000, () => second.promise, vi.fn());
    const queued = [3, 4, 5].map(value => withReconciliationBatch(100, async () => { order.push(value); return value; }, vi.fn()));
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toBeInstanceOf(EvidenceReconciliationTimeoutError);
    expect(await Promise.all(queued)).toEqual([3, 4, 5]);
    expect(order).toEqual([3, 4, 5]);
    second.resolve(); late.resolve();
    await other;
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases admission after execution or admission-observer failures", async () => {
    const failed = withReconciliationBatch(100, async () => { throw new Error("review failed"); }, vi.fn());
    const observerFailed = withReconciliationBatch(100, async () => "unused", vi.fn(), event => {
      if (event.state === "admitted") throw new Error("observer failed");
    });
    await expect(failed).rejects.toThrow("review failed");
    await expect(observerFailed).rejects.toThrow("observer failed");
    expect(await Promise.all([1, 2].map(value => withReconciliationBatch(100, async () => value, vi.fn())))).toEqual([1, 2]);
  });
});
