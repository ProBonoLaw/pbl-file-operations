import { evidenceComparisonText, evidencePrimarySpan, sharedPrimaryPassage } from "./evidencePageIdentity.js";
import { missingDateComparison, redundantMissingDateDetail } from "./evidenceMissingDate.js";
import { containsCondition, sourcePreservesPassiveCondition } from "./evidenceConditionComparison.js";
import type { EvidenceSource } from "./evidenceSource.js";

type Metadata = Record<string, unknown>;

const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
const words = (value: string): string[] => normalize(value).match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
const nameWord = String.raw`(?:[\p{Lu}][\p{L}\p{N}-]*|for|and|of|the|in|to|\d+(?:[/-]\d+)*)`;
const definitionPattern = `(${nameWord}(?: ${nameWord})+?) \\(([A-Z][A-Z0-9-]{1,11})\\)`;

function quotes(metadata: Metadata): string[] {
  return Array.isArray(metadata.sourceSpans) ? metadata.sourceSpans.flatMap(span =>
    span && typeof span.sourceQuote === "string" ? [span.sourceQuote] : []) : [];
}

/** Only explicit proper-name definitions in cited text can explain an expansion.
 * Requiring the same primary passage avoids inventing a document-wide alias
 * dictionary from an abbreviation reused on a different occasion.
 */
function sourceDefinesExpansion(detail: string, metadata: Metadata, other: Metadata): boolean {
  const statement = typeof metadata.what === "string" ? metadata.what : "";
  const match = [...statement.matchAll(new RegExp(definitionPattern, "gu"))]
    .find(match => normalize(detail) === normalize(match[0]) || normalize(detail) === normalize(match[1]));
  if (!match || !metadata.sourceContentHash || metadata.sourceContentHash !== other.sourceContentHash
    || metadata.sourceId !== other.sourceId || !quotes(metadata)[0] || quotes(metadata)[0] !== quotes(other)[0]) return false;
  const primary = (value: Metadata) => Array.isArray(value.sourceSpans) ? value.sourceSpans[0] : undefined;
  if (primary(metadata)?.pageNumber !== primary(other)?.pageNumber
    || primary(metadata)?.sourceOffset !== primary(other)?.sourceOffset) return false;
  if (!quotes(metadata).some(quote => normalize(quote).includes(normalize(match[0])))) return false;
  const otherWhat = typeof other.what === "string" ? other.what : "";
  // A conflicting parenthesized expansion is not a bare abbreviation match.
  if (otherWhat.includes(`(${match[2]})`) && !normalize(otherWhat).includes(normalize(match[0]))) return false;
  return words(otherWhat).includes(normalize(match[2]));
}

function comparisonText(metadata: Metadata, other: Metadata): string {
  const what = missingDateComparison(metadata, other)?.left ?? (typeof metadata.what === "string" ? metadata.what : "");
  // The full name remains in stored evidence. This is comparison-only, and a
  // nonmatching or uncited definition never gets shortened.
  return what.replace(new RegExp(definitionPattern, "gu"),
    (full: string, _name: string, abbreviation: string) => sourceDefinesExpansion(full, metadata, other) ? abbreviation : full);
}

/** A narrow equivalence proof for the modifier "overall". Both assertions
 * must name the same single index and standard-score/percentile tuple, backed
 * by the same primary passage explicitly calling that result overall.
 * Do not generalize this to totals, subtests, composite batteries or equal
 * numbers on different measures. Stored assertion text is never changed.
 */
