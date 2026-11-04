import type { Document } from "@langchain/core/documents";
import type { CanonicalizationPair } from "./evidenceCanonicalization.js";
import type { EvidenceSource, SourceSpan } from "./evidenceSource.js";
import { eventCitationId, validateResolvedEventStructure } from "./evidenceEventStructure.js";
import { get_encoding } from "tiktoken";
import { canonicalizationReviewBatches } from "./evidenceCanonicalization.js";
import { compactEvidencePrompt, type PromptIdentityScope } from "./evidenceCompactPrompt.js";

/** Payload estimates include compact-input decoding instructions, but exclude
 * system prompts, response schemas, generated output, and provider cache effects.
 */
export function measureCanonicalizationPlan(pairs: readonly CanonicalizationPair[], documents: readonly Document[],
  source: EvidenceSource, scope: PromptIdentityScope) {
  const encoding = get_encoding("o200k_base");
  const inputs = new Map(pairs.map(pair => [pair.id, canonicalizationPairInput(pair, documents, source)]));
  const measure = (grouped: boolean, compact: boolean) => canonicalizationReviewBatches(pairs, grouped).reduce((total, batch) => {
    const content = JSON.stringify({pairs: batch.map(pair => inputs.get(pair.id))});
    return total + (compact ? compactEvidencePrompt(content, "canonicalization", source, scope, "json").tokens
      : encoding.encode(content).length);
  }, 0);
  try {
    return { pairCount: pairs.length, batchCount: canonicalizationReviewBatches(pairs).length,
      sequentialPayloadTokens: measure(false, false), sequentialCompactPayloadTokens: measure(false, true),
      groupedCompactPayloadTokens: measure(true, true) };
  } finally { encoding.free(); }
}

export function canonicalizationPairInput(pair: CanonicalizationPair, documents: readonly Document[], source: EvidenceSource) {
  const record = (index: number) => {
    const metadata = documents[index].metadata;
    const primary = metadata.sourceSpans[0] as SourceSpan;
    const structure = metadata.eventStructure ? validateResolvedEventStructure(metadata.eventStructure, metadata.sourceSpans) : null;
    const roles = structure?.roles.map(role => ({role: role.role, participant: role.participant,
      citations: role.citationIds.map(id => (metadata.sourceSpans as SourceSpan[]).findIndex(span => eventCitationId(span) === id))}));
    const requiredCitations = new Set(roles?.flatMap(role => role.citations) ?? []);
    return {
      assertion: {
        what: metadata.what,
        who: metadata.who, subject: metadata.subject, reportedBy: metadata.reportedBy,
        eventDateResolution: metadata.eventDateResolution,
        ...(structure ? {eventStructure: {trigger: structure.trigger?.sourceQuote ?? "", roles}} : {}),
        claimant: metadata.claimant, claimType: metadata.claimType, claimPolarity: metadata.claimPolarity,
        factType: metadata.factType, tags: metadata.tags,
        where: metadata.where, why: metadata.why,
        whenStarted: metadata.whenStarted, whenEnded: metadata.whenEnded, asOf: metadata.asOf,
      },
      evidenceContext: {
        primary: { citationIndex: 0, pageNumber: primary.pageNumber, sourceOffset: primary.sourceOffset,
          sourceQuote: requiredCitations.has(0) ? primary.sourceQuote : primary.sourceQuote.slice(0, 1_500), ...source.quoteContext(primary, 160) },
        // Later citations can complete an assertion across a page boundary.
        // Retain their original indexes for event roles; bound each excerpt.
        supportingQuotes: (metadata.sourceSpans as SourceSpan[]).flatMap((span, index) => index > 0 ? [{
          citationIndex: index, pageNumber: span.pageNumber, sourceQuote: requiredCitations.has(index) ? span.sourceQuote : span.sourceQuote.slice(0, 600),
        }] : []),
      },
    };
  };
  return { pairId: pair.id,
    ...(pair.metadataReview ? {metadataReview:{fields:pair.metadataReview.fields,
      documentContext:pair.metadataReview.documentContext.map((span, citationIndex) => ({...span, citationIndex}))}} : {}),
    left: record(pair.leftIndex), right: record(pair.rightIndex) };
}
