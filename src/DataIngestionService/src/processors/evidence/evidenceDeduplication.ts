import { Document } from "@langchain/core/documents";
import { mergeClassificationHistory } from "./evidenceClassification.js";
import { eventDateMeaning } from "./evidenceEventDates.js";
import { EVIDENCE_CONTENT_VERSION, formatEvidenceContent } from "./evidenceContent.js";
import { mergeCompatibleEvidenceDate } from "./evidenceDateMerge.js";
import type { SourceSpan } from "./evidenceSource.js";
import { compatibleEventStructures, mergeEventStructures, resolvedEventStructureField, reviewableEventStructures } from "./evidenceEventStructure.js";
import type { MetadataReviewField } from "./evidenceMetadataReview.js";
import { removeSupersededOtherTags } from "./evidenceTaxonomy.js";
import { evidenceKind as kind, knownMetadataText as known, metadataStrings as strings,
  metadataText as text, unionMetadataStrings as union } from "./evidenceMetadataValues.js";
import { citedReporters, evidencePrimarySpan, identityText, possibleClaimPolarityAnnotationMismatch, possibleEvidenceParticipantAlias, sameCitedAssertion, sharedPrimaryPassage } from "./evidencePageIdentity.js";

function normalizedPeople(value: unknown, assertion: unknown): string[] {
  const code = text(assertion).match(/^Witness code (W-\d+) identifies .+\.$/i)?.[1];
  const names = strings(value).map(name => {
    const label = text(name);
    return code && (label.toLowerCase() === code.toLowerCase()
      || label.toLowerCase() === `witness code ${code.toLowerCase()}`) ? `Witness code ${code}` : label;
  }).filter(name => known(name));
  const unique = new Map<string, string>();
  for (const name of names) {
    const key = identityText(name);
    if (!unique.has(key)) unique.set(key, name);
  }
  return [...unique.values()];
}

function compatiblePeople(first: unknown, second: unknown, assertion: unknown,
  supportedNames: readonly string[] = [], reviewed = false, participantAlias?: (first: string, second: string) => boolean): boolean {
  const left = normalizedPeople(first, assertion).map(identityText).sort();
  const right = normalizedPeople(second, assertion).map(identityText).sort();
  // Subsets still need support for their additional labels. Assertion identity
  // alone does not establish an otherwise unsupported participant.
  const statement = identityText(assertion);
  const labels = [...strings(first), ...strings(second)];
  const aliases = (a: string, b: string) => !!participantAlias && labels.some(firstLabel =>
    identityText(firstLabel) === a && labels.some(secondLabel => identityText(secondLabel) === b
      && participantAlias(firstLabel, secondLabel)));
  const matches = (name: string, names: string[]) => names.some(other => name === other || aliases(name, other));
  // Inputs can already contain aliases from an earlier deduplication run. Do
  // not let their short label connect incompatible full names on a later run.
  if (participantAlias && [...left, ...right].some(name => {
    const variants = [...left, ...right].filter(other => matches(name, [other]));
    return variants.some(a => variants.some(b => !matches(a, [b])));
  })) return false;
  const subset = (small: string[], large: string[]) => small.every(name => matches(name, large))
    && large.filter(name => !matches(name, small)).every(name =>
      reviewed || statement.includes(name) || supportedNames.some(supported => identityText(supported) === name));
  return subset(left, right) || subset(right, left);
}

function participantAnnotationsContained(first: Record<string, unknown>, second: Record<string, unknown>): boolean {
  return ["who", "subject"].every(field => {
    const larger = normalizedPeople(second[field], second.what).map(identityText);
    return normalizedPeople(first[field], first.what).every(label => larger.includes(identityText(label)));
  });
}

/** Additional labels at an identical citation need a shared, cited participant
 * and explicit source wording. Recognize the narrow possessive reordering
 * "bicycle listed as Casey's" -> "Casey's bicycle", without assembling names
 * or relationships from disconnected words. Other paraphrases need review.
 */
