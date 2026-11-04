import { z } from "zod";
import { createHash } from "node:crypto";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { canonicalPromptValue } from "./evidenceCompactPrompt.js";
import { correctionField, dateFields, listFields, scalarFields } from "./evidenceReconciliation.js";
import { facetsField } from "./evidenceTaxonomy.js";

/** LangChain otherwise names successive tools extract-1, extract-2, etc.
 * Name identical contracts identically across batches, accounts and processes;
 * a schema change gets a different name. Request IDs never enter this prefix. */
export function stableEvidenceResponseSchema(schema: z.AnyZodObject): {type: "object"; title: string; [key: string]: unknown} {
  const json = toJsonSchema(schema);
  if (!("type" in json) || json.type !== "object") throw new Error("Evidence response schema must be an object");
  const identity = createHash("sha256").update(JSON.stringify(canonicalPromptValue(json))).digest("hex").slice(0, 24);
  return {...json, type:"object", title:"evidence_response_" + identity};
}

// Each union arm has only required fields: native strict structured output
// cannot reliably omit optional properties. Keep the durable schemas unchanged.
export function compactCorrectionField() {
  return z.union([
    z.object({field: z.enum([...scalarFields, "sourceQuote"]), value: z.string()}).strict(),
    z.object({field: z.enum(dateFields), value: z.string().nullable()}).strict(),
    z.object({field: z.enum(listFields), value: z.array(z.string())}).strict(),
    z.object({field: z.literal("facets"), value: facetsField()}).strict(),
    z.object({field: z.literal("supportingQuotes"), value: correctionField().shape.supportingQuotes}).strict(),
  ]);
}

export function compactReconciliationSchema(event: z.AnyZodObject, fact: z.AnyZodObject, claim: z.AnyZodObject) {
  const base = () => ({candidateId: z.string()});
  const reason = () => z.string().min(1);
  return z.object({decisions: z.array(z.discriminatedUnion("action", [
    z.object({...base(), action: z.literal("keep")}).strict(),
    z.object({...base(), action: z.literal("correct"), reason: reason(),
      corrections: z.array(compactCorrectionField()).min(1)}).strict(),
    z.object({...base(), action: z.literal("replace"), reason: reason(),
      events: z.array(event), facts: z.array(fact), claims: z.array(claim)}).strict(),
    z.object({...base(), action: z.literal("unsupported"), reason: reason()}).strict(),
    z.object({...base(), action: z.literal("unresolved"), reason: reason()}).strict(),
  ]))});
}

export function expandCompactReconciliation(value: unknown, schema: ReturnType<typeof compactReconciliationSchema>) {
  // The non-strict tool path can omit empty replacement lists. Expand only
  // missing lists; explicit null/wrong types still fail schema validation.
  // An all-empty replace remains invalid in the existing decision validator.
  if (value && typeof value === "object" && !Array.isArray(value) && "action" in value && value.action === "replace") {
    const copy = {...value} as Record<string, unknown>;
    for (const field of ["events", "facts", "claims"]) if (!Object.hasOwn(copy, field)) copy[field] = [];
    value = copy;
  }
  const row = schema.shape.decisions.element.parse(value);
  const corrections = row.action === "correct" ? row.corrections.map(({field, value}) => ({
    field, text: typeof value === "string" ? value : null,
    people: (listFields as readonly string[]).includes(field) ? value : [],
    facets: field === "facets" ? value : [],
    supportingQuotes: field === "supportingQuotes" ? value : [],
  })) : [];
  return {
    candidateId: row.candidateId,
    verdict: row.action === "unsupported" || row.action === "unresolved" ? row.action : "supported",
    keepOriginal: row.action === "keep", reason: row.action === "keep" ? "" : row.reason,
    corrections,
    events: row.action === "replace" ? row.events : [],
    facts: row.action === "replace" ? row.facts : [],
    claims: row.action === "replace" ? row.claims : [],
  };
}