function sameOverallIndex(left: Metadata, right: Metadata): boolean {
  if (left.factType !== "assessmentResult" || right.factType !== "assessmentResult"
    || !left.sourceContentHash || left.sourceContentHash !== right.sourceContentHash
    || left.sourceId !== right.sourceId) return false;
  const spans = [left, right].map(value => Array.isArray(value.sourceSpans) ? value.sourceSpans[0] : undefined);
  if (!spans[0] || !spans[1] || spans[0].pageNumber !== spans[1].pageNumber
    || spans[0].sourceOffset !== spans[1].sourceOffset || spans[0].sourceQuote !== spans[1].sourceQuote) return false;
  const tuple = (value: Metadata) => {
    const what = typeof value.what === "string" ? value.what : "";
    if (/\b(?:subtest|component|battery|total|composite)\b/iu.test(what)
      || (what.match(/\bindex\b/giu) ?? []).length !== 1
      || (what.match(/\boverall\b/giu) ?? []).length > 1
      || (/\boverall\b/iu.test(what) && !/\boverall standard score\b/iu.test(what))) return null;
    const names = [...what.matchAll(new RegExp(definitionPattern, "gu"))].filter(match => /\bIndex$/u.test(match[1]));
    const scores = [...what.matchAll(/\bstandard score(?: of| was| is)? (\d+(?:\.\d+)?)\b/giu)];
    const ranks = [...what.matchAll(/\b(\d+(?:\.\d+)?)(?:st|nd|rd|th)? percentile\b/giu)];
    if (names.length !== 1 || scores.length !== 1 || ranks.length !== 1) return null;
    return {name:normalize(names[0][0]),abbreviation:names[0][2],score:scores[0][1],percentile:ranks[0][1]};
  };
  const first = tuple(left), second = tuple(right), quote: unknown = spans[0].sourceQuote;
  if (!first || !second || JSON.stringify(first) !== JSON.stringify(second) || typeof quote !== "string"
    || !words(quote).includes(normalize(first.abbreviation)) || !/\boverall (?:performance|result|score)\b/iu.test(quote)) return false;
  const score = [...quote.matchAll(/\b(?:SS\s*=\s*|standard score(?: of| was| is)? )(\d+(?:\.\d+)?)\b/giu)];
  const rank = [...quote.matchAll(/\b(\d+(?:\.\d+)?)(?:st|nd|rd|th)? percentile\b/giu)];
  return score.length === 1 && rank.length === 1 && score[0][1] === first.score && rank[0][1] === first.percentile;
}

export function identityMaterialDetails(left: Metadata, right: Metadata,
  leftOnlyDetails: readonly string[], rightOnlyDetails: readonly string[]) {
  const overall = (detail: string) => /^(?:overall|overall standard score)$/u.test(normalize(detail));
  const canIgnoreOverall = [...leftOnlyDetails,...rightOnlyDetails].some(overall) && sameOverallIndex(left, right);
  const redundant = (detail: string) => (overall(detail) && canIgnoreOverall) || repeatedAssessmentDetail(detail, left, right);
  const redundantLeft = (detail: string) => redundant(detail) || sharedActivityParticipantReference(detail, left, right)
    || redundantMissingDateDetail(detail, left, right);
  const redundantRight = (detail: string) => redundant(detail) || sharedActivityParticipantReference(detail, right, left)
    || redundantMissingDateDetail(detail, right, left);
  return {leftOnlyDetails:leftOnlyDetails.filter(detail => !redundantLeft(detail)),
    rightOnlyDetails:rightOnlyDetails.filter(detail => !redundantRight(detail)),
    equivalentDetails:{left:leftOnlyDetails.filter(redundantLeft),right:rightOnlyDetails.filter(redundantRight)}};
}

/** A pronoun can repeat an activity partner already established on both sides.
 * Require an explicit cited activity definition and the named partner or their
 * named parents retained by BOTH Who fields. Never infer a partner from
 * proximity or remove a different recipient/relative relationship.
 */
function sharedActivityParticipantReference(detail: string, metadata: Metadata, other: Metadata): boolean {
  if (!/^with (?:him|her|them)$/u.test(normalize(detail)) || !sharedPrimaryPassage(metadata, other)
    || ![metadata, other].every(value => typeof value.what === "string"
      && /\bone-on-one (?:time|activit(?:y|ies))\b/iu.test(value.what))) return false;
  const names = (value: Metadata) => Array.isArray(value.who)
    ? value.who.filter((name): name is string => typeof name === "string" && /^(?:\p{Lu}[\p{L}\p{M}.-]*)(?:\s+\p{Lu}[\p{L}\p{M}.-]*)*$/u.test(name)) : [];
  const namedParent = (value: Metadata, name: string) => Array.isArray(value.who)
    && value.who.some(label => typeof label === "string"
      && normalize(label).replace(/[‘’]/gu, "'") === `${normalize(name)}'s parents`);
  const sharedNames = names(metadata).filter(name => names(other).some(otherName => normalize(name) === normalize(otherName))
    || namedParent(metadata, name) && namedParent(other, name));
  const spans = (value: Metadata) => Array.isArray(value.sourceSpans) ? value.sourceSpans : [];
  const definitions = spans(metadata).filter(first => spans(other).some(second => {
    if (first.pageNumber !== second.pageNumber || typeof first.sourceQuote !== "string" || typeof second.sourceQuote !== "string") return false;
    const contains = (outer: typeof first, inner: typeof first) => inner.sourceOffset >= outer.sourceOffset
      && outer.sourceQuote.slice(inner.sourceOffset - outer.sourceOffset, inner.sourceOffset - outer.sourceOffset + inner.sourceQuote.length) === inner.sourceQuote;
    return contains(first, second) || contains(second, first);
  }) || sharedNames.some(name => namedParent(metadata, name) && namedParent(other, name)));
  return sharedNames.some(name => definitions.some(span => {
    const reference = `one-on-one time with ${normalize(name)}`;
    const text = normalize(span.sourceQuote), index = text.indexOf(reference);
    return index >= 0 && !/[\p{L}\p{N}]/u.test(text[index + reference.length] ?? "");
  }));
}