function citedSubsetLabels(first: unknown, second: unknown, assertion: unknown, sourceQuote: unknown): string[] {
  const normalize = (value: unknown) => identityText(value).replace(/[^\p{L}\p{M}\p{N}']+/gu, " ").trim();
  const quote = ` ${normalize(sourceQuote)} `;
  const cited = (label: string) => quote.includes(` ${normalize(label)} `)
    || quote.includes(` ${normalize(label)}'s `);
  const left = normalizedPeople(first, assertion), right = normalizedPeople(second, assertion);
  const shared = left.filter(label => right.some(other => identityText(other) === identityText(label)) && cited(label));
  if (!shared.length) return [];
  return [...left, ...right].filter(label => cited(label) || shared.some(owner => {
    const prefix = `${normalize(owner)}'s `;
    const name = normalize(label);
    return name.startsWith(prefix) && name.length > prefix.length
      && quote.includes(` ${name.slice(prefix.length)} listed as ${prefix}`);
  }));
}

function mergedFactType(first: unknown, second: unknown): unknown {
  if (!second) return first;
  if (first === "other") return second;
  if (second === "other") return first;
  if (first === "recordedValue" || second === "recordedValue") return "recordedValue";
  if (first === "relationship" || second === "relationship") return "relationship";
  return first;
}

function compatibleWhere(first: unknown, second: unknown): string | null {
  const left = known(first), right = known(second);
  if (!left) return right ?? "Unknown";
  if (!right || identityText(left) === identityText(right)) return left;
  const qualifier = " (specific venue unknown)";
  if (left === `${right}${qualifier}`) return left;
  if (right === `${left}${qualifier}`) return right;
  return null;
}

function uniqueSpans(spans: SourceSpan[]): SourceSpan[] {
  return [...new Map(spans.map(span => [JSON.stringify([span.pageNumber, span.sourceOffset, span.sourceQuote]), span])).values()];
}

/** Shared compatibility and retention rules for exact matches and reviewed pairs.
 * A reviewed merge retains the first assertion's wording; classification priority
 * independently selects the primary representation. This never invents a statement.
 */
export function mergeEvidenceMetadata(first: Record<string, unknown>, second: Record<string, unknown>,
  reviewed = false, resolvedFields: readonly MetadataReviewField[] = []): Record<string, unknown> | null {
  const wording = first;
  const what = wording.what;
  // Used for candidate previews and only after explicit grounded resolutions at
  // application time. Exact deduplication never receives these permissions.
  const resolved = (field: MetadataReviewField) => reviewed && resolvedFields.includes(field);
  // Classification is not assertion identity. Retain event > fact > claim,
  // while preserving every contributing classification and tag below.
  const rank = { event: 3, fact: 2, claim: 1 };
  if (rank[kind(first)] < rank[kind(second)]) {
    [first, second] = [second, first];
  }
  const left = first, right = second;
  const firstAnchor = evidencePrimarySpan(left), secondAnchor = evidencePrimarySpan(right);
  if (!firstAnchor || !secondAnchor || firstAnchor.pageNumber !== secondAnchor.pageNumber) return null;
  if (!text(left.sourceContentHash) || !text(left.sourceId) || !text(left.what)) return null;
  if (!reviewed && identityText(left.what) !== identityText(right.what)) return null;
  for (const field of ["accountId", "sourceContentHash", "sourceId", "source", "title", "evidenceSchemaVersion"]) {
    if (left[field] !== right[field]) return null;
  }
  const crossKind = kind(left) !== kind(right);
  // A named person's assertion must remain attributed, even if another pass
  // describes the same wording as an event/fact. Similarity cannot establish it.
  if (crossKind && [left, right].some(m => kind(m) === "claim" && known(m.claimant))) return null;
  if (!reviewed && kind(left) === "fact" && kind(right) === "fact"
    && known(left.factType) && known(right.factType) && left.factType !== right.factType
    && left.factType !== "other" && right.factType !== "other") return null;
  const reviewAliases = reviewed && sharedPrimaryPassage(left, right);
  const participantAlias = reviewAliases ? (a: string, b: string) => possibleEvidenceParticipantAlias(a, b, left, right) : undefined;
  const claimantAlias = resolved("claimant") || !!participantAlias?.(text(left.claimant), text(right.claimant));
  const polarityAnnotation = reviewed && possibleClaimPolarityAnnotationMismatch(left, right);
  const uncertaintyAnnotation = resolved("claimPolarity")
    && [left.claimPolarity, right.claimPolarity].sort().join("/") === "asserts/uncertain";
  if (kind(left) === "claim" && identityText(left.claimant) !== identityText(right.claimant) && !claimantAlias
    && (!reviewed || known(left.claimant) && known(right.claimant))) return null;
  for (const field of ["claimant", "claimPolarity"]) {
    if (known(left[field]) && known(right[field]) && identityText(left[field]) !== identityText(right[field])
      && !(field === "claimant" && claimantAlias) && !(field === "claimPolarity" && (polarityAnnotation || uncertaintyAnnotation))) return null;
  }
  // A denial or uncertainty is a material distinction, not merely another tag.
  if (crossKind && !polarityAnnotation && !uncertaintyAnnotation && [left, right].some(m => known(m.claimPolarity) && m.claimPolarity !== "asserts")) return null;
  const dates = Object.fromEntries(["whenStarted", "whenEnded", "asOf"].map(field => [field,
    mergeCompatibleEvidenceDate(left[field], right[field])]));
  if (["whenStarted", "whenEnded", "asOf"].some(field =>
    dates[field] === undefined)) return null;
  if ((!crossKind || !left.eventDateResolution || right.eventDateResolution)
    && eventDateMeaning(left.eventDateResolution) !== eventDateMeaning(right.eventDateResolution)) return null;
  const structuresCompatible = compatibleEventStructures(left.eventStructure, right.eventStructure, participantAlias, reviewAliases);
  const reviewedStructure = resolved("eventStructure") && reviewableEventStructures(left.eventStructure, right.eventStructure);
  if (!structuresCompatible && !reviewedStructure && !(crossKind && left.eventStructure && !right.eventStructure)) return null;
  const reporters = [...citedReporters(left), ...citedReporters(right)];
  const identicalCitation = sameCitedAssertion(left, right);
  // Keep an existing fuller annotation, rather than synthesizing crossed
  // Who/subject combinations that no extraction pass produced.
  if (!reviewed && !participantAnnotationsContained(left, right)
    && !participantAnnotationsContained(right, left)) return null;
  for (const field of ["who", "subject", "reportedBy"]) {
    if (resolved(field as MetadataReviewField)) continue;
    // Who can include the claimant/reporter as well as the subject. Compare
    // substantive participants separately when review can verify the same
    // passage, then retain every original label below.
    const attributed = field === "who" && reviewAliases
      ? [text(left.claimant), text(right.claimant), ...reporters].map(identityText).filter(Boolean) : [];
    const participants = (value: unknown) => attributed.length
      ? strings(value).filter(name => !attributed.includes(identityText(name))) : value;
    // Reporter attribution retains its existing source-support/review rule.
    const citedLabels = !reviewed && identicalCitation && field !== "reportedBy"
      ? citedSubsetLabels(left[field], right[field], left.what, firstAnchor.sourceQuote) : [];
    const supportedNames = field === "who" || field === "reportedBy"
      ? [text(left.claimant), text(right.claimant), ...reporters].filter(Boolean) : [];
    if (!compatiblePeople(participants(left[field]), participants(right[field]), left.what,
      [...supportedNames, ...citedLabels], reviewed, participantAlias)) return null;
  }
  const where = compatibleWhere(left.where, right.where) ?? (resolved("where")
    ? [text(left.where), text(right.where)].sort((a, b) => b.length - a.length)[0] : null);
  if (where === null || known(left.why) && known(right.why) && known(left.why) !== known(right.why)) return null;
  const factType = kind(left) === "fact" ? mergedFactType(left.factType, right.factType) : undefined;
  const mergedTags = removeSupersededOtherTags(union(left.tags, right.tags));
  const classifications = (m: Record<string, unknown>) => Array.isArray(m.evidenceClassifications)
    ? m.evidenceClassifications : [{kind: kind(m), type: kind(m) === "event"
      ? m.eventType ?? strings(m.tags).find(tag => tag.startsWith("eventType:"))?.slice(10)
      : kind(m) === "fact" ? m.factType : m.claimType,
      ...(m.claimant ? {claimant: m.claimant, claimPolarity: m.claimPolarity} : {})}];

  const primary = reviewed ? wording : left;
  const sourceSpans = uniqueSpans([...(primary.sourceSpans as SourceSpan[]),
    ...(left.sourceSpans as SourceSpan[]), ...(right.sourceSpans as SourceSpan[])]);
  const eventStructure = left.eventStructure || right.eventStructure
    ? structuresCompatible || reviewedStructure
      ? mergeEventStructures(left.eventStructure, right.eventStructure, participantAlias, reviewAliases, reviewedStructure)
      : left.eventStructure ?? right.eventStructure : undefined;
  const trigger = eventStructure ? resolvedEventStructureField().parse(eventStructure).trigger : null;
  if (trigger) {
    // Reviewed fact wording can survive while inheriting an event annotation.
    // Keep its wording and every citation, but anchor the trigger in the primary
    // citation using its exact original occurrence, never a new text match.
    const anchor = sourceSpans.findIndex(span => span.pageNumber === firstAnchor.pageNumber && span.pageNumber === trigger.pageNumber
      && trigger.sourceOffset >= span.sourceOffset
      && span.sourceQuote.slice(trigger.sourceOffset - span.sourceOffset,
        trigger.sourceOffset - span.sourceOffset + trigger.sourceQuote.length) === trigger.sourceQuote);
    if (anchor < 0) return null;
    if (anchor > 0) sourceSpans.unshift(...sourceSpans.splice(anchor, 1));
  }
  const primarySpan = sourceSpans[0];
  const polarityResolutions = [left, right].flatMap(m => Array.isArray(m.claimPolarityResolutions) ? m.claimPolarityResolutions : []);
  if (polarityAnnotation) polarityResolutions.push({rule:"source-negative-assertion", polarity:"asserts",
    originals:[left, right].map(m => ({what:m.what, claimType:m.claimType, claimPolarity:m.claimPolarity,
      sourceSpans:m.sourceSpans})), reason:"Reviewed as the same source-supported negative assertion, without an act of denial."});
  const metadata: Record<string, unknown> = {
    ...left,
    ...mergeClassificationHistory(left, right),
    ...dates,
    evidenceClassifications: [...new Map([...classifications(left), ...classifications(right)]
      .map(value => [JSON.stringify(value), value])).values()],
    what,
    sourceQuote: primarySpan.sourceQuote,
    sourceOffset: primarySpan.sourceOffset,
    ...((left.eventDateResolution || right.eventDateResolution)
      ? {eventDateResolution: left.eventDateResolution ?? right.eventDateResolution} : {}),
    ...(left.claimant || right.claimant ? {claimant: known(left.claimant) ? left.claimant : right.claimant ?? left.claimant,
      claimPolarity: polarityAnnotation || uncertaintyAnnotation ? "asserts" : left.claimPolarity ?? right.claimPolarity} : {}),
    ...(polarityResolutions.length ? {claimPolarityResolutions:[...new Map(polarityResolutions.map(value => [JSON.stringify(value), value])).values()]} : {}),
    where,
    why: known(left.why) ? left.why : known(right.why) ? right.why : "Unknown",
    who: normalizedPeople(union(left.who, right.who), left.what),
    tags: mergedTags,
    sourceSpans,
    pages: [...new Set(sourceSpans.map(span => span.pageNumber))],
    extractedBy: union(left.extractedBy, right.extractedBy),
    evidenceContentVersion: EVIDENCE_CONTENT_VERSION,
    ...(eventStructure ? {eventStructure} : {}),
  };
  if (left.subject || right.subject || left.reportedBy || right.reportedBy || crossKind && metadata.claimant) {
    metadata.subject = normalizedPeople(union(left.subject, right.subject), left.what);
    metadata.reportedBy = normalizedPeople(union(left.reportedBy, right.reportedBy,
      crossKind && known(metadata.claimant) ? [metadata.claimant] : []), left.what);
  }
  if (kind(left) === "fact") {
    metadata.factType = factType;
    metadata.tags = [...mergedTags.filter(tag => !tag.startsWith("factType:")), `factType:${factType}`];
    metadata.headers = [metadata.factType, metadata.where, JSON.stringify(metadata.asOf)];
  } else if (kind(left) === "event") {
    if (left.eventType === "other" && right.eventType) metadata.eventType = right.eventType;
    metadata.headers = [metadata.where, metadata.why, JSON.stringify(metadata.whenStarted)];
  }
  return metadata;
}

/** Merge identical assertions on the same account/source/page, retaining the
 * preferred representation (event > fact > claim), tags and citations. General
 * paraphrases and conflicting material fields remain separate for review.
 * Legacy records without accountId must be supplied from one account index.
 */
export function deduplicateEvidenceDocuments(documents: readonly Document[]): Document[] {
  const unique: (Document | undefined)[] = [];
  const buckets = new Map<string, number[]>();
  for (const document of documents) {
    const m = document.metadata;
    const key = JSON.stringify([m.accountId, m.sourceContentHash, m.sourceId, m.pages?.[0], identityText(m.what)]);
    const positions = buckets.get(key) ?? [];
    let retained = document;
    let retainedIndex = unique.length;
    let position = 0;
    while (position < positions.length) {
      const index = positions[position];
      const existing = unique[index]!;
      const [first, second] = index < retainedIndex ? [existing, retained] : [retained, existing];
      const merged = mergeEvidenceMetadata(first.metadata, second.metadata);
      if (!merged) {
        position++;
        continue;
      }
      retained = new Document({metadata: merged, pageContent: formatEvidenceContent(merged)});
      retainedIndex = Math.min(retainedIndex, index);
      unique[index] = undefined;
      positions.splice(position, 1);
      // A fuller list can now contain an earlier, previously incompatible
      // subset. Recheck it with every material-field guard still in force.
      position = 0;
    }
    unique[retainedIndex] = retained;
    positions.push(retainedIndex);
    positions.sort((a, b) => a - b);
    buckets.set(key, positions);
  }
  return unique.filter((document): document is Document => !!document);
}