const compactDateParts = () => z.array(z.object({
  part: z.enum(["year", "month", "day", "season", "quarter"]), value: z.string().min(1),
}).strict()).describe("Only known parts; no duplicates. Empty means no calendar date.");

export function compactEventDateSchema() {
  const base = () => ({candidateId: z.string(), explanation: z.string().min(1)});
  return z.object({decisions: z.array(z.union([
    z.object({...base(), resolution: z.literal("unknown")}).strict(),
    z.object({...base(), resolution: z.literal("conflict")}).strict(),
    z.object({...base(), resolution: z.literal("unknown"),
      relation: z.enum(["unknown", "duration", "approximate"]), qualifier: z.string(),
      supportingQuotes: correctionField().shape.supportingQuotes}).strict(),
    z.object({...base(), resolution: z.literal("conflict"),
      supportingQuotes: correctionField().shape.supportingQuotes}).strict(),
    z.object({...base(), resolution: z.literal("dated"),
      relation: z.enum(["point", "duration", "bounded", "approximate"]),
      start: compactDateParts(), end: compactDateParts(), qualifier: z.string(),
      supportingQuotes: correctionField().shape.supportingQuotes}).strict(),
  ]))});
}

export function expandCompactEventDate(value: unknown) {
  const row = compactEventDateSchema().shape.decisions.element.parse(value);
  const parts = (values: {part: string; value: string}[] = []) => {
    if (new Set(values.map(part => part.part)).size !== values.length) throw new Error("Repeated compact date part");
    return {year: "", month: "", day: "", season: "", quarter: "",
      ...Object.fromEntries(values.map(({part, value}) => [part, value]))};
  };
  return {
    candidateId: row.candidateId, explanation: row.explanation,
    status: row.resolution,
    relation: "relation" in row ? row.relation : "unknown",
    start: parts(row.resolution === "dated" ? row.start : []),
    end: parts(row.resolution === "dated" ? row.end : []),
    qualifier: "qualifier" in row ? row.qualifier : "",
    supportingQuotes: "supportingQuotes" in row ? row.supportingQuotes : [],
  };
}

export const COMPACT_RECONCILIATION_INSTRUCTIONS = [
  "RESPONSE CONTRACT: Return one decision per candidateId using action: keep, correct, replace, unsupported, or unresolved. These actions encode the support verdict; do not emit keepOriginal or verdict fields.",
  "Use keep only for fully supported unchanged items, with candidateId and action alone. Use correct for small changes of the same evidence kind, with reason and corrections [{field,value}]. Each value replaces that complete field; null clears only a date, and [] explicitly clears a list. Preserve unchanged fields and all still-needed quotations.",
  "Use replace for splits, reclassification or complete rewrites, with reason and complete events/facts/claims arrays. Never mix corrections and replacements or copy unchanged items into replacements. For annotated events, changes to participants or citation indexes require a complete replacement.",
  "Use unsupported or unresolved with reason only. A supported duplicate still uses keep; identity deduplication occurs later. All material-field, atomicity and citation requirements still apply. A sourceQuote correction's value may be a supplied cite:primary ID; supportingQuotes values may use supplied cite:support IDs as quote. Passage-pool IDs are input references only, never output quotations or citation-choice IDs.",
].join("\n");

export const COMPACT_DATE_INSTRUCTIONS = "RESPONSE CONTRACT: Use resolution unknown or conflict with candidateId and explanation alone only when there are no supporting quotations or relative qualifiers to preserve. For unknown dates with supporting context or relative timing, also supply relation, qualifier (empty if none) and supportingQuotes. For conflict with supporting context, also supply supportingQuotes. Use dated with relation, start/end arrays of {part,value} for known date parts only, qualifier and supportingQuotes. [] means no date; do not repeat a part. These compact fields are expanded and subjected to the same calendar, citation and occurrence-link validation.";
