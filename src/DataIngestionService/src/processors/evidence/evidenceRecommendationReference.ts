import {identityText, sharedPrimaryPassage} from "./evidencePageIdentity.js";
import {sourceSupportsMetadata} from "./evidenceMetadataReview.js";
import type {EvidenceSource, SourceSpan} from "./evidenceSource.js";

type Metadata = Record<string, unknown>;

/** A syntactic review lead: removing an attributive "recommended" (and an
 * optional article) leaves the same complete statement. Never remove a
 * recommendation predicate, change modality, or infer semantic identity here.
 */
export function recommendationReferenceSide(left: Metadata, right: Metadata): "left" | "right" | null {
  for (const [side, first, second] of [["left", left, right], ["right", right, left]] as const) {
    const text = identityText(first.what), other = identityText(second.what);
    for (const match of text.matchAll(/\b(the|a|an) recommended (?=[\p{L}])/gu)) {
      const before = text.slice(0, match.index), after = text.slice(match.index + match[0].length);
      if (before + after === other || before + match[1] + " " + after === other) return side;
    }
  }
  return null;
}

/** Both records must cite the same recommendation context, including nested
 * excerpts, in the validated source. This permits semantic review only.
 */
export function reviewableRecommendationReference(left: Metadata, right: Metadata, source?: EvidenceSource): boolean {
  if (!source || !recommendationReferenceSide(left, right) || !sourceSupportsMetadata(source, left, right)
    || !sharedPrimaryPassage(left, right)) return false;
  const a = left.sourceSpans as SourceSpan[], b = right.sourceSpans as SourceSpan[];
  return a.some(first => b.some(second => {
    if (first.pageNumber !== second.pageNumber) return false;
    const start = Math.max(first.sourceOffset, second.sourceOffset);
    const end = Math.min(first.sourceOffset + first.sourceQuote.length, second.sourceOffset + second.sourceQuote.length);
    return start < end && /\brecommend(?:s|ed|ation)?\b/iu.test(first.sourceQuote.slice(start - first.sourceOffset, end - first.sourceOffset));
  }));
}