/** A named score phrase literally present in both single-score assertions is
 * not absent from either. Require the same subject/reporter and a shared source
 * citation; this does not equate roles or values across multi-score statements.
 */
function repeatedAssessmentDetail(detail: string, left: Metadata, right: Metadata): boolean {
  if (!/^[\p{Lu}][\p{L}-]*(?: [\p{Lu}][\p{L}-]*)+ score(?: of| was| is)? \d+(?:\.\d+)?$/u.test(detail)
    || left.factType !== "assessmentResult" || right.factType !== "assessmentResult"
    || !left.sourceContentHash || left.sourceContentHash !== right.sourceContentHash || left.sourceId !== right.sourceId) return false;
  for (const field of ["subject", "reportedBy"]) {
    const values = [left, right].map(metadata => Array.isArray(metadata[field])
      ? metadata[field].filter((value: unknown): value is string => typeof value === "string").map(normalize).sort() : []);
    if (!values[0].length || JSON.stringify(values[0]) !== JSON.stringify(values[1])) return false;
  }
  const statements = [left, right].map(metadata => typeof metadata.what === "string" ? metadata.what : "");
  if (!statements.every(what => normalize(what).includes(normalize(detail)))) return false;
  const scores = statements.map(what => [...what.matchAll(/\b(?:standard )?score(?: of| was| is)? (\d+(?:\.\d+)?)\b/giu)]);
  if (scores.some(matches => matches.length !== 1) || scores[0][0][1] !== scores[1][0][1]) return false;
  const spans = [left, right].map(metadata => Array.isArray(metadata.sourceSpans) ? metadata.sourceSpans : []);
  return spans[0].some(first => spans[1].some(second => first?.sourceQuote && first.sourceQuote === second?.sourceQuote
    && first.pageNumber === second.pageNumber && first.sourceOffset === second.sourceOffset));
}

const grammaticalWords = new Set("a an the is are was were be been being of to for in on at by as his her their its s and but yet whereas while although with plus also".split(" "));
const substantiveWords = (value: string) => words(value).filter(word => !grammaticalWords.has(word));
// A comma inside an unambiguous calendar date formats a value; it does not
// introduce another proposition. Preserve commas/conjunctions outside dates.
const boundaries = (value: string) => (evidenceComparisonText(value)
  .match(/[,;]|\b(?:and|but|yet|whereas|while|although|with|plus|also)\b/gu) ?? []).length;

// Comparison-only heuristic for detecting MORE omitted additions when a verb
// changes form (create/creating, document/documented). Never use these stems to
// authorize identity, erase inventory entries, or replace the literal check.
const inflectionStem = (word: string) => word.length > 4
  ? word.replace(/(?:ing|ed|es|s)$/u, "").replace(/e$/u, "") : word;

/** Alternative clauses have an ordered focus: recommending A as an alternative
 * to B must not absorb the independent recommendation of B. A bag of words or
 * empty inventories cannot prove that identity. Explicit alternatives require
 * matching clause text; paraphrases stay separate for review. For a bare "or",
 * only veto swapped focuses, not unrelated wording around unchanged options.
 * Identical compound copies remain eligible. No assertions are rewritten.
 */
