import { AsyncLocalStorage } from "node:async_hooks";
import type { EvidenceCheckpointIdentity } from "./evidenceCheckpoint.js";
import type { GatheringUnit } from "./evidenceGathering.js";

/** Control flow: durable dependencies exist, but evidence is not ready for publication. */
export class EvidenceReviewPending extends Error {
  constructor() { super("Evidence review tasks are pending"); this.name = "EvidenceReviewPending"; }
}
export type ReviewComponent = "gathering" | "gathering-unit" | "fast-window" | "source-support" | "support-repair" | "classification" | "dates" | "classified-event-dates" | "attribution" | "canonicalization";
export interface EvidenceReviewTask {
  version: 1;
  component: ReviewComponent;
  context: { identity: EvidenceCheckpointIdentity; windowIndex: number };
  batchId: string;
  candidates: unknown[];
  sourceArtifact: string;
  initialReviewer: "reconciliation" | "independent" | "fallback";
  allowFailover: boolean;
  dateReview?: "resolve" | "defer" | "conflict";
  gathering?: GatheringUnit;
}
export interface EvidenceReviewDispatcher {
  result(task: Omit<EvidenceReviewTask, "sourceArtifact">, source: {pageContent: string; metadata: Record<string, unknown>}, maxAttempts?: number): Promise<unknown>;
}
const dispatcher = new AsyncLocalStorage<EvidenceReviewDispatcher>();
export const currentEvidenceReviewDispatcher = () => dispatcher.getStore();
export function withEvidenceReviewDispatcher<T>(value: EvidenceReviewDispatcher, run: () => T): T {
  return dispatcher.run(value, run);
}
export function evidenceQueueEnabled(): boolean {
  const value = process.env.EVIDENCE_REVIEW_EXECUTION_MODE?.trim() || "inline";
  if (value !== "inline" && value !== "queue") throw new Error("EVIDENCE_REVIEW_EXECUTION_MODE must be inline or queue");
  return value === "queue";
}

const taskOwnership = new AsyncLocalStorage<() => void>();
export function assertEvidenceTaskOwned(): void { taskOwnership.getStore()?.(); }
export function withEvidenceTaskOwnership<T>(assertOwned: () => void, run: () => T): T {
  return taskOwnership.run(assertOwned, run);
}

export interface EvidenceTaskCancellation {
  signal: AbortSignal;
  assertOpen(): Promise<void>;
}
const taskCancellation = new AsyncLocalStorage<EvidenceTaskCancellation>();
export const currentEvidenceTaskCancellation = () => taskCancellation.getStore();
export function withEvidenceTaskCancellation<T>(control: EvidenceTaskCancellation, run: () => T): T {
  return taskCancellation.run(control, run);
}
