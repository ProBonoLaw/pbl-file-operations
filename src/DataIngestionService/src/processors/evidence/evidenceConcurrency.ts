import type { EvidenceTaskLane } from "./evidenceTaskQueue.js";

function concurrencySetting(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be between 1 and ${maximum}`);
  return value;
}

/** Keep delivery, admission, and model capacity aligned for the dedicated workers. */
export function repairConcurrency(): number {
  return concurrencySetting("EVIDENCE_REPAIR_CONCURRENCY", 5, 5);
}

export function sourceReconciliationConcurrency(): number {
  return concurrencySetting("EVIDENCE_RECONCILIATION_CONCURRENCY", 3, 3);
}

export function evidenceModelConcurrency(): number {
  return process.env.ROLE === "evidence-repair" ? Math.max(4, repairConcurrency()) : 4;
}

export function evidenceQueueConcurrency(lane: EvidenceTaskLane): number {
  return lane === "gather" ? concurrencySetting("EVIDENCE_GATHER_CONCURRENCY", 4, 4)
    : lane === "reconcile" ? sourceReconciliationConcurrency()
    : lane === "repair" ? repairConcurrency()
    : concurrencySetting("EVIDENCE_QUEUE_CONCURRENCY", lane === "finalize" ? 1 : 2, 16);
}

export function reconciliationAdmissionLimit(): number {
  return process.env.ROLE === "evidence-reconcile" ? sourceReconciliationConcurrency()
    : process.env.ROLE === "evidence-repair" ? repairConcurrency() : 2;
}
