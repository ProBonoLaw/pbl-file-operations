export interface EvidenceRetryPolicy {
  pagesPerGroup: number;
  retriesPerGroup: number;
}

export interface EvidenceRetryBudget extends EvidenceRetryPolicy {
  pageCount: number | null;
  maxAttempts: number;
}

export function positiveIntegerSetting(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  const parsed = value ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function evidenceRetryPolicy(): EvidenceRetryPolicy {
  return {
    pagesPerGroup: positiveIntegerSetting("EVIDENCE_RETRY_PAGE_GROUP_SIZE", 20),
    retriesPerGroup: positiveIntegerSetting("EVIDENCE_RETRIES_PER_PAGE_GROUP", 3),
  };
}

export function evidenceRetryBudget(policy: EvidenceRetryPolicy, pageCount: number | null = null): EvidenceRetryBudget {
  if (![policy.pagesPerGroup,policy.retriesPerGroup].every(value=>Number.isSafeInteger(value)&&value>0))
    throw new Error("Invalid evidence retry policy");
  if (pageCount !== null && (!Number.isSafeInteger(pageCount) || pageCount < 0))
    throw new Error("Evidence page count must be a nonnegative integer");
  const maxAttempts = 1 + Math.max(1, Math.ceil((pageCount ?? 0) / policy.pagesPerGroup)) * policy.retriesPerGroup;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 2) throw new Error("Invalid evidence retry budget");
  return { pagesPerGroup: policy.pagesPerGroup, retriesPerGroup: policy.retriesPerGroup, pageCount, maxAttempts };
}
