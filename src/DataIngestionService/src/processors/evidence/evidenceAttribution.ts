import { z } from "zod";

/** Labels requiring source review, never a rule assigning the document author. */
export function needsClaimantReview(value: string): boolean {
  const label = value.trim().replace(/[.!]+$/, "");
  return /^(?:unknown\b.*|null|n\/a|not (?:known|specified|identified)|unspecified|unidentified|)$/i.test(label)
    || /^(?:the\s+)?(?:(?:report|document|evaluation|assessment)\s+)?(?:author|writer|examiner|evaluator|clinician)(?:\s+of\s+(?:the\s+)?(?:report|document|evaluation|assessment))?$/i.test(label);
}

/** A review lead, never an automatic claimant assignment. */
export function needsReportingChainReview(statement: string, sourceQuote: string, precedingContext: string): boolean {
  return /\b(?:said|stated|testified|reported|recounted|according to)\b/i.test(precedingContext + " " + sourceQuote)
    && /\b(?:said|told|instructed|ordered|directed|informed|asked|wrote|asserted|claimed)\b/i.test(statement);
}

// Attribution review may change only the claimant and add cited support.
export const ClaimAttributionDecisionSchema = z.object({
  candidateId: z.string(),
  status: z.enum(["resolved", "unknown"]),
  claimant: z.string().describe("Exact source name of the person/entity making this claim, or empty if unresolved."),
  explanation: z.string().min(1).describe("Explain the identity AND its link to this statement; distinguish author from quoted speaker."),
  supportingQuotes: z.array(z.object({pageNumber:z.number().int().nonnegative(),quote:z.string().min(1)})),
}).strict();
export const ClaimAttributionResponseSchema = z.object({decisions:z.array(ClaimAttributionDecisionSchema)});
export type ClaimAttributionDecision = z.infer<typeof ClaimAttributionDecisionSchema>;

export function validateClaimAttributionDecision(value: unknown): ClaimAttributionDecision {
  const decision = ClaimAttributionDecisionSchema.parse(value);
  decision.claimant = decision.claimant.trim();
  if (decision.status === "unknown") {
    if (decision.claimant) throw new Error("Unresolved attribution cannot assign a claimant");
    // No attribution or evidence fields change. Diagnostic search quotations
    // are not supporting evidence and must not replace the original citations.
    decision.supportingQuotes = [];
  } else {
    const normalized = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
    const name = normalized(decision.claimant).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    const quotedName = new RegExp(`(^|[^\\p{L}\\p{N}])${name}(?=$|[^\\p{L}\\p{N}])`,"u");
    if (needsClaimantReview(decision.claimant) || !decision.supportingQuotes.some(quote =>
      quotedName.test(normalized(quote.quote)))) {
      throw new Error("Resolved claimant requires their source name in a supporting quotation");
    }
  }
  return decision;
}
