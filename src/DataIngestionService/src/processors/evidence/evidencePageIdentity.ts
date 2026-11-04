import type { SourceSpan } from "./evidenceSource.js";
import { formatEvidenceDate } from "./evidenceContent.js";
import { identityText, knownIdentityLabels } from "./evidenceMetadataValues.js";
export { identityText } from "./evidenceMetadataValues.js";

type Metadata = Record<string, unknown>;
const names = knownIdentityLabels;

/** Calendar formatting can differ between extractions of any assertion. Normalize
 * only unambiguous full dates for review retrieval; never rewrite stored wording.
 */
export function evidenceComparisonText(value: unknown): string {
  const months = ["january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december"];
  const date = (original: string, year: string, month: number, day: number) => {
    try { formatEvidenceDate({year, month: String(month), day: String(day)}); }
    catch { return original; }
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  const monthPattern = months.join("|");
  return identityText(value)
    .replace(new RegExp(`\\b(${monthPattern}) (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})\\b`, "g"),
      (original, month: string, day: string, year: string) => date(original, year, months.indexOf(month) + 1, Number(day)))
    .replace(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (${monthPattern}) (\\d{4})\\b`, "g"),
      (original, day: string, month: string, year: string) => date(original, year, months.indexOf(month) + 1, Number(day)))
    .replace(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g, (original, first: string, second: string, year: string) => {
      const a = Number(first), b = Number(second);
      if (a <= 12 && b > 12) return date(original, year, a, b);
      if (a > 12 && b <= 12) return date(original, year, b, a);
      return original; // 04/05/2025 can mean two different dates.
    });
}

/** A supporting citation on a shared page does not establish the primary page. */
export function evidencePrimarySpan(metadata: Metadata): SourceSpan | null {
  const span = Array.isArray(metadata.sourceSpans) ? metadata.sourceSpans[0] as SourceSpan | undefined : undefined;
  if (!span || !Number.isInteger(span.pageNumber) || span.pageNumber < 0
    || !Number.isInteger(span.sourceOffset) || span.sourceOffset < 0 || !identityText(span.sourceQuote)
    || metadata.sourceOffset !== span.sourceOffset || metadata.sourceQuote !== span.sourceQuote
    || !Array.isArray(metadata.pages) || metadata.pages[0] !== span.pageNumber) return null;
  return span;
}

export function sameCitedAssertion(first: Metadata, second: Metadata): boolean {
  const left = evidencePrimarySpan(first), right = evidencePrimarySpan(second);
  return !!left && !!right && left.pageNumber === right.pageNumber
    && left.sourceOffset === right.sourceOffset && left.sourceQuote === right.sourceQuote
    && !!identityText(first.what) && identityText(first.what) === identityText(second.what);
}

/** Nested citation excerpts must address the same characters, not just repeat
 * similar text elsewhere. Sharing a passage earns review, never identity.
 */
export function sharedPrimaryPassage(first: Metadata, second: Metadata): boolean {
  const a = evidencePrimarySpan(first), b = evidencePrimarySpan(second);
  if (!a || !b || first.accountId !== second.accountId || !first.sourceContentHash
    || first.sourceContentHash !== second.sourceContentHash || !first.sourceId || first.sourceId !== second.sourceId) return false;
  const contains = (outer: SourceSpan, inner: SourceSpan) => outer.pageNumber === inner.pageNumber
    && inner.sourceOffset >= outer.sourceOffset
    && outer.sourceQuote.slice(inner.sourceOffset - outer.sourceOffset, inner.sourceOffset - outer.sourceOffset + inner.sourceQuote.length) === inner.sourceQuote;
  return contains(a, b) || contains(b, a);
}

/** A review lead, never an automatic identity mapping. Allow name prefixes or
 * omitted middle names; different full names sharing a first name do not match.
 * Retain every original label and require the reviewer to establish identity.
 */
export function possiblePersonLabelAlias(first: string, second: string): boolean {
  const name = (value: string) => value.normalize("NFKC").trim()
    .replace(/(?:,?\s+(?:Ph\.?D\.?|Psy\.?D\.?|M\.?D\.?|D\.?O\.?|R\.?N\.?|Esq\.?))+$/i, "");
  const left = name(first), right = name(second);
  const properName = /^(?:\p{Lu}[\p{L}\p{M}.-]*)(?:\s+\p{Lu}[\p{L}\p{M}.-]*)*$/u;
  if (!properName.test(left) || !properName.test(right)) return false;
  const a = identityText(left), b = identityText(right);
  if (a === b || a.startsWith(b + " ") || b.startsWith(a + " ")) return true;
  const parts = [a.split(" "), b.split(" ")].sort((a, b) => a.length - b.length);
  const [short, full] = parts;
  if (short.length < 2 || short.length === full.length || short[0] !== full[0] || short.at(-1) !== full.at(-1)) return false;
  let next = 1;
  return short.slice(1, -1).every(part => {
    const found = full.indexOf(part, next);
    next = found + 1;
    return found > 0 && found < full.length - 1;
  });
}

const unnamedRoles = new Set(["doctor", "physician", "clinician", "examiner", "evaluator", "therapist",
  "nurse", "teacher", "caregiver", "provider", "witness", "investigator", "officer", "author", "writer",
  "report author", "document author", "speaker", "caller", "reporter", "patient", "parent", "mother", "father",
  "child", "respondent", "petitioner", "lawyer", "attorney"]);
const relationalRoles = new Set(["mother", "father", "parent", "parents", "sister", "brother", "sibling",
  "grandmother", "grandfather", "grandparent", "grandparents", "wife", "husband", "spouse", "partner",
  "child", "children", "son", "daughter", "doctor", "teacher", "therapist", "caregiver", "provider"]);
const referenceName = /^(?:\p{Lu}[\p{Ll}\p{M}]+\.?)(?:\s+(?:\p{Lu}[\p{Ll}\p{M}]+\.?|\p{Lu}\.))*$/u;
const sentenceWords = new Set(["the", "a", "an", "his", "her", "their", "he", "she", "they", "when", "during",
  "after", "before", "according", "then", "this", "that", "it", "both"]);

/** Unresolved role wording and possessive references can earn identity review
 * within one cited occurrence. Unknown is not a wildcard for named people,
 * qualified roles or different relatives, and labels are never rewritten.
 */
export function possibleParticipantReferenceAlias(first: string, second: string, left: Metadata, right: Metadata): boolean {
  if (!sharedPrimaryPassage(left, right)) return false;
  const a = identityText(first), b = identityText(second);
  const role = (label: string) => {
    let value = label.replace(/^(?:unknown|unidentified|unspecified|the|a|an) /u, "");
    const qualified = value.match(/^(.+)'s (evaluating|examining|treating|assessing|interviewing) (.+)$/u);
    if (qualified) {
      const action: Record<string, string> = {evaluating:"evaluated",examining:"examined",treating:"treated",assessing:"assessed",interviewing:"interviewed"};
      value = `${qualified[3]} who ${action[qualified[2]]} ${qualified[1]}`;
    }
    if (unnamedRoles.has(value)) return {role:value, description:null};
    const described = value.match(/^(.+) who (evaluated|examined|treated|assessed|interviewed) (.+)$/u);
    if (!described || !unnamedRoles.has(described[1])) return null;
    // A qualification can identify the same unnamed actor when the cited
    // action explicitly supports it. It cannot introduce another client or
    // turn an unnamed actor into a named identity.
    const supported = [left, right].every(metadata => Array.isArray(metadata.sourceSpans)
      && metadata.sourceSpans.some(span => {
        const quote = identityText((span as SourceSpan).sourceQuote);
        return quote.includes(`${described[3]} was ${described[2]} by a ${described[1]}`)
          || quote.includes(`${described[1]} ${described[2]} ${described[3]}`);
      }));
    return supported ? {role:described[1], description:value} : null;
  };
  const firstRole = role(a), secondRole = role(b);
  if (firstRole && secondRole && firstRole.role === secondRole.role
    && (!firstRole.description || !secondRole.description || firstRole.description === secondRole.description)) return true;

  const relation = (label: string) => {
    const pronoun = identityText(label).match(/^(his|her|their) (.+)$/u);
    if (pronoun && relationalRoles.has(pronoun[2])) return {pronoun:pronoun[1], role:pronoun[2], owner:null};
    const named = label.normalize("NFKC").replace(/[‘’]/g, "'").trim().match(/^(.+)'s (.+)$/u);
    return named && referenceName.test(named[1]) && relationalRoles.has(identityText(named[2]))
      ? {pronoun:null, role:identityText(named[2]), owner:named[1]} : null;
  };
  const firstRelation = relation(first), secondRelation = relation(second);
  if (!firstRelation || !secondRelation || firstRelation.role !== secondRelation.role
    || !!firstRelation.owner === !!secondRelation.owner) return false;
  const owner = (firstRelation.owner ?? secondRelation.owner)!;
  const pronoun = (firstRelation.pronoun ?? secondRelation.pronoun)!;
  const ownerKey = identityText(owner);
  const sameOwner = (name: string) => identityText(name) === ownerKey || possiblePersonLabelAlias(name, owner);
  const mentionsOwner = (value: unknown) => {
    const statement = identityText(value), offset = statement.indexOf(ownerKey);
    return offset >= 0 && !/[\p{L}\p{N}]/u.test(statement[offset - 1] ?? "")
      && !/[\p{L}\p{N}]/u.test(statement[offset + ownerKey.length] ?? "");
  };
  if (![left, right].every(metadata => mentionsOwner(metadata.what))) return false;
  const outer = [evidencePrimarySpan(left)!, evidencePrimarySpan(right)!]
    .sort((a, b) => b.sourceQuote.length - a.sourceQuote.length)[0];
  const quoteText = outer.sourceQuote.normalize("NFKC").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  const quote = identityText(quoteText);
  const reference = `${pronoun} ${firstRelation.role}`;
  const ownerOffset = quote.indexOf(ownerKey), referenceOffset = quote.indexOf(reference);
  if (ownerOffset < 0 || referenceOffset <= ownerOffset
    || /[\p{L}\p{N}]/u.test(quote[ownerOffset - 1] ?? "")
    || /[\p{L}\p{N}]/u.test(quote[ownerOffset + ownerKey.length] ?? "")
    || /[\p{L}\p{N}]/u.test(quote[referenceOffset - 1] ?? "")
    || /[\p{L}\p{N}]/u.test(quote[referenceOffset + reference.length] ?? "")) return false;
  // Competing named participants or antecedents require explicit resolution,
  // not a proximity/gender guess. Reporting authors are not activity subjects.
  const reporters = [...citedReporters(left), ...citedReporters(right), left.claimant, right.claimant].map(identityText);
  const participants = [left, right].flatMap(metadata => [metadata.who, metadata.subject]
    .flatMap(value => Array.isArray(value) ? value : []))
    .filter((value): value is string => typeof value === "string" && referenceName.test(value)
      && !reporters.includes(identityText(value)));
  const antecedents = [...quoteText.slice(0, referenceOffset).matchAll(/\b\p{Lu}[\p{Ll}\p{M}]+(?:\s+\p{Lu}[\p{Ll}\p{M}]+)*/gu)]
    .map(match => match[0]).filter(name => !sentenceWords.has(identityText(name)));
  return [...participants, ...antecedents].every(sameOwner);
}

/** The same cited occurrence constrains reference aliases; proper-name alias
 * candidates still require semantic review through their existing caller.
 */
export function possibleEvidenceParticipantAlias(first: string, second: string, left: Metadata, right: Metadata): boolean {
  const unresolved = [first, second].some(label => /^(?:unknown|unidentified|unspecified|the|his|her|their)\b/u.test(identityText(label)));
  return possibleParticipantReferenceAlias(first, second, left, right)
    || !unresolved && possiblePersonLabelAlias(first, second);
}

/** A negative assertion is not an act of denial. Only source-cited negative
 * statements can review an asserts/denies annotation mismatch; explicit denial
 * and uncertain polarity retain their original meaning. Semantic review must
 * still establish the same proposition before applying this normalization.
 */
export function possibleClaimPolarityAnnotationMismatch(left: Metadata, right: Metadata): boolean {
  const polarities = [identityText(left.claimPolarity), identityText(right.claimPolarity)].sort();
  if (polarities[0] !== "asserts" || polarities[1] !== "denies" || !sharedPrimaryPassage(left, right)) return false;
  const denial = /\b(?:den(?:y|ies|ied|ial)|refut(?:e|es|ed)|disput(?:e|es|ed)|reject(?:s|ed)?)\b/u;
  const negative = /\b(?:no|not|never|without|neither|none|nothing|cannot)\b|\b(?:isn't|wasn't|didn't|doesn't|don't|can't)\b/u;
  return [left, right].every(metadata => metadata.claimType !== "denial"
    && !denial.test(identityText(metadata.what)) && negative.test(identityText(metadata.what))
    && !denial.test(identityText(metadata.sourceQuote)) && negative.test(identityText(metadata.sourceQuote)));
}

/** Only already cited reporters can enrich a missing reporter/Who field. */
export function citedReporters(metadata: Metadata): string[] {
  const spans = Array.isArray(metadata.sourceSpans) ? metadata.sourceSpans as SourceSpan[] : [];
  return names(metadata.reportedBy).filter(name => spans.some(span => {
    const quote = identityText(span.sourceQuote);
    const index = quote.indexOf(name);
    return index >= 0 && !/[\p{L}\p{N}]/u.test(quote[index - 1] ?? "")
      && !/[\p{L}\p{N}]/u.test(quote[index + name.length] ?? "");
  }));
}
