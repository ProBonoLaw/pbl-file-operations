import { z } from "zod";

export const DecisionEnvelopeSchema = z.object({ decisions: z.array(z.unknown()) });

/** Reject ambiguous/malformed rows individually; foreign IDs never become evidence. */
export function partitionDecisions<T extends { candidateId: string }>(
  ids: readonly string[], rows: readonly unknown[], validate: (value: unknown) => T,
): { valid: T[]; errors: Map<string, string>; unexpectedIds: string[] } {
  const expected = new Set(ids);
  const grouped = new Map<string, unknown[]>();
  const unexpectedIds: string[] = [];
  for (const row of rows) {
    const id = row && typeof row === "object" && "candidateId" in row ? row.candidateId : undefined;
    if (typeof id !== "string" || !expected.has(id)) {
      unexpectedIds.push(typeof id === "string" ? id : "[missing ID]");
      continue;
    }
    grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  const valid: T[] = [], errors = new Map<string, string>();
  for (const id of ids) {
    const matches = grouped.get(id) ?? [];
    if (matches.length !== 1) {
      errors.set(id, `Reconciliation must account for every candidate exactly once: ${id} has ${matches.length} decisions`);
      continue;
    }
    try { valid.push(validate(matches[0])); }
    catch (error) { errors.set(id, error instanceof Error ? error.message : String(error)); }
  }
  return { valid, errors, unexpectedIds };
}
