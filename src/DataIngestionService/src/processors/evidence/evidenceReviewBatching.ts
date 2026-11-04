export type ReviewBatchMode = "fixed" | "tokenAware";
export const FIXED_REVIEW_BATCH_SIZE = 16;
export const TOKEN_AWARE_MAX_CANDIDATES = 24;
export const TOKEN_AWARE_CANDIDATE_TOKEN_BUDGET = 5_000;

export type ReviewBatch<T> = { items: T[]; estimatedCandidateTokens?: number };

/** Keep input order and every candidate. A single oversized candidate gets its own batch. */
export function createReviewBatches<T>(items: readonly T[], mode: ReviewBatchMode,
  estimateTokens?: (item: T) => number): ReviewBatch<T>[] {
  if (mode === "fixed") {
    return Array.from({ length: Math.ceil(items.length / FIXED_REVIEW_BATCH_SIZE) }, (_, index) => ({
      items: items.slice(index * FIXED_REVIEW_BATCH_SIZE, (index + 1) * FIXED_REVIEW_BATCH_SIZE),
    }));
  }
  if (!estimateTokens) throw new Error("Token-aware review batching requires a token estimator");
  const batches: ReviewBatch<T>[] = [];
  let current: T[] = [];
  let tokens = 0;
  const flush = () => {
    if (current.length) batches.push({ items: current, estimatedCandidateTokens: tokens });
    current = [];
    tokens = 0;
  };
  for (const item of items) {
    const estimate = estimateTokens(item);
    if (!Number.isSafeInteger(estimate) || estimate < 0) throw new Error("Invalid review candidate token estimate");
    if (current.length && (current.length >= TOKEN_AWARE_MAX_CANDIDATES
      || tokens + estimate > TOKEN_AWARE_CANDIDATE_TOKEN_BUDGET)) flush();
    current.push(item);
    tokens += estimate;
  }
  flush();
  return batches;
}