export function hasDifferentAlternativeClauses(left: Metadata, right: Metadata): boolean {
  const texts = [comparisonText(left, right), comparisonText(right, left)].map(normalize);
  const boundary = /\b(?:as an alternative to|instead of|rather than|alternatively)\b/u;
  if (texts.some(text => boundary.test(text))) {
    const signatures = texts.map(text => text.split(boundary).map(clause => words(clause).join(" ")));
    return JSON.stringify(signatures[0]) !== JSON.stringify(signatures[1]);
  }
  const clauses = texts.map(text => text.split(/\bor\b/u).map(clause => new Set(substantiveWords(clause))));
  if (clauses.some(parts => parts.length !== 2)) return false;
  const uniqueFocus = clauses.map((parts, side) => [...parts[0]].filter(word => !clauses[1-side][0].has(word)));
  return uniqueFocus.every((focus, side) => focus.length > 0 && focus.every(word => clauses[1-side][1].has(word)));
}

/** Explicitly attributing an outcome to a cause introduces a causal claim that
 * an ambiguous "concern about ... due to ..." does not establish. Do not let
 * empty inventories equate the constructions. Other causal paraphrases also
 * remain separate when only one asserts an explicit attribution; this is a
 * conservative veto, not a claim to resolve causal attachment from grammar.
 */
export function hasDifferentCausalAttribution(left: Metadata, right: Metadata): boolean {
  const explicit = /\battribut(?:e|es|ed|ing)\b[^.;!?]*\bto\b/iu;
  return explicit.test(comparisonText(left, right)) !== explicit.test(comparisonText(right, left));
}

/** An illustrative example is not a requirement to perform that example.
 * Conservative scope guard: retain both when only one assertion qualifies an
 * action/list as illustrative. Empty reviewer inventories cannot erase it.
 */
export function hasDifferentIllustrativeScope(left: Metadata, right: Metadata): boolean {
  const illustrative = /\b(?:for example|for instance|such as|as (?:an?|one) example)\b|\be\.g\./iu;
  return illustrative.test(comparisonText(left, right)) !== illustrative.test(comparisonText(right, left));
}

/** Directional backstop for explicit targets and conditions, even when the
 * surrounding assertions are paraphrases. Quotations and who cannot fill a
 * missing detail in what. Conditions tolerate punctuation differences in prose;
 * an optional reviewed source permits narrowly verified active/passive wording.
 * Other targets and qualifications retain their literal preservation checks.
 */
export function statementDetailLosses(survivor: Metadata, removed: Metadata, reviewedSource?: EvidenceSource): string[] {
  const kept = typeof survivor.what === "string" ? normalize(survivor.what) : "";
  const original = typeof removed.what === "string" ? removed.what : "";
  const patterns = [
    /\brelationships?\s+((?:with|between)\s+[^,;.]+)/giu,
    /\b(?:message|notice|letter|approval|consent)\s+((?:to|from|for)\s+[^,;.]+)/giu,
    /\b((?:at least|at most|no more than|no fewer than)\s+\d+(?:\.\d+)?(?:\s+[\p{L}-]+)?)/giu,
    /\b((?:the |its |their )?(?:goal|purpose|aim|intention) (?:is|was) to [^;.!?]+)/giu,
  ];
  const keptWords = words(kept);
  // A comma followed by and/or continues the condition when another comma still
  // precedes the consequence: "If A, and B, ..." has two prerequisites.
  const conditionLosses = [...original.matchAll(/\b((?:if|unless|provided that|subject to|where possible|only when)\b[^,;.]*(?:,\s*(?:and|or)\s+[^,;.]*(?=,))*)/giu)]
    .map(match => match[1].trim()).filter(detail => !kept.includes(normalize(detail)) && !containsCondition(kept, detail)
      && !(reviewedSource && sourcePreservesPassiveCondition(survivor, removed, detail, reviewedSource)));
  // Preserve explicit category values, including categories outside the known
  // assessment vocabulary. Whole tokens prevent Index from matching Subindex.
  const categoryLosses = [...original.matchAll(/\b(?:in|within|under)\s+(?:the\s+)?([^,;.]+?)\s+category\b/giu)]
    .map(match => match[1].trim()).filter(label => {
      const labelWords = words(label);
      return !keptWords.some((_, index) => labelWords.every((word, offset) => keptWords[index + offset] === word));
    });
  return [...new Set([...patterns.flatMap(pattern => [...original.matchAll(pattern)]
    .map(match => match[1].trim()).filter(detail => !kept.includes(normalize(detail)))), ...categoryLosses,
    ...conditionLosses, ...measurementDetailLosses(survivor, removed)])];
}

