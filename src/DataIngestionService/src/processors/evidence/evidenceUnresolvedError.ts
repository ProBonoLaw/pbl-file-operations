/** Review exhausted its in-component repairs and has no source-validated result. */
export class EvidenceUnresolvedError extends Error {
  constructor(pageNumber: number) {
    super(`Unresolved evidence remains on source page ${pageNumber}; document indexing was not completed`);
    this.name = "EvidenceUnresolvedError";
  }
}

export function isEvidenceUnresolvedError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    if (current instanceof EvidenceUnresolvedError) return true;
    visited.add(current);
    current = (current as {cause?: unknown}).cause;
  }
  return false;
}
