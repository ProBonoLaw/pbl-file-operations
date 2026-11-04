import { z } from "zod";
import { expandCitationChoices, type CitationChoice } from "./evidenceCitationResolution.js";

export const FAST_DISCOVERY_INSTRUCTIONS = [
  "Within the candidate budget, prioritize explicit accommodations, obligations, actionable recommendations, material recorded measurements and key occurrences ahead of generic background. Inspect every numbered/bulleted item before choosing candidates; do not stop at a section's headline when budget remains.",
  "Return each independently actionable recommendation as its own claim, including separate actions within a sentence. Carry its stated conditions and shared subject. Do not bundle a whole plan, list or section into one item. Preserve distinct optional alternatives and all outcomes of the same action.",
  "A list of intervention options must become separate optional recommendations, not one claim ending in 'including A, B and C'. Retain 'or', 'can' and 'such as' as optionality rather than making every option mandatory. Prefer these actionable items over generic effectiveness statements when the budget is tight. A combination explicitly required together may remain one recommendation.",
  "Leave optional participants, place, cause and dates unknown when not stated. A recommendation addressed to a child does not identify its implementer; do not invent teachers, parents or other responsible actors.",
  "Preserve causal scope. A risk factor explaining someone's concern does not establish the cause of the condition they are concerned about. When attachment is ambiguous, retain the source sentence verbatim rather than introducing 'because' or another causal paraphrase.",
  "A date belongs only to the occurrence it explicitly dates. Do not carry an incident's date into later removal, treatment or legal action. Keep separate sessions as separate events, never turn several listed dates into a continuous start/end interval. An event requires a source-supported calendar date; express an otherwise supported undated occurrence as an undatedOccurrence fact or an attributed claim. Leave unresolved timing unknown.",
  "When a quote repeats in a list or section, cite its nearest exact Markdown heading as a supportingQuote and include enough exact surrounding text to identify the occurrence. A longer quote may support one atomic assertion; it is not a reason to bundle neighboring assertions. Anchor in the target, with exact supporting quotes for any necessary page continuation.",
  "Each quotation must be one contiguous source substring. Put a heading alone in its own supportingQuote; never concatenate a heading with a nonadjacent bullet, skip intervening text inside a quote, or join text across pages.",
].join("\n");

export const FAST_REVIEW_INSTRUCTIONS = [
  "FAST REVIEWER: Assess each candidate independently against the supplied source and cited passages. Return exactly one decision per candidate ID. A quotation match alone does not establish support for its material fields. Check the proposition, evidence kind, participants, original speaker, negation, modality, dates, location and cause.",
  "Preserve an otherwise supported assertion when only optional metadata is unsupported: use clearFields to erase that field, not reject the whole candidate. Incorrect optional taxonomy facets can be cleared with facets; this does not change the evidence kind or its eventType, factType or claimType. who lists people materially involved; it does not establish who is responsible for an action. Never invent responsible actors. Clearing who cannot fix an unsupported actor still named in the statement.",
  "Check each date against the exact event or measurement it dates. A date on a nearby incident, report, signature or related event does not date subsequent actions. Clear whenStarted, whenEnded or asOf when that link is not explicit or the supplied date validation fails. Never substitute dates or turn separate sessions into an ongoing interval. If an event loses its last supported date, the application retains its assertion as an undated fact after review.",
  "Preserve causal scope: a condition explaining concern does not establish what caused the underlying difficulty. If a paraphrase changes cause, attribution, negation or modality, useSourceWording may replace the assertion with its entire original primary sourceQuote, verbatim. Choose this only when that quote expresses a supported assertion of the same evidence kind with the remaining metadata. Otherwise reject or mark uncertain.",
  "When citationChoices are provided, an exact quotation occurs more than once. Select the offered citationIds for the occurrence whose heading and context support this candidate, at most one ID per citation field. The application expands that occurrence with verified source characters. Never guess a section or select a different assertion. If the intended occurrence is unclear, mark uncertain. Use an empty citationIds array when no choice is needed.",
  "These are the only adjustments allowed: clear the listed optional fields, restore the entire original primary quote as assertion text, or select an offered exact occurrence. Do not rewrite quotes, add facts, enrich fields, discover candidates, split items or change their kind. A supported verdict means every remaining field is supported after the requested adjustments; a brief reason must identify any adjustment. Use empty clearFields and false useSourceWording for an unchanged item.",
  "If the core proposition, classification or claimant is unsupported, reject or mark uncertain; clearing metadata alone is insufficient. An allegation supports an attributed claim, not the alleged event as fact. Assess source fidelity, not real-world truth.",
].join("\n");