/** Detect omitted differences in coordinated lexical expansions, including
 * insertions and reordered clauses that the literal-prefix guard misses.
 * Also check common inflection changes so an unrelated verb-form change cannot
 * conceal an omitted outcome. This is a conservative check, not a semantic
 * parser: broader paraphrases and expansions without boundaries remain outside it.
 */
export function unreportedContainmentDetails(left: Metadata, right: Metadata,
  leftOnlyDetails: readonly string[], rightOnlyDetails: readonly string[]): string[] {
  const texts = [comparisonText(left, right), comparisonText(right, left)];
  const issues: string[] = [];
  for (const comparison of [(word: string) => word, inflectionStem]) {
    const tokens = texts.map(substantiveWords);
    const sets = tokens.map(tokens => new Set(tokens.map(comparison)));
    if (!sets[0].size || !sets[1].size) continue;
    const differences = tokens.map((tokens, side) => tokens.filter(word => !sets[1-side].has(comparison(word))));
    for (const side of [0, 1]) {
      if (differences[1-side].length || boundaries(texts[side]) <= boundaries(texts[1-side])) continue;
      const reported = new Set((side === 0 ? leftOnlyDetails : rightOnlyDetails).flatMap(substantiveWords));
      const sameParticipants = sharedPrimaryPassage(left, right) && [left, right].every(metadata => Array.isArray(metadata.who));
      const participantWords = sameParticipants ? new Set([left, right].flatMap(metadata =>
        (metadata.who as unknown[]).filter((name): name is string => typeof name === "string").flatMap(words))) : new Set<string>();
      // A possessive name already retained in Who and a corresponding pronoun
      // are contextual wording, not an inserted action. Only waive this lexical
      // backstop when ALL missing words are names/pronouns. Semantic identity,
      // participant compatibility and directional inventories still apply.
      const missing = [...new Set(differences[side].filter(word => !reported.has(word)))];
      if (sameParticipants && missing.every(word => participantWords.has(word) || /^(?:him|her|them|their|his)$/u.test(word))) continue;
      if (missing.length) issues.push(`${side === 0 ? "left" : "right"}: ${missing.join(", ")}`);
    }
  }
  return [...new Set(issues)];
}

/** Accept an exact excerpt first. Only peel balanced display quotation marks
 * when the original excerpt is absent and the inner text actually occurs.
 * Do not repair paraphrases, missing words, or references to other fields.
 */
export function normalizeIdentityExcerpt(what: string, detail: string): string | null {
  const text = normalize(what), excerpt = detail.trim();
  if (!excerpt) return null;
  if (text.includes(normalize(excerpt))) return excerpt;
  for (const [open, close] of [["\"", "\""], ["“", "”"], ["‘", "’"]]) {
    if (excerpt.startsWith(open) && excerpt.endsWith(close)) {
      const inner = excerpt.slice(open.length, -close.length).trim();
      if (inner && text.includes(normalize(inner))) return inner;
    }
  }
  return null;
}

const number = "[+-]?\\d+(?:[.,]\\d+)?";
const percentile = `(?:(?:at|in) (?:the )?)?(?:${number}(?:st|nd|rd|th)? percentile|percentile(?: rank)?(?: (?:of|was|is))? ${number})`;
const score = `(?:(?:overall |the )?(?:(?:standard|scaled|raw|t|z|composite|criterion)[ -])?score(?: (?:of|was|is))? ${number})(?: ${percentile})?`;
const ageNumber = "(?:\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)";
const age = `(?:(?:his|her|their) )?age[- ]equivalent(?: performance)?(?: (?:was|is|of))? (?:\\d+-\\d+|${ageNumber} years?(?:,? ${ageNumber} months?)?)`;
// These labels qualify a measured result; they are not a vocabulary for facts
// or diagnoses in general. Unknown labels retain both records for review.
const range = "(?:(?:very|extremely) )?(?:(?:high|low|above|below) )?(?:average|normal|abnormal|superior|inferior|elevated|borderline|clinical|impaired|adequate)|(?:low|moderate|high) risk";
const classification = `(?:(?:in|within) (?:the )?|(?:described|classified) as |the narrative describes it as |(?:all scales (?:are|were) |(?:are|were) all )(?:within (?:the )?)?)?(?:${range})(?: range)?`;
const measurementPatterns = [percentile, score, age, classification,
  `(?:standard|scaled)[ -]score mean ${number}`, "standard score", "subtest", "composite", "overall",
].map(pattern => new RegExp(`^(?:${pattern})$`, "u"));

