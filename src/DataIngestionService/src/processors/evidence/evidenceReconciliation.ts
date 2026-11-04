import { z } from "zod";
import { facetsField } from "./evidenceTaxonomy.js";

/** Missing change lists mean no proposed changes, never permission to keep an item.
 * The caller must still validate the full decision, its verdict/payload consistency,
 * and every resulting evidence field and citation. Explicit null/wrong types survive
 * unchanged so schema validation rejects them.
 */
export function normalizeReconciliationLists(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const decision = { ...value } as Record<string, unknown>;
  for (const key of ["corrections", "events", "facts", "claims"]) {
    if (!Object.hasOwn(decision, key)) decision[key] = [];
  }
  return decision;
}

export const scalarFields = ["what", "statement", "claimant", "claimType", "polarity", "eventType", "factType", "where", "why"] as const;
export const dateFields = [
  "whenStartedYear", "whenStartedMonth", "whenStartedDay", "whenStartedSeason", "whenStartedQuarter",
  "whenEndedYear", "whenEndedMonth", "whenEndedDay", "whenEndedSeason", "whenEndedQuarter",
  "asOfYear", "asOfMonth", "asOfDay",
] as const;
export const listFields = ["who", "subject", "reportedBy"] as const;

// Fresh schema instances avoid nested $ref entries rejected by Azure.
export const correctionField = () => z.object({
  field: z.enum([...scalarFields, ...dateFields, ...listFields, "facets", "sourceQuote", "supportingQuotes"]),
  text: z.string().nullable().describe("Replacement scalar or sourceQuote; null clears a date. Null for array fields."),
  people: z.array(z.string()).describe("Complete replacement for who, subject, or reportedBy. Empty for other fields."),
  facets: facetsField().describe("Complete replacement for facets. Empty for other fields."),
  supportingQuotes: z.array(z.object({ pageNumber: z.number().int().nonnegative(), quote: z.string().min(1) }))
    .describe("Complete replacement for supportingQuotes. Empty for other fields. Preserve every still-needed citation."),
}).strict();
export type EvidenceCorrection = z.infer<ReturnType<typeof correctionField>>;

/** Apply explicit field replacements, then validate the complete original kind. */
export function applyEvidenceCorrections<T extends z.AnyZodObject>(
  original: z.infer<T>, corrections: readonly EvidenceCorrection[], schema: T,
): z.infer<T> {
  const patched: Record<string, unknown> = { ...original };
  if (original.eventStructure && corrections.some(correction =>
    ["who", "sourceQuote", "supportingQuotes"].includes(correction.field))) {
    throw new Error("An annotated event needs a complete replacement when participant or citation indexes change");
  }
  const changed = new Set<string>();
  for (const correction of corrections) {
    const { field, text, people, facets, supportingQuotes } = correctionField().parse(correction);
    if (!(field in schema.shape) || changed.has(field)) throw new Error(`Invalid or repeated evidence correction field: ${field}`);
    changed.add(field);
    if (field === "supportingQuotes") {
      if (text !== null || people.length || facets.length) throw new Error("Invalid supportingQuotes correction");
      patched[field] = supportingQuotes;
    } else if (field === "facets") {
      if (text !== null || people.length || supportingQuotes.length) throw new Error("Invalid facets correction");
      patched[field] = facets;
    } else if ((listFields as readonly string[]).includes(field)) {
      if (text !== null || facets.length || supportingQuotes.length) throw new Error("Invalid people correction");
      patched[field] = people;
    } else {
      if (people.length || facets.length || supportingQuotes.length
        || (text === null && !(dateFields as readonly string[]).includes(field))) throw new Error(`Invalid scalar correction: ${field}`);
      if ((dateFields as readonly string[]).includes(field) && text !== null
        && text.trim() && !/^(null|unknown|n\/a|not applicable)$/i.test(text.trim())) {
        const limit = field.endsWith("Month") ? 12 : field.endsWith("Day") ? 31 : null;
        if ((field.endsWith("Year") || limit !== null)
          && (!/^[+-]?\d+$/.test(text.trim()) || !Number.isSafeInteger(Number(text))
            || (limit !== null && (Number(text) < 1 || Number(text) > limit)))) {
          throw new Error(`Invalid corrected date part: ${field}`);
        }
      }
      patched[field] = text;
    }
  }
  return schema.parse(patched);
}
