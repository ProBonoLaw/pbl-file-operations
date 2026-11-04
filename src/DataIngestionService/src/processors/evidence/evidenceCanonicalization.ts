import { Document } from "@langchain/core/documents";
import { findDocumentDuplicateCandidates, findDocumentDuplicateCandidatesAsync, evidenceComparisonNumbers as numbers, type DocumentDuplicateCandidate, type DuplicateMatchReason, type DuplicateRetrievalOptions } from "./evidenceDocumentDeduplication.js";
import {finishEvidenceComputation, runEvidenceComputation} from "./evidenceCooperativeComputation.js";
import { SemanticAssessmentSchema, reviewedContextIssues, reviewedStatementDetailLosses, semanticCoverageAllowsMerge, type SemanticAssessment } from "./evidenceSemanticReview.js";
import { formatEvidenceContent } from "./evidenceContent.js";
import { mergeEvidenceMetadata } from "./evidenceDeduplication.js";
import { metadataResolutionIssues, metadataReviewRequest, repairMetadataResolutions, sourceSupportsMetadata,
  type MetadataResolution, type MetadataReviewField, type MetadataReviewRequest } from "./evidenceMetadataReview.js";
import type { EvidenceSource, SourceSpan } from "./evidenceSource.js";
import { recommendationReferenceSide, reviewableRecommendationReference } from "./evidenceRecommendationReference.js";
import { missingDateComparison } from "./evidenceMissingDate.js";
import { citedReporters, evidenceComparisonText, identityText, possibleEvidenceParticipantAlias, sameCitedAssertion, sharedPrimaryPassage } from "./evidencePageIdentity.js";
import { hasDifferentAlternativeClauses, hasDifferentCausalAttribution, hasDifferentIllustrativeScope, identityEnrichmentIssues, identityMaterialDetails, normalizeIdentityExcerpt, unreportedContainmentDetails } from "./evidenceAtomicity.js";
import { evidenceKind as sourceKind, knownIdentityLabels as list, metadataStrings, metadataText as collapse } from "./evidenceMetadataValues.js";

export const CANONICALIZATION_REVIEW_BATCH_SIZE = 16;


export type Survivor = "left" | "right";
export interface CanonicalizationPair {
  id: string;
  leftIndex: number;
  rightIndex: number;
  similarity: number;
  allowedSurvivors: Survivor[];
  matchReasons?: DuplicateMatchReason[];
  metadataReview?: MetadataReviewRequest;
}

/** Keep the exact comparison set while putting shared records in the same
 * request, so prompt compaction can reuse their assertion and source context.
 */
export function canonicalizationReviewBatches(pairs: readonly CanonicalizationPair[],
  groupSharedRecords = false, size = CANONICALIZATION_REVIEW_BATCH_SIZE): CanonicalizationPair[][] {
  return finishEvidenceComputation(canonicalizationBatchSteps(pairs, groupSharedRecords, size));
}

export function canonicalizationReviewBatchesAsync(pairs: readonly CanonicalizationPair[],
  groupSharedRecords = false, size = CANONICALIZATION_REVIEW_BATCH_SIZE): Promise<CanonicalizationPair[][]> {
  return runEvidenceComputation(canonicalizationBatchSteps(pairs, groupSharedRecords, size));
}

function* canonicalizationBatchSteps(pairs: readonly CanonicalizationPair[],
  groupSharedRecords: boolean, size: number): Generator<void,CanonicalizationPair[][]> {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("Invalid canonicalization batch size");
  const batches: CanonicalizationPair[][] = [];
  if (!groupSharedRecords) {
    for (let start = 0; start < pairs.length; start += size) {
      yield;
      batches.push(pairs.slice(start, start + size));
    }
    return batches;
  }
  const neighbors = new Map<number, number[]>();
  const pending = new Set<number>();
  for (let index = 0; index < pairs.length; index++) {
    yield;
    const pair = pairs[index];
    pending.add(index);
    for (const record of [pair.leftIndex, pair.rightIndex]) {
      const entries = neighbors.get(record) ?? [];
      entries.push(index); neighbors.set(record, entries);
    }
  }
  while (pending.size) {
    const batch: CanonicalizationPair[] = [], records = new Set<number>(), scores = new Map<number, number>();
    while (pending.size && batch.length < size) {
      let chosen = pending.values().next().value!, best = 0;
      for (const [index, score] of scores) {
        yield;
        if (score > best || score === best && index < chosen) {
          chosen = index; best = score;
        }
      }
      const pair = pairs[chosen];
      pending.delete(chosen); scores.delete(chosen); batch.push(pair);
      for (const record of [pair.leftIndex, pair.rightIndex]) if (!records.has(record)) {
        records.add(record);
        for (const index of neighbors.get(record) ?? []) {
          yield;
          if (pending.has(index)) scores.set(index, (scores.get(index) ?? 0) + 1);
        }
      }
    }
    batches.push(batch);
  }
  return batches;
}
export interface CanonicalizationDecision {
  pairId: string;
  survivor: Survivor;
  reason: string;
  leftOnlyDetails: string[];
  rightOnlyDetails: string[];
  semanticAssessment?: SemanticAssessment;
  relation?: "same_assertion" | "independent_assertions" | "uncertain";
  metadataResolutions?: MetadataResolution[];
}
export interface AppliedCanonicalization {
  pairId: string;
  survivorIndex: number;
  removedIndex: number;
}

