import { z } from "zod";
import { normalizeIdentityExcerpt, statementDetailLosses } from "./evidenceAtomicity.js";
import { evidencePrimarySpan, identityText, sharedPrimaryPassage } from "./evidencePageIdentity.js";
import type { EvidenceSource } from "./evidenceSource.js";

export const SemanticAssessmentSchema = z.object({
  relationship: z.enum(["equivalent", "left_entails_right", "right_entails_left", "contradictory", "related", "unrelated", "uncertain"])
    .describe("Entailment compares the extracted assertions, not everything in their citations. One-way entailment does not establish atomic identity."),
  contextualDetails: z.array(z.object({
    side: z.enum(["left", "right"]),
    detail: z.string().describe("Exact excerpt from this side's OnlyDetails inventory."),
    kind: z.enum(["attribution", "participant_reference", "participant_description", "occasion", "instrument", "purpose", "reference"]),
    sourceQuote: z.string().describe("Exact cited source excerpt supporting this context for the SAME assertion."),
    explanation: z.string().describe("Why this identifies, describes or contextualizes the same participant/assertion, without adding an independent action, result, property or causal conclusion. A participant_description must be explicitly supported in the source, compatible with the other record, and retained in the survivor."),
  })).describe("Only source-supported context about the SAME atomic assertion. Do not reclassify an independent proposition as context to permit a merge."),
});
export type SemanticAssessment = z.infer<typeof SemanticAssessmentSchema>;
type Metadata = Record<string, unknown>;

function includesDescription(quote: string, detail: string): boolean {
  const tokens = (text: string) => identityText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  const source = tokens(quote), description = tokens(detail);
  // Source excerpts remain exact. Descriptor wording may format the same words
  // as "five-year-old boy" versus "five year old boy"; require the complete
  // ordered tokens so a substring such as boy/boyfriend cannot supply support.
  return description.length > 0
    && source.some((_, index) => description.every((word, offset) => source[index + offset] === word));
}

/** Explicit entailment cannot authorize merging a compound with its component.
 * Atomic identity is separately required by the caller. Inventory direction
 * must agree even when a model returns an inconsistent assessment.
 */
export function semanticCoverageAllowsMerge(assessment: SemanticAssessment | undefined,
  leftDetails: readonly string[], rightDetails: readonly string[]): boolean {
  if (!assessment) return true; // Legacy assessments retain the original guards.
  switch (assessment.relationship) {
    case "equivalent": return !leftDetails.length && !rightDetails.length;
    case "left_entails_right": return !rightDetails.length;
    case "right_entails_left": return !leftDetails.length;
    default: return false;
  }
}

/** Source-backed condition paraphrases require an explicit semantic assessment;
 * legacy, unrelated, contradictory and uncertain judgments cannot enable them.
 * Callers also enforce atomic identity and directional inventory coverage.
 */
export function reviewedStatementDetailLosses(survivor: Metadata, removed: Metadata,
  assessment: SemanticAssessment | undefined, source?: EvidenceSource): string[] {
  const reviewed = assessment && ["equivalent", "left_entails_right", "right_entails_left"].includes(assessment.relationship);
  return statementDetailLosses(survivor, removed, reviewed ? source : undefined);
}

/** Validate the evidence for contextual enrichment again at application time.
 * This is a grounded semantic judgment, not a proof from string similarity.
 * It never overrides participant, polarity, causality or atomicity guards.
 */
export function reviewedContextIssues(left: Metadata, right: Metadata, leftDetails: readonly string[],
  rightDetails: readonly string[], issues: readonly string[], assessment?: SemanticAssessment): string[] {
  if (!assessment || !semanticCoverageAllowsMerge(assessment, leftDetails, rightDetails)) return [...issues];
  const a = evidencePrimarySpan(left), b = evidencePrimarySpan(right);
  if (!a || !b || left.accountId !== right.accountId || !left.sourceId || left.sourceId !== right.sourceId
    || !left.sourceContentHash || left.sourceContentHash !== right.sourceContentHash || a.pageNumber !== b.pageNumber) return [...issues];
  const supported = new Set<string>();
  for (const context of assessment.contextualDetails) {
    const metadata = context.side === "left" ? left : right;
    const details = context.side === "left" ? leftDetails : rightDetails;
    if (!details.includes(context.detail) || !context.explanation.trim() || !context.sourceQuote.trim()
      || typeof metadata.what !== "string" || normalizeIdentityExcerpt(metadata.what, context.detail) === null) continue;
    // Identity alone cannot supply a person's description. Require the actual
    // descriptor in the cited excerpt and shared support for this assertion;
    // directional inventories keep it in the surviving original statement.
    if (context.kind === "participant_description" && (!sharedPrimaryPassage(left, right)
      || !includesDescription(context.sourceQuote, context.detail))) continue;
    const spans = Array.isArray(metadata.sourceSpans) ? metadata.sourceSpans : [];
    if (!spans.some(span => typeof span?.sourceQuote === "string"
      && normalizeIdentityExcerpt(span.sourceQuote, context.sourceQuote) !== null)) continue;
    supported.add(`${context.side}: ${context.detail}`);
  }
  return issues.filter(issue => !supported.has(issue));
}