function measurementDetail(detail: string): boolean {
  const text = detail.replace(/^\((.*)\)$/u, "$1").trim();
  if (measurementPatterns.some(pattern => pattern.test(text))) return true;
  // Allow combinations of recognized scalar modifiers, never an arbitrary
  // predicate after a number. Limit recursion to the separated leaf phrases.
  const parts = text.split(/[,;]\s*|\s+and\s+/u);
  return parts.length > 1 && parts.every(part => measurementPatterns.some(pattern => pattern.test(part.trim())));
}

const scoreType = "standard|scaled|raw|t|z|composite|criterion";
const typedScorePattern = `\\b(${scoreType})[ -]score(?: (?:of|was|is))? (${number})(?![\\p{L}\\p{N}])`;
const agePopulation = "(?:children|peers|adults) (?:(?:his|her|their) age|of (?:the )?same age)";
const ageComparisonPattern = `(?:when )?compared (?:with|to) (?:other )?${agePopulation}`;
const measurementText = (metadata: Metadata) => typeof metadata.what === "string" ? normalize(metadata.what) : "";
const typedScores = (text: string) => [...text.matchAll(new RegExp(typedScorePattern, "gu"))];
// Normalize only these comparison frames. The group and age remain material.
const comparisonPopulation = (text: string) => normalize(text)
  .replace(/^(?:when )?compared (?:with|to) (?:other )?/u, "")
  .replace(/ (?:his|her|their) age$/u, " of the same age")
  .replace(/ of same age$/u, " of the same age");
const comparisons = (text: string) => [...text.matchAll(/\b(?:when )?compared (?:with|to) [^,;.!?()]+/gu)]
  .map(match => match[0].trim());

/** Keep score type and reference population in the surviving assertion, even
 * if a reviewer forgets them. Explicitly different types/populations cannot
 * pass in either direction; omitted qualifiers can pass only into fuller text.
 */
function measurementDetailLosses(survivor: Metadata, removed: Metadata): string[] {
  if (![survivor, removed].some(value => value.factType === "assessmentResult")) return [];
  const kept = measurementText(survivor), original = measurementText(removed);
  const scores = typedScores(kept), populations = comparisons(kept).map(comparisonPopulation);
  return [...typedScores(original).filter(score => !scores.some(other => other[1] === score[1] && other[2] === score[2]))
    .map(score => score[0]), ...comparisons(original).filter(comparison => !populations.includes(comparisonPopulation(comparison)))];
}

/** Interpret a short inventory excerpt in its complete measurement statement.
 * This grants permission for a qualifier, never identity of two results. The
 * reviewer still has to establish the same subject, measure and occasion.
 */
