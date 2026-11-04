/** Provider refusals are deterministic for the same prompt; retrying the same model wastes the budget. */
export function isEvidenceContentFilter(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const failure = current as {code?: unknown; reason?: unknown; cause?: unknown; error?: unknown; innererror?: unknown};
    if (failure.code === "content_filter" || failure.reason === "content_filter") return true;
    current = failure.cause ?? failure.error ?? failure.innererror;
  }
  return false;
}