export const FastReviewDecisionSchema = z.object({
  candidateId: z.string(),
  verdict: z.enum(["supported", "unsupported", "uncertain"]),
  reason: z.string(),
  clearFields: z.array(z.enum(["who", "where", "why", "facets", "whenStarted", "whenEnded", "asOf"]))
    .describe("Optional metadata to clear because it is unsupported. Date groups clear all their parts. No new values or changes to claimant, subject, reporter or kind."),
  useSourceWording: z.boolean().describe("Replace statement/what with the entire original primary sourceQuote verbatim, only if supported in the same kind. No new text or quotation changes."),
  citationIds: z.array(z.string()).describe("Only IDs offered in this candidate's citationChoices, at most one per field. Empty if none. These select an existing exact occurrence; they cannot introduce a new quote."),
}).strict();
export const FastReviewSchema = z.object({ decisions: z.array(FastReviewDecisionSchema) });
export type FastReviewDecision = z.infer<typeof FastReviewDecisionSchema>;

/** Deletions and a copy of already validated source text; never model-written replacements. */
export function applyFastReviewDecision(original: Record<string, unknown>, value: FastReviewDecision): Record<string, unknown> {
  const decision = FastReviewDecisionSchema.parse(value);
  if (decision.verdict !== "supported") throw new Error("Fast adjustment requires supported remaining evidence");
  if (new Set(decision.clearFields).size !== decision.clearFields.length) throw new Error("Repeated fast adjustment field");
  if ((decision.clearFields.length || decision.useSourceWording || decision.citationIds.length) && !decision.reason.trim())
    throw new Error("Fast adjustment requires a reason");
  const item = { ...original };
  for (const field of decision.clearFields) {
    if (["whenStarted", "whenEnded", "asOf"].includes(field)) {
      const keys = Object.keys(item).filter(key => new RegExp(`^${field}(Year|Month|Day|Season|Quarter)$`).test(key));
      if (!keys.length) throw new Error("Date group does not exist on this evidence kind");
      for (const key of keys) item[key] = null;
    } else {
      if (!(field in item)) throw new Error("Optional field does not exist on this evidence kind");
      item[field] = field === "who" || field === "facets" ? [] : "Unknown";
    }
  }
  if (decision.useSourceWording) {
    if (typeof item.sourceQuote !== "string" || !item.sourceQuote.trim()) throw new Error("Missing primary source quote");
    item["statement" in item ? "statement" : "what"] = item.sourceQuote;
  }
  return item;
}

export function selectFastCitationChoices<T extends {sourceQuote:string;supportingQuotes:{pageNumber:number;quote:string}[]}>(
  original: T, ids: readonly string[], choices: readonly CitationChoice[],
): T {
  const item = {...original,supportingQuotes:original.supportingQuotes.map(quote=>({...quote}))};
  const fields = new Set<string>();
  for (const id of ids) {
    const choice = choices.find(choice=>choice.id===id && !choice.reason);
    if (!choice) throw new Error("Fast citation ID was not offered for this candidate");
    const field = choice.field === "sourceQuote" ? "primary" : `support:${choice.supportingIndex}`;
    if (fields.has(field)) throw new Error("Multiple choices for one fast citation field");
    fields.add(field);
    if (choice.field === "sourceQuote") item.sourceQuote = id;
    else {
      const quote = choice.supportingIndex === undefined ? undefined : item.supportingQuotes[choice.supportingIndex];
      if (!quote || quote.pageNumber !== choice.pageNumber) throw new Error("Invalid fast supporting citation field");
      quote.quote = id;
    }
  }
  return expandCitationChoices(item, choices);
}

/** Source presence is a necessary check for optional labels, never proof of their relationship. */
export function filterFastParticipants<T extends Record<string, unknown>>(item: T, sourceTexts: readonly string[]): {
  item: T; removedCount: number; unsupportedInStatement: boolean;
} {
  if (!Array.isArray(item.who)) return {item,removedCount:0,unsupportedInStatement:false};
  const normalize = (value:string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
  const texts = sourceTexts.map(text=>` ${normalize(text)} `);
  const removed = item.who.filter((person:string)=>!normalize(person)
    || !texts.some(text=>text.includes(` ${normalize(person)} `)));
  const statement = ` ${normalize(String(item.statement ?? item.what ?? ""))} `;
  return {item:{...item,who:item.who.filter(person=>!removed.includes(person))},removedCount:removed.length,
    unsupportedInStatement:removed.some((person:string)=>!!normalize(person) && statement.includes(` ${normalize(person)} `))};
}
