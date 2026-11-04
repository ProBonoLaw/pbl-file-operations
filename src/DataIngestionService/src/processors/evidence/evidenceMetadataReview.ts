import { z } from "zod";
import { createHash } from "node:crypto";
import type { EvidenceSource, SourceSpan } from "./evidenceSource.js";
import { evidencePrimarySpan, identityText } from "./evidencePageIdentity.js";
import { knownIdentityLabels, knownMetadataText } from "./evidenceMetadataValues.js";

export const METADATA_REVIEW_FIELDS = ["who", "subject", "reportedBy", "claimant", "claimPolarity", "where", "eventStructure"] as const;
export type MetadataReviewField = typeof METADATA_REVIEW_FIELDS[number];
type Metadata = Record<string, unknown>;
const inputHash = (left: Metadata, right: Metadata) => createHash("sha256").update(JSON.stringify([left, right])).digest("hex");
export interface MetadataReviewRequest {
  inputHash: string;
  fields: MetadataReviewField[];
  documentContext: SourceSpan[];
}
export const MetadataResolutionSchema = z.object({
  field: z.enum(METADATA_REVIEW_FIELDS),
  explanation: z.string().describe("Resolve every conflicting value in this field using source evidence. Identify aliases and relationships explicitly; contextual participants need not be the same entity. Explain why the difference does not change the assertion."),
  citations: z.array(z.object({
    side: z.enum(["left", "right", "document"]),
    citationIndex: z.number().int().nonnegative(),
    sourceQuote: z.string().describe("Exact supporting excerpt at the specified citation index. Cite both records, plus document context where needed to establish identity or annotation equivalence."),
  })).min(2),
});
type MetadataCitation = z.infer<typeof MetadataResolutionSchema>["citations"][number];
export type MetadataResolution = z.infer<typeof MetadataResolutionSchema> & {
  /** Application-generated provenance; never requested from the model. */
  citationRepairs?: {original: MetadataCitation; corrected: MetadataCitation}[];
};

const known = (value: unknown) => {
  return identityText(knownMetadataText(value));
};
const differingFields = (left: Metadata, right: Metadata) =>
  METADATA_REVIEW_FIELDS.filter(field => JSON.stringify(left[field]) !== JSON.stringify(right[field]));

/** Missing annotations and subset lists can be retained by union. Only
 * competing known values need an additional identity/annotation resolution.
 * Structured event roles continue to use their dedicated compatibility rules.
 */
export function metadataConflictFields(left: Metadata, right: Metadata): MetadataReviewField[] {
  return differingFields(left, right).filter(field => {
    if (field === "eventStructure") return true;
    if (["who", "subject", "reportedBy"].includes(field)) {
      const a = knownIdentityLabels(left[field]), b = knownIdentityLabels(right[field]);
      return !a.every(label => b.includes(label)) && !b.every(label => a.includes(label));
    }
    const a = known(left[field]), b = known(right[field]);
    return !!a && !!b && a !== b;
  });
}

function matchingRequest(request: MetadataReviewRequest, left: Metadata, right: Metadata): boolean {
  // Previously stored requests listed every differing field, including omissions.
  return request.inputHash === inputHash(left, right) && [metadataConflictFields(left, right), differingFields(left, right)]
    .some(fields => JSON.stringify(fields) === JSON.stringify(request.fields));
}

/** Source context makes a metadata disagreement reviewable, never equivalent.
 * Legacy callers without the source retain strict metadata eligibility.
 */
export function metadataReviewRequest(left: Metadata, right: Metadata, source: EvidenceSource): MetadataReviewRequest {
  const fields = metadataConflictFields(left, right);
  const query = [left, right].flatMap(metadata => [metadata.what, metadata.claimant,
    ...["who", "subject", "reportedBy"].flatMap(field => Array.isArray(metadata[field]) ? metadata[field] : [])]).join(" ");
  const page = evidencePrimarySpan(left)!.pageNumber;
  const passages = [...source.context.lookup(page, query, "review", 6),
    ...source.context.lookup(page, query, "attribution", 4), ...source.context.identities(page, 3),
    ...source.context.participantIdentities(page)];
  const documentContext = [...new Map(passages.map(({pageNumber, sourceOffset, sourceQuote}) => {
    const span = {pageNumber, sourceOffset, sourceQuote};
    return [JSON.stringify(span), span];
  })).values()];
  return {inputHash:inputHash(left, right), fields, documentContext};
}

export function sourceSupportsMetadata(source: EvidenceSource, left: Metadata, right: Metadata): boolean {
  const a = evidencePrimarySpan(left), b = evidencePrimarySpan(right);
  return !!a && !!b && a.pageNumber === b.pageNumber && left.accountId === right.accountId
    && !!left.sourceId && left.sourceId === right.sourceId
    && left.sourceContentHash === source.contentHash && right.sourceContentHash === source.contentHash
    && [left, right].every(metadata => Array.isArray(metadata.sourceSpans)
      && metadata.sourceSpans.every(span => validSourceSpan(source, span)));
}

function validSourceSpan(source: EvidenceSource, span: SourceSpan): boolean {
  return !!span && Number.isInteger(span.sourceOffset) && span.sourceOffset >= 0
    && typeof span.sourceQuote === "string" && !!span.sourceQuote.trim()
    && source.pages.find(page => page.pageNumber === span.pageNumber)?.text
      .slice(span.sourceOffset, span.sourceOffset + span.sourceQuote.length) === span.sourceQuote;
}