function contextualMeasurementDetail(detail: string, metadata: Metadata, other: Metadata): boolean {
  if (![metadata, other].some(value => value.factType === "assessmentResult")) return false;
  const a = evidencePrimarySpan(metadata), b = evidencePrimarySpan(other);
  if (!a || !b || a.pageNumber !== b.pageNumber || metadata.accountId !== other.accountId
    || !metadata.sourceId || metadata.sourceId !== other.sourceId
    || !metadata.sourceContentHash || metadata.sourceContentHash !== other.sourceContentHash) return false;
  const text = measurementText(metadata), otherText = measurementText(other), excerpt = normalize(detail);
  // A bare "scaled" is meaningful here only as part of "scaled score <value>".
  // Never grant permission to a standalone adjective or to an added action.
  if (new RegExp(`^(?:${scoreType})(?:[ -]score)?$`, "u").test(excerpt)) {
    const scores = typedScores(text), otherScores = typedScores(otherText);
    return scores.length === 1 && scores[0][0].startsWith(excerpt)
      && new RegExp(`\\bscore(?: (?:of|was|is))? ${scores[0][2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(otherText)
      && otherScores.every(score => score[1] === scores[0][1] && score[2] === scores[0][2]);
  }
  // Comparison populations must be explicit in this result's primary citation.
  // A table and its narrative may have different offsets on the same page.
  const contexts = comparisons(text).filter(value => new RegExp(`^(?:${ageComparisonPattern})$`, "u").test(value));
  return contexts.some(context => (excerpt === context || excerpt === context.replace(/^when /u, "")
      || excerpt === context.replace(/^(?:when )?compared (?:with|to) /u, ""))
    && comparisons(normalize(a.sourceQuote)).some(value => comparisonPopulation(value) === comparisonPopulation(context))
    && comparisons(otherText).every(value => comparisonPopulation(value) === comparisonPopulation(context)));
}

function namedContext(detail: string, metadata: Metadata): boolean {
  const values = [metadata.claimant, metadata.where,
    ...[metadata.who, metadata.subject, metadata.reportedBy].flatMap(value => Array.isArray(value) ? value : [])]
    .filter((value): value is string => typeof value === "string" && !!value.trim()
      && !/^(unknown|null|n\/a|not applicable)$/i.test(value.trim())).map(normalize);
  const target = detail.replace(/^(?:for|to|from|by|about|in|at) /u, "");
  if (values.includes(target) || values.includes(target.replace(/['’]s$/u, ""))) return true;
  const claimant = typeof metadata.claimant === "string" ? normalize(metadata.claimant) : "";
  // A reporting prefix may repeat the existing named claimant. A new action
  // or speaker is not permitted through a loose surname/word-overlap match.
  const prefix = detail.match(/^(.+?) (?:states|reports|says|asserts|suggests|recommends)(?: that)?$/u);
  return !!prefix && !!claimant && (prefix[1] === claimant || prefix[1] === claimant.split(",")[0]);
}

/** An explicitly defined instrument can identify a result already asserted in
 * both records. Keep the added identifier in the surviving wording; it is not
 * erased as an equivalent spelling. Shared passage and semantic review still
 * have to establish the same assessment, measure and occasion.
 */
function citedAssessmentIdentifier(detail: string, metadata: Metadata, other: Metadata): boolean {
  if (metadata.factType !== "assessmentResult" || !sharedPrimaryPassage(metadata, other)) return false;
  const label = detail.replace(/^(?:on|in|from|for) (?:the )?/iu, "").trim();
  const definitions = quotes(metadata).flatMap(quote => [...quote.matchAll(new RegExp(definitionPattern, "gu"))]);
  const match = definitions.find(match => normalize(label) === normalize(match[1]) || normalize(label) === normalize(match[2]));
  if (!match) return false;
  const otherWhat = typeof other.what === "string" ? other.what : "";
  // A different explicit instrument/edition is not an omitted identifier.
  const definedIdentifiers = [...definitions, ...quotes(other).flatMap(quote => [...quote.matchAll(new RegExp(definitionPattern, "gu"))])]
    .map(match => match[2]);
  return !definedIdentifiers.some(identifier => identifier !== match[2]
    && words(otherWhat).includes(normalize(identifier)));
}

/** A stated purpose of the SAME recommendation is directional context, not
 * another performed action or achieved outcome. Require an explicit goal form
 * and its verbatim content in the primary passage containing that recommendation.
 */
function citedRecommendationPurpose(detail: string, metadata: Metadata, other: Metadata): boolean {
  if (!sharedPrimaryPassage(metadata, other)
    || ![metadata, other].every(value => typeof value.what === "string"
      && /\b(?:recommend|recommends|recommended|should|ought)\b/iu.test(value.what))) return false;
  const match = detail.match(/^(?:because |as |since )?(?:the |its |their )?(?:goal|purpose|aim|intention) (?:is|was) (to .+)$/iu);
  if (!match || /\b(?:should|must|shall|ought|recommend|recommends|recommended|if|unless)\b/iu.test(match[1])) return false;
  const primary = quotes(metadata)[0] ?? "";
  return /\b(?:goal|purpose|aim|intention)\b/iu.test(primary)
    && normalize(primary).includes(normalize(match[1]));
}

/** Only enrich a single cited utterance. A second outer action or coordinated
 * assertion must retain a separate record, even if it shares the citation.
 */
function sameSingleUtterance(left: Metadata, right: Metadata): boolean {
  const isCommunication = (metadata: Metadata) => Array.isArray(metadata.tags)
    && metadata.tags.includes("eventType:communication");
  if (!isCommunication(left) || !isCommunication(right)
    || !left.sourceContentHash || left.sourceContentHash !== right.sourceContentHash
    || left.sourceId !== right.sourceId) return false;
  const spans = [left, right].map(value => Array.isArray(value.sourceSpans) ? value.sourceSpans[0] : undefined);
  if (!spans[0] || !spans[1] || spans[0].pageNumber !== spans[1].pageNumber
    || spans[0].sourceOffset !== spans[1].sourceOffset
    || typeof spans[0].sourceQuote !== "string" || typeof spans[1].sourceQuote !== "string") return false;
  const source = spans[0].sourceQuote.length >= spans[1].sourceQuote.length
    ? spans[0].sourceQuote : spans[1].sourceQuote;
  if (!source.startsWith(spans[0].sourceQuote) || !source.startsWith(spans[1].sourceQuote)) return false;
  const outsideQuotes = source.replace(/"[^"]*"/gu, "");
  if ((outsideQuotes.match(/\b(?:told|said|spoke)\b/giu) ?? []).length !== 1
    || /\b(?:and|then|also|subsequently)\b/iu.test(outsideQuotes)) return false;
  return [left, right].every(value => typeof value.what === "string"
    && /\b(?:told|said to|spoke to)\b/iu.test(value.what)
    && !/[;]|\b(?:and|then|also)\b/iu.test(value.what));
}

function citedWitnessCode(detail: string, metadata: Metadata, other: Metadata): boolean {
  const code = detail.match(/^\((W-\d+)\)$/iu)?.[1];
  if (!code || !sameSingleUtterance(metadata, other)) return false;
  const citations = [...quotes(metadata), ...quotes(other)];
  return citations.some(quote => new RegExp(`\\b${code}\\b`, "iu").test(quote))
    && citations.some(quote => new RegExp(`^Witness code ${code} identifies .+\\.$`, "iu").test(quote));
}

/** Positive permission for a limited set of modifiers. Any other claimed
 * enrichment remains a separate record, regardless of same_assertion output.
 * This checks reported differences, not the completeness of the model's list.
 */
export function compatibleIdentityDetail(detail: string, metadata: Metadata, other?: Metadata): boolean {
  if (other && sourceDefinesExpansion(detail, metadata, other)) return true;
  if (other && (citedAssessmentIdentifier(detail, metadata, other)
    || citedRecommendationPurpose(detail, metadata, other)
    || contextualMeasurementDetail(detail, metadata, other))) return true;
  const text = normalize(detail);
  // A relationship's explicit target enriches that same relationship, rather
  // than adding another property or action. Require it in cited source text
  // and an existing relationship assertion on both sides.
  if (other && /^(?:with (?:others|other people|peers|family members)|between (?:parents|family members))$/u.test(text)
    && [metadata,other].every(value => typeof value.what === "string" && /\brelationships?\b/iu.test(value.what))
    && quotes(metadata).some(quote => normalize(quote).includes(text))) return true;
  if (namedContext(text, metadata)) return true;
  if (other && sameSingleUtterance(metadata, other)) {
    if (citedWitnessCode(detail, metadata, other)) return true;
    // A reviewer still has to establish same_assertion and inventory every
    // directional detail. This only permits utterance content from that same
    // verified communication occurrence to enrich its shorter description.
    if (!/^\(W-\d+\)$/iu.test(detail)) return true;
  }
  if (/^(?:in|on) the (?:report|document|record)$/u.test(text)) return true;
  if (/^(?:daily|weekly|monthly|yearly)$/u.test(text)) return true;
  return metadata.factType === "assessmentResult" && measurementDetail(text);
}

export function identityEnrichmentIssues(left: Metadata, right: Metadata,
  leftOnlyDetails: readonly string[], rightOnlyDetails: readonly string[]): string[] {
  return [...leftOnlyDetails.filter(detail => !compatibleIdentityDetail(detail, left, right)).map(detail => `left: ${detail}`),
    ...rightOnlyDetails.filter(detail => !compatibleIdentityDetail(detail, right, left)).map(detail => `right: ${detail}`)];
}
