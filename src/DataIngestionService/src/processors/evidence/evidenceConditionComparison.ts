import { evidencePrimarySpan, sharedPrimaryPassage } from "./evidencePageIdentity.js";
import type { EvidenceSource, SourceSpan } from "./evidenceSource.js";

type Metadata = Record<string, unknown>;
const words = (text: string): string[] => text.normalize("NFKC").toLocaleLowerCase("en-US")
  .match(/[+-]?\d+(?:[.,:/-]\d+)*(?:%)?|[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*|[^\s(),;:.!?]/gu) ?? [];
const startsWith = (text: readonly string[], excerpt: readonly string[], offset = 0) =>
  excerpt.length > 0 && excerpt.every((word, index) => text[offset + index] === word);
const contains = (text: readonly string[], excerpt: readonly string[]) =>
  text.some((_, index) => startsWith(text, excerpt, index));

/** Punctuation in English prose does not by itself establish a different
 * condition. Keep every word, including parenthetical content and conjunctions;
 * the identity reviewer still has to approve the assertion's meaning.
 */
export function containsCondition(text: string, condition: string): boolean {
  return contains(words(text), words(condition));
}

// "If A, and if B" can introduce the same prerequisites as "If A and B".
// This is used only to verify a complete condition against its literal source.
const sourceWords = (text: string) => words(text).filter((word, index, all) =>
  !(word === "if" && all[index - 1] === "and"));

/** Recognize a retained explicit actor in a source-backed active/passive
 * paraphrase: "If the form is signed ..." -> "If Casey signed the form ...".
 * Keep the complete object, predicate and remaining condition in order. This
 * cannot establish identity on its own or discard an explicitly stated actor.
 */
export function sourcePreservesPassiveCondition(survivor: Metadata, removed: Metadata,
  condition: string, source: EvidenceSource): boolean {
  if (typeof survivor.what !== "string" || survivor.sourceContentHash !== source.contentHash
    || !sharedPrimaryPassage(survivor, removed)) return false;
  const literal = (span: SourceSpan) => typeof span?.sourceQuote === "string"
    && Number.isInteger(span.sourceOffset) && span.sourceOffset >= 0
    && source.pages.find(page => page.pageNumber === span.pageNumber)?.text
      .slice(span.sourceOffset, span.sourceOffset + span.sourceQuote.length) === span.sourceQuote;
  if (![survivor, removed].every(metadata => {
    const primary = evidencePrimarySpan(metadata);
    return primary && literal(primary);
  })) return false;
  const passive = condition.match(/^(if|unless|only when|provided that)\s+(.+?)\s+(?:is|are|was|were)\s+([a-z]+ed|sent|given|shown|made|taken|written|read)\b(.*)$/iu);
  if (!passive) return false;
  const intro = words(passive[1]), object = words(passive[2]), verb = passive[3].toLocaleLowerCase("en-US");
  const tail = sourceWords(passive[4]), kept = sourceWords(survivor.what);
  if (!startsWith(kept, intro)) return false;
  for (let index = intro.length + 1; index < kept.length; index++) {
    if (kept[index] !== verb) continue;
    const actor = kept.slice(intro.length, index);
    // Do not absorb another condition, negation, or modality into an actor.
    if (actor.some(word => /^(?:if|unless|not|no|never|may|might|must|should|could|would|can|is|are|was|were|be|been)$/u.test(word))) continue;
    const active = [...intro, ...actor, verb, ...object, ...tail];
    if (!startsWith(kept, active)) continue;
    const spans = Array.isArray(survivor.sourceSpans) ? survivor.sourceSpans as SourceSpan[] : [];
    if (spans.some(span => {
      if (!literal(span)) return false;
      const cited = sourceWords(span.sourceQuote);
      // Match the whole cited condition: a longer source alternative could
      // identify another actor or prerequisite absent from this paraphrase.
      return cited.length === active.length && startsWith(cited, active);
    })) return true;
  }
  return false;
}