/** Match explicit ellipsis fragments in order within ONE supplied passage.
 * Expand back to source text; never remove punctuation/words to invent a quote.
 * Ambiguous fragments or omitted qualifications need a reviewer correction.
 */
function abbreviatedQuoteMatches(quote: string, sourceQuote: string): boolean {
  const text = identityText(sourceQuote);
  const parts = identityText(quote).split(/(?:\[\s*)?\.{3,}(?:\s*\])?/u).map(part => part.trim());
  if (parts.length < 2 || parts.some(part => (part.match(/[\p{L}\p{N}]+/gu) ?? []).length < 2)) return false;
  let end = 0;
  for (const [index, part] of parts.entries()) {
    const start = text.indexOf(part, end);
    if (start < 0 || text.indexOf(part, start + 1) >= 0) return false;
    if (index && /\b(?:no|not|never|without|unless|except|but|however|denied|denies|may|might|could|if|alleged)\b/u.test(text.slice(end, start))) return false;
    end = start + part.length;
  }
  return true;
}

/** Repair citation packaging only, within its declared side and the validated
 * pair context. The returned quote is the original source passage, including
 * omitted text. Unmatched/ambiguous references remain invalid and earn retry.
 */
export function repairMetadataResolutions(request: MetadataReviewRequest | undefined, resolutions: readonly MetadataResolution[] | undefined,
  left: Metadata, right: Metadata, source?: EvidenceSource): MetadataResolution[] | undefined {
  if (!request?.fields.length) return resolutions?.length ? [] : resolutions as MetadataResolution[] | undefined;
  if (!source || !matchingRequest(request, left, right) || !sourceSupportsMetadata(source, left, right)
    || request.documentContext.some(span => !validSourceSpan(source, span))) return resolutions as MetadataResolution[] | undefined;
  const required = metadataConflictFields(left, right);
  return resolutions?.filter(row => required.includes(row.field)).map(row => {
    if (!MetadataResolutionSchema.safeParse(row).success) return row;
    const repairs = [...(row.citationRepairs ?? [])];
    const citations = row.citations.map(citation => {
      const spans: SourceSpan[] = citation.side === "document" ? request.documentContext
        : (citation.side === "left" ? left : right).sourceSpans as SourceSpan[];
      const quote = identityText(citation.sourceQuote), span = spans[citation.citationIndex];
      if (!quote || span && identityText(span.sourceQuote).includes(quote)) return citation;
      let index = span && abbreviatedQuoteMatches(citation.sourceQuote, span.sourceQuote) ? citation.citationIndex : -1;
      if (index < 0 && (quote.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 3) {
        const matches = spans.flatMap((candidate, i) => identityText(candidate.sourceQuote).includes(quote)
          || abbreviatedQuoteMatches(citation.sourceQuote, candidate.sourceQuote) ? [i] : []);
        if (matches.length === 1) index = matches[0];
      }
      if (index < 0) return citation;
      const corrected = {...citation, citationIndex:index, sourceQuote:spans[index].sourceQuote};
      repairs.push({original:{...citation}, corrected});
      return corrected;
    });
    return {...row, citations, ...(repairs.length ? {citationRepairs:repairs} : {})};
  });
}

/** Recheck every required resolution against the original records and source.
 * Text existence grounds the model's judgment; it does not prove equivalence.
 */
export function metadataResolutionIssues(request: MetadataReviewRequest | undefined, resolutions: readonly MetadataResolution[] | undefined,
  left: Metadata, right: Metadata, source?: EvidenceSource): string[] {
  if (!request?.fields.length) return resolutions?.length ? ["unexpected metadata resolutions"] : [];
  if (!matchingRequest(request, left, right)) {
    return ["metadata review no longer matches the original pair"];
  }
  if (!source || !sourceSupportsMetadata(source, left, right)) return ["metadata review requires the matching validated document"];
  if (request.documentContext.some(span => !validSourceSpan(source, span))) return ["document identity context is not source-grounded"];
  const issues: string[] = [];
  const rows = resolutions ?? [];
  const fields = metadataConflictFields(left, right);
  if (rows.some(row => !fields.includes(row.field))) issues.push("unexpected metadata field resolution");
  for (const field of fields) {
    const matches = rows.filter(row => row.field === field);
    if (matches.length !== 1 || !MetadataResolutionSchema.safeParse(matches[0]).success) {
      issues.push(`${field}: require one explicit metadata resolution`); continue;
    }
    const resolution = matches[0];
    if (!resolution.explanation.trim()) issues.push(`${field}: missing identity/annotation explanation`);
    if (!["left", "right"].every(side => resolution.citations.some(citation => citation.side === side))) {
      issues.push(`${field}: cite evidence from both records`);
    }
    for (const citation of resolution.citations) {
      const spans = citation.side === "document" ? request.documentContext
        : (citation.side === "left" ? left : right).sourceSpans as SourceSpan[];
      const span = spans[citation.citationIndex];
      if (!span || !identityText(citation.sourceQuote) || !identityText(span.sourceQuote).includes(identityText(citation.sourceQuote))) {
        issues.push(`${field}: unsupported ${citation.side} citation ${citation.citationIndex}`);
      }
    }
  }
  return issues;
}
