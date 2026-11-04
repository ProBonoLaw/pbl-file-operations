import { createHash } from "node:crypto";
import { EVIDENCE_CONTENT_VERSION, formatEvidenceContent } from "./evidenceContent.js";
import { evidenceSearchValues } from "./evidenceSearchProjection.js";
import type { EvidenceSource, SourceSpan } from "./evidenceSource.js";

export interface StoredLocationEvidence {
  id: string;
  sourceId: string;
  content: string;
  metadata: string;
  where?: string;
  pages?: number[];
}

export interface LocationDecision {
  where: string | null;
  reason: string;
  supportingQuotes: {pageNumber: number; quote: string}[];
}

const fingerprint = (record: StoredLocationEvidence) => createHash("sha256")
  .update(JSON.stringify([record.id, record.sourceId, record.content, record.metadata, record.where, record.pages])).digest("hex");

/** The caller reviews semantic support; this gate verifies source identity and citations. */
export function prepareEvidenceLocationUpdate(record: StoredLocationEvidence, source: EvidenceSource,
  decision: LocationDecision, reviewer: string) {
  const metadata = JSON.parse(record.metadata);
  if (!metadata || metadata.evidenceContentVersion !== EVIDENCE_CONTENT_VERSION
    || String(metadata.evidenceSchemaVersion) !== "3" || !Array.isArray(metadata.sourceSpans)
    || !metadata.sourceSpans.length || record.content !== formatEvidenceContent(metadata))
    throw new Error("Location repair requires a complete current evidence record");
  if (record.sourceId !== String(source.document.metadata.sourceId) || metadata.sourceId !== record.sourceId
    || metadata.sourceContentHash !== source.contentHash)
    throw new Error("Location repair source does not match the indexed evidence");
  if ((record.where ?? "Unknown") !== (metadata.where ?? "Unknown"))
    throw new Error("Indexed and metadata locations disagree");
  if (!decision.where || decision.where.trim().toLowerCase() === "unknown"
    || (metadata.where ?? "Unknown").trim().toLowerCase() !== "unknown") return null;
  if (!decision.reason.trim() || !reviewer.trim() || !decision.supportingQuotes.length)
    throw new Error("Location repair requires a reviewer, reason, and supporting quotations");
  const spans: SourceSpan[] = [...metadata.sourceSpans];
  for (const span of spans) {
    const page = source.pages.find(page => page.pageNumber === span.pageNumber);
    if (!Number.isInteger(span.sourceOffset) || span.sourceOffset < 0 || !span.sourceQuote
      || page?.text.slice(span.sourceOffset, span.sourceOffset + span.sourceQuote.length) !== span.sourceQuote)
      throw new Error("Stored evidence citation does not match the source");
  }
  const supporting = decision.supportingQuotes.map(quote => {
    const span = source.locateSupporting(quote.pageNumber, quote.quote);
    if (!span) throw new Error("Location quotation is absent or ambiguous in the source");
    return span;
  });
  for (const span of supporting) {
    if (!spans.some(existing => existing.pageNumber === span.pageNumber
      && existing.sourceOffset === span.sourceOffset && existing.sourceQuote === span.sourceQuote)) spans.push(span);
  }
  const where = decision.where.trim();
  const pages = [...new Set([...(metadata.pages ?? []), ...spans.map(span => span.pageNumber)])];
  const headers = Array.isArray(metadata.headers) ? [...metadata.headers] : undefined;
  if (headers && !metadata.claimType) headers[metadata.factType ? 1 : 0] = where;
  const updated = {...metadata, where, pages, sourceSpans: spans,
    ...(headers ? {headers} : {}),
    locationResolution: {version: "1", previous: metadata.where ?? "Unknown", reviewer,
      reason: decision.reason, supportingSpans: supporting}};
  return {originalFingerprint: fingerprint(record), document: {id: record.id, where, pages,
    content: formatEvidenceContent(updated), metadata: JSON.stringify(updated), ...evidenceSearchValues(updated)}};
}

export type EvidenceLocationUpdate = NonNullable<ReturnType<typeof prepareEvidenceLocationUpdate>>;

/** Merge the same record with matching text/vector; never recreate a deleted record. */
export async function applyEvidenceLocationUpdate(update: EvidenceLocationUpdate, dependencies: {
  dimensions: number;
  embed(content: string): Promise<number[]>;
  read(id: string): Promise<StoredLocationEvidence>;
  merge(document: EvidenceLocationUpdate["document"] & {content_vector: number[]}): Promise<void>;
}): Promise<void> {
  const vector = await dependencies.embed(update.document.content);
  if (vector.length !== dependencies.dimensions || !vector.every(Number.isFinite))
    throw new Error("Location embedding does not match the index vector dimensions");
  if (fingerprint(await dependencies.read(update.document.id)) !== update.originalFingerprint)
    throw new Error("Evidence changed during location repair");
  await dependencies.merge({...update.document, content_vector: vector});
}