const normal = (value: unknown): string => collapse(value).toLocaleLowerCase("en-US");
const tags = (metadata: Record<string, unknown>): string[] => metadataStrings(metadata.tags);
const tag = (metadata: Record<string, unknown>, prefix: string): string =>
  normal(tags(metadata).find(value => value.startsWith(prefix)));
const subset = (left: readonly string[], right: readonly string[]): boolean =>
  left.every(value => right.includes(value));

function qualifierSignature(value: unknown): string {
  // A calendar month in a full date (for example May 15, 2025) is not the
  // modal verb "may". Use the same date normalization as candidate retrieval.
  const statement = evidenceComparisonText(value);
  return JSON.stringify([
    /\b(?:no|not|never|none|without|failed|fails|denied|denies|cannot|can't|won't)\b/.test(statement),
    /\b(?:may|might|could|possible|possibly|perhaps|suspected|alleged|uncertain)\b/.test(statement),
    /\b(?:should|recommend|recommends|recommended|ought)\b/.test(statement),
    /\b(?:will|would|must|shall)\b/.test(statement),
  ]);
}

/** A conservative containment guard, not a general parser of propositions.
 * A separate coordinated clause/sentence must not replace the atomic record it
 * contains. Identical compound statements can still be reviewed as duplicates.
 * Ambiguous additive conjunctions intentionally retain both records.
 */
export function hasAddedAssertionBoundary(first: unknown, second: unknown): boolean {
  const statement = (value: unknown) => normal(value).replace(/[.!?]+$/, "").trim();
  const left = statement(first), right = statement(second);
  if (!left || !right || left === right) return false;
  const extendsAtBoundary = (shorter: string, longer: string) => longer.startsWith(shorter)
    && /^(?:\s*[,;:]?\s+(?:and|but|yet|whereas|while|although)\b|\s*[;.!?]\s+\S)/u.test(longer.slice(shorter.length));
  return extendsAtBoundary(left, right) || extendsAtBoundary(right, left);
}

export function hasAddedEvidenceAssertion(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const comparison = missingDateComparison(left, right);
  return hasAddedAssertionBoundary(comparison?.left ?? left.what, comparison?.right ?? right.what);
}

