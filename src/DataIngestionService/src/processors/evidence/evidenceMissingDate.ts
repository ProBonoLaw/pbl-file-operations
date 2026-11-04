import { evidenceComparisonText, identityText, sharedPrimaryPassage } from "./evidencePageIdentity.js";
import { knownMetadataText } from "./evidenceMetadataValues.js";

type Metadata = Record<string, unknown>;
const dateParts = ["year", "month", "day", "season", "quarter"];
const known = (value: unknown) => knownMetadataText(typeof value === "number" ? String(value) : value) !== null;
const dateHasParts = (value: unknown) => !!value && typeof value === "object"
  && dateParts.some(part => known((value as Metadata)[part]));

function hasTiming(metadata: Metadata): boolean {
  if ([metadata.whenStarted, metadata.whenEnded, metadata.asOf].some(dateHasParts)) return true;
  const resolution = metadata.eventDateResolution as Metadata | undefined;
  if (resolution && (resolution.status === "dated" || resolution.status === "conflict"
    || known(resolution.qualifier) || dateHasParts(resolution.start) || dateHasParts(resolution.end)
    || known(resolution.relation) && resolution.relation !== "unknown")) return true;
  // Partial/relative dates also carry information. Do not discard an annotation
  // as redundant when an occurrence already has timing in its statement.
  return /\b(?:\d{4}|\d{1,2}[/-]\d{1,2}|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|yesterday|today|tomorrow|before|after|during|since|until)\b|\b(?:last|next|this|previous|following) (?:day|week|month|year)\b|\bat (?:age|\d)/iu
    .test(evidenceComparisonText(metadata.what));
}

const statement = (value: unknown) => typeof value === "string" ? value.trim() : "";
const stem = (value: string) => value.replace(/(?:ion|ment|ing|ed|s)$/u, "").replace(/e$/u, "");
function annotation(value: unknown): {core:string; detail:string} | null {
  const text = statement(value);
  const match = text.match(/(?:\s*[,;.]\s+|\s+and\s+)((?:the )?(?:date(?: of (?:the|this) ([\p{L}-]+))?|([\p{L}-]+) date) (?:is|was) (?:unstated|unspecified|unknown|not (?:stated|specified|provided|recorded|documented|known))(?: in (?:the )?(?:source|document|report|record))?)[.!]?$/iu);
  if (!match || match.index === undefined) return null;
  const core = text.slice(0, match.index).trim();
  if (!core) return null;
  // "Date of the arrest" must not disappear from an evaluation assertion.
  // Only an explicit repeated event noun/verb stem or a bare date annotation
  // qualifies; this is not an alias dictionary or an occurrence-identity proof.
  const referent = match[2] ?? match[3];
  if (referent && !(identityText(core).match(/[\p{L}-]+/gu) ?? [])
    .some(word => stem(word) === stem(identityText(referent)))) return null;
  return {core,detail:match[1]};
}

/** An explicit missing date adds no event detail to the same undated assertion.
 * This only normalizes guard comparisons and inventories, never stored wording.
 * Require matching remaining statements and shared, scoped primary support.
 * Semantic review must still establish identity; no date/role/polarity is inferred.
 */
export function missingDateComparison(left: Metadata, right: Metadata) {
  const a = annotation(left.what), b = annotation(right.what);
  if ((!a && !b) || !sharedPrimaryPassage(left, right) || hasTiming(left) || hasTiming(right)) return null;
  const first = a?.core ?? statement(left.what), second = b?.core ?? statement(right.what);
  const normalized = (text: string) => evidenceComparisonText(text).replace(/[.!?]+$/u, "").trim();
  if (!normalized(first) || normalized(first) !== normalized(second)) return null;
  return {left:first,right:second,leftAnnotation:a?.detail ?? "",rightAnnotation:b?.detail ?? ""};
}

export function redundantMissingDateDetail(detail: string, metadata: Metadata, other: Metadata): boolean {
  const comparison = missingDateComparison(metadata, other), text = identityText(detail);
  return !!comparison?.leftAnnotation && !!text && identityText(comparison.leftAnnotation).includes(text);
}