/** Can the richer record preserve every structured field in the other record? */
function dominates(survivor: Record<string, unknown>, removed: Record<string, unknown>,
  resolvedFields: readonly MetadataReviewField[] = [],
  source?: EvidenceSource,
  survivorNumbers = numbers(survivor.what), removedNumbers = numbers(removed.what)): boolean {
  if (!collapse(survivor.what) || !collapse(removed.what)
    || !mergeEvidenceMetadata(survivor, removed, true, resolvedFields)) return false;
  const sharedPassage = sharedPrimaryPassage(survivor, removed);
  const reporters = [...citedReporters(survivor), ...citedReporters(removed),
    ...(sharedPassage ? [survivor.claimant, removed.claimant].map(identityText)
      .filter(value => value && !/^(unknown|null|n\/a|not applicable)$/u.test(value)) : [])];
  for (const field of ["who", "subject", "reportedBy"]) {
    if (resolvedFields.includes(field as MetadataReviewField)) continue;
    if (sameCitedAssertion(survivor, removed)) continue;
    const original = list(removed[field]);
    const retained = list(survivor[field]);
    // Claims/events need not carry a fact-specific subject field. The merged
    // record keeps it; its people must already be identified in the survivor's
    // Who field, using the same source-grounded aliases as ordinary coverage.
    const retainedLabels = field === "subject" && !retained.length && sourceKind(survivor) !== "fact"
      ? survivor.who : survivor[field];
    // Check each label independently: a name alias may be retained in metadata
    // while another participant is explicit in the surviving statement. Requiring
    // the entire list to use just one kind of coverage rejects that combination.
    // This remains within a shared passage and the metadata compatibility guard.
    const aliasesRetained = sharedPassage && Array.isArray(removed[field]) && Array.isArray(retainedLabels)
      && (removed[field] as unknown[]).every(name => typeof name === "string"
        && ((retainedLabels as unknown[]).some(other => typeof other === "string"
          && (identityText(name) === identityText(other) || possibleEvidenceParticipantAlias(name, other, survivor, removed)))
          || field === "who" && (normal(survivor.what).includes(identityText(name)) || reporters.includes(identityText(name)))));
    if (original.length && !subset(original, retained)
      && !aliasesRetained
      && !(field === "who" && [...original, ...retained].every(name =>
        normal(survivor.what).includes(name) || reporters.includes(name)))
      && !(field === "reportedBy" && original.every(name => reporters.includes(name)))) return false;
  }
  // Facets are retained by union on a reviewed merge. Different facet sets
  // require semantic review, but do not by themselves prevent that review.
  const bareCommunication = sourceKind(survivor) === "event"
    && tag(survivor, "eventType:") === "eventtype:communication"
    && /\bspoke to\b/i.test(collapse(removed.what))
    && !/\bthat\b|[“”"]/.test(collapse(removed.what));
  const reference = recommendationReferenceSide(survivor, removed);
  const missingDate = missingDateComparison(survivor, removed);
  // Preserve the explicit modifier even when the reviewer calls it implicit
  // on the other side. A shared citation never replaces semantic approval.
  if (reference === "right") return false;
  if (!subset(removedNumbers, survivorNumbers)
    || !bareCommunication && qualifierSignature(missingDate?.left ?? survivor.what) !== qualifierSignature(missingDate?.right ?? removed.what)
      && !(reference === "left" && reviewableRecommendationReference(survivor, removed, source))) return false;
  return true;
}

/** Find source-local review leads. Similar wording never authorizes a merge by itself. */
export function findCanonicalizationPairs(documents: readonly Document[], options: DuplicateRetrievalOptions & {source?: EvidenceSource} = {}): CanonicalizationPair[] {
  return finishEvidenceComputation(canonicalizationPairSteps(documents, findDocumentDuplicateCandidates(documents, options), options));
}

export async function findCanonicalizationPairsAsync(documents: readonly Document[], options: DuplicateRetrievalOptions & {source?: EvidenceSource} = {}): Promise<CanonicalizationPair[]> {
  const candidates = await findDocumentDuplicateCandidatesAsync(documents, options);
  return runEvidenceComputation(canonicalizationPairSteps(documents, candidates, options));
}

function* canonicalizationPairSteps(documents: readonly Document[], candidates: DocumentDuplicateCandidate[],
  options: {source?: EvidenceSource}): Generator<void,CanonicalizationPair[]> {
  const pairs: CanonicalizationPair[] = [];
  for (const candidate of candidates) {
    yield;
    const left = documents[candidate.leftIndex].metadata, right = documents[candidate.rightIndex].metadata;
    const allowedSurvivors: Survivor[] = [];
    if (dominates(left, right, [], options.source)) allowedSurvivors.push("left");
    if (dominates(right, left, [], options.source)) allowedSurvivors.push("right");
    let metadataReview: MetadataReviewRequest | undefined;
    if (!allowedSurvivors.length && options.source && sourceSupportsMetadata(options.source, left, right)) {
      metadataReview = metadataReviewRequest(left, right, options.source);
      if (metadataReview.fields.length) {
        if (dominates(left, right, metadataReview.fields, options.source)) allowedSurvivors.push("left");
        if (dominates(right, left, metadataReview.fields, options.source)) allowedSurvivors.push("right");
      }
    }
    // Prefer the primary representation when both wordings preserve the same
    // details. Directional review still selects a fuller lower-ranked wording.
    const rank = {event:3, fact:2, claim:1};
    allowedSurvivors.sort((a, b) => rank[sourceKind(b === "left" ? left : right)]
      - rank[sourceKind(a === "left" ? left : right)]);
    if (allowedSurvivors.length) pairs.push({...candidate, allowedSurvivors, ...(metadataReview ? {metadataReview} : {})});
  }
  return pairs;
}

function mergeDocuments(survivor: Document, removed: Document, fields: readonly MetadataReviewField[],
  resolutions: Record<string, unknown>[], supportingSpans: SourceSpan[]): Document {
  const metadata = mergeEvidenceMetadata(survivor.metadata, removed.metadata, true, fields);
  if (!metadata) throw new Error("Reviewed evidence became incompatible before merging");
  const history = [survivor, removed].flatMap(document => Array.isArray(document.metadata.metadataResolutions)
    ? document.metadata.metadataResolutions : []);
  if (history.length || resolutions.length) {
    metadata.metadataResolutions = [...new Map([...history, ...resolutions].map(value => [JSON.stringify(value), value])).values()];
    metadata.sourceSpans = [...new Map([...(metadata.sourceSpans as SourceSpan[]), ...supportingSpans].map(span => [JSON.stringify(span), span])).values()];
    metadata.pages = [...new Set((metadata.sourceSpans as SourceSpan[]).map(span => span.pageNumber))];
  }
  return new Document({ metadata, pageContent: formatEvidenceContent(metadata) });
}

/** Apply only reviewed, compatible pairs. Complete-link clusters avoid transitive over-merges. */
export function applyCanonicalizationDecisions(documents: readonly Document[],
  pairs: readonly CanonicalizationPair[], decisions: readonly CanonicalizationDecision[], source?: EvidenceSource):
  { documents: Document[]; applied: AppliedCanonicalization[] } {
  return finishEvidenceComputation(canonicalizationDecisionSteps(documents,pairs,decisions,source));
}

export function applyCanonicalizationDecisionsAsync(documents: readonly Document[],
  pairs: readonly CanonicalizationPair[], decisions: readonly CanonicalizationDecision[], source?: EvidenceSource) {
  return runEvidenceComputation(canonicalizationDecisionSteps(documents,pairs,decisions,source));
}

function* canonicalizationDecisionSteps(documents: readonly Document[],
  pairs: readonly CanonicalizationPair[], decisions: readonly CanonicalizationDecision[], source?: EvidenceSource):
  Generator<void,{ documents: Document[]; applied: AppliedCanonicalization[] }> {
  const candidates = new Map(pairs.map(pair => [pair.id, pair]));
  const approved = new Map<string, CanonicalizationDecision>();
  for (const supplied of decisions) {
    yield;
    const pair = candidates.get(supplied.pairId);
    const detailsValid = pair && ["left", "right"].every(side => {
      const details = side === "left" ? supplied.leftOnlyDetails : supplied.rightOnlyDetails;
      const what: unknown = documents[side === "left" ? pair.leftIndex : pair.rightIndex]?.metadata.what;
      return typeof what === "string" && Array.isArray(details) && details.every(detail =>
        typeof detail === "string" && normalizeIdentityExcerpt(what, detail) === detail);
    });
    if (!pair || !detailsValid || supplied.semanticAssessment && (supplied.relation !== "same_assertion"
      || !SemanticAssessmentSchema.safeParse(supplied.semanticAssessment).success)) continue;
    const decision = {...supplied,...identityMaterialDetails(documents[pair.leftIndex].metadata, documents[pair.rightIndex].metadata,
      supplied.leftOnlyDetails, supplied.rightOnlyDetails), metadataResolutions:repairMetadataResolutions(pair.metadataReview,
        supplied.metadataResolutions, documents[pair.leftIndex].metadata, documents[pair.rightIndex].metadata, source)};
    if (pair.metadataReview && (!decision.semanticAssessment || decision.relation !== "same_assertion")) continue;
    if (recommendationReferenceSide(documents[pair.leftIndex].metadata, documents[pair.rightIndex].metadata)
      && (!decision.semanticAssessment || decision.relation !== "same_assertion")) continue;
    if (missingDateComparison(documents[pair.leftIndex].metadata, documents[pair.rightIndex].metadata)
      && (!decision.semanticAssessment || decision.relation !== "same_assertion")) continue;
    if (metadataResolutionIssues(pair.metadataReview, decision.metadataResolutions,
      documents[pair.leftIndex].metadata, documents[pair.rightIndex].metadata, source).length) continue;
    if (pair.allowedSurvivors.includes(decision.survivor) && decision.reason.trim()
      && semanticCoverageAllowsMerge(decision.semanticAssessment, decision.leftOnlyDetails, decision.rightOnlyDetails)
      && !hasDifferentAlternativeClauses(documents[pair.leftIndex].metadata, documents[pair.rightIndex].metadata)
      && !hasDifferentCausalAttribution(documents[pair.leftIndex].metadata, documents[pair.rightIndex].metadata)
      && !hasDifferentIllustrativeScope(documents[pair.leftIndex].metadata, documents[pair.rightIndex].metadata)
      && !reviewedStatementDetailLosses(documents[decision.survivor === "left" ? pair.leftIndex : pair.rightIndex].metadata,
        documents[decision.survivor === "left" ? pair.rightIndex : pair.leftIndex].metadata, decision.semanticAssessment, source).length
      && (decision.survivor === "left" ? decision.rightOnlyDetails : decision.leftOnlyDetails).length === 0
      && !reviewedContextIssues(documents[pair.leftIndex].metadata, documents[pair.rightIndex].metadata,
        decision.leftOnlyDetails, decision.rightOnlyDetails,
        identityEnrichmentIssues(documents[pair.leftIndex].metadata, documents[pair.rightIndex].metadata,
          decision.leftOnlyDetails, decision.rightOnlyDetails), decision.semanticAssessment).length
      && !unreportedContainmentDetails(documents[pair.leftIndex].metadata, documents[pair.rightIndex].metadata,
        decision.leftOnlyDetails, decision.rightOnlyDetails).length) {
      approved.set(pair.id, decision);
    }
  }
  const representatives = documents.map((_, index) => index);
  const members = documents.map((_, index) => new Set([index]));
  const current = [...documents];
  const find = (index: number): number => {
    while (representatives[index] !== index) index = representatives[index];
    return index;
  };
  const applied: AppliedCanonicalization[] = [];
  for (const pair of pairs) {
    yield;
    const decision = approved.get(pair.id);
    if (!decision) continue;
    const left = find(pair.leftIndex);
    const right = find(pair.rightIndex);
    if (left === right) continue;
    const survivorIndex = decision.survivor === "left" ? left : right;
    const removedIndex = decision.survivor === "left" ? right : left;
    if (hasAddedEvidenceAssertion(current[survivorIndex].metadata, current[removedIndex].metadata)) continue;
    const completeLink = [...members[survivorIndex]].every(first => [...members[removedIndex]].every(second =>
      approved.has(`${Math.min(first, second)}:${Math.max(first, second)}`)));
    if (!completeLink) continue;
    // Earlier merges can change which original statement represents a pair.
    // Every member must have a direct approval to keep this actual statement;
    // approval in the opposite direction cannot prove its detail coverage.
    const retainsMembers = [...members[survivorIndex], ...members[removedIndex]].every(member => {
      if (member === survivorIndex) return true;
      const id = `${Math.min(survivorIndex, member)}:${Math.max(survivorIndex, member)}`;
      const edge = candidates.get(id), approval = approved.get(id);
      return edge && approval && (approval.survivor === "left" ? edge.leftIndex : edge.rightIndex) === survivorIndex;
    });
    if (!retainsMembers) continue;
    // Every cross-cluster edge has independently passed resolution and meaning
    // checks. Permissions come from those original approvals, never stored labels
    // or an unreviewed transitive identity map.
    const fields = new Set<MetadataReviewField>();
    const resolutions: Record<string, unknown>[] = [], supportingSpans: SourceSpan[] = [];
    for (const first of members[survivorIndex]) for (const second of members[removedIndex]) {
      const id = `${Math.min(first, second)}:${Math.max(first, second)}`;
      const edge = candidates.get(id)!, approval = approved.get(id)!;
      for (const field of edge.metadataReview?.fields ?? []) fields.add(field);
      if (edge.metadataReview) {
        resolutions.push({pairId:id, sourceContentHash:documents[first].metadata.sourceContentHash,
          originals: [edge.leftIndex, edge.rightIndex].map(index => ({what:documents[index].metadata.what,
            fields:Object.fromEntries(edge.metadataReview!.fields.map(field => [field, documents[index].metadata[field]]))})),
          resolutions:approval.metadataResolutions,
          evidence:(approval.metadataResolutions ?? []).flatMap(resolution => resolution.citations.map(citation => ({
            field:resolution.field, side:citation.side, citationIndex:citation.citationIndex,
            ...(citation.side === "document" ? edge.metadataReview!.documentContext[citation.citationIndex]
              : documents[citation.side === "left" ? edge.leftIndex : edge.rightIndex].metadata.sourceSpans[citation.citationIndex]),
          })))});
        for (const resolution of approval.metadataResolutions ?? []) for (const citation of resolution.citations) {
          if (citation.side === "document") supportingSpans.push(edge.metadataReview.documentContext[citation.citationIndex]);
        }
      }
    }
    if (!dominates(current[survivorIndex].metadata, current[removedIndex].metadata, [...fields], source)) continue;
    current[survivorIndex] = mergeDocuments(current[survivorIndex], current[removedIndex], [...fields], resolutions, supportingSpans);
    for (const member of members[removedIndex]) members[survivorIndex].add(member);
    representatives[removedIndex] = survivorIndex;
    applied.push({ pairId: pair.id, survivorIndex, removedIndex });
  }
  return { documents: current.filter((_, index) => find(index) === index), applied };
}
