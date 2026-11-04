import { createHash } from "node:crypto";
import { EVIDENCE_CONTENT_VERSION, formatEvidenceContent } from "./evidenceContent.js";
import { evidenceSearchValues } from "./evidenceSearchProjection.js";
import { reclassifyUndatedEventMetadata } from "./evidenceEventDatePolicy.js";

export interface StoredEvidence extends Partial<ReturnType<typeof evidenceSearchValues>> {
  id: string;
  content: string;
  metadata: string;
  asOf?: unknown;
  tags?: string[];
  whenStarted?: unknown;
  whenEnded?: unknown;
}

export type EvidenceContentUpdate = {
  status: "update";
  document: { id: string; content: string; metadata: string; asOf: unknown; tags?: string[];
    whenStarted?: unknown; whenEnded?: unknown; content_vector?: number[] }
    & ReturnType<typeof evidenceSearchValues>;
  needsEmbedding: boolean;
  reclassifiedUndatedEvent: boolean;
  originalFingerprint: string;
} | { status: "current" | "unsupported" };

function fingerprint(record: StoredEvidence): string {
  return createHash("sha256").update(JSON.stringify([record.content, record.metadata, record.asOf ?? null,
    record.tags ?? null, record.whenStarted ?? null, record.whenEnded ?? null, storedProjection(record)])).digest("hex");
}

function storedProjection(record: StoredEvidence) {
  return Object.fromEntries(Object.keys(evidenceSearchValues({})).map(key =>
    [key, record[key as keyof StoredEvidence] ?? null]));
}

function searchDate(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const date = value as Record<string, unknown>;
  return Object.fromEntries(["year", "month", "day", "season", "quarter"].map(key => [key, date[key] ?? null]));
}

/** Reconstruct only known complete evidence records, never arbitrary search chunks. */
export function prepareEvidenceContentUpdate(record: StoredEvidence): EvidenceContentUpdate {
  const metadata = JSON.parse(record.metadata) as Record<string, any>;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Invalid evidence metadata");
  if (metadata.evidenceSchemaVersion !== undefined && !["1", "2", "3"].includes(String(metadata.evidenceSchemaVersion))) {
    return { status: "unsupported" };
  }
  if (metadata.evidenceContentVersion !== undefined
    && !["1", "2", EVIDENCE_CONTENT_VERSION].includes(metadata.evidenceContentVersion as string)) {
    return { status: "unsupported" };
  }
  const kind = metadata.claimType ? "claim" : metadata.factType ? "fact"
    : Array.isArray(metadata.tags) && metadata.tags.includes("event") ? "event" : null;
  if (!kind) return { status: "unsupported" };
  let spans = metadata.sourceSpans;
  if (!spans && !metadata.evidenceSchemaVersion && Array.isArray(metadata.pages) && metadata.pages.length === 1) {
    spans = [{ pageNumber: metadata.pages[0], sourceOffset: metadata.sourceOffset, sourceQuote: metadata.sourceQuote }];
  }
  if (!Array.isArray(spans) || spans.length === 0) return { status: "unsupported" };
  // Validate the stored kind before changing it, so a split fragment cannot be
  // mistaken for a complete event and rewritten as a new fact.
  const originalContent = formatEvidenceContent({ ...metadata, sourceSpans: spans });
  const citations = spans.map((span: { pageNumber: number; sourceQuote: string }, index: number) =>
    `\n${index ? "Supporting" : "Source"} page: ${span.pageNumber}\n${index ? "Supporting" : "Source"} quote: ${span.sourceQuote}`).join("");
  const oldPrefix = kind === "claim" ? `${metadata.claimant} - ${metadata.what}`
    : kind === "fact" ? `Fact - ${metadata.what}`
    : `${JSON.stringify(metadata.whenStarted)} - ${(metadata.who ?? []).join(", ")} - ${metadata.what}`;
  // Embedding overflow can split an evidence entry. Rebuilding each fragment as
  // the complete item would create duplicates; require a recognized full record.
  if (record.content !== originalContent && record.content !== oldPrefix + citations) return { status: "unsupported" };

  const reclassified = reclassifyUndatedEventMetadata({...metadata,sourceSpans:spans});
  const updatedMetadata = reclassified ?? metadata;
  const content = formatEvidenceContent({...updatedMetadata,sourceSpans:spans});
  const updatedKind = updatedMetadata.claimType ? "claim" : updatedMetadata.factType ? "fact" : "event";
  const asOf = updatedKind === "fact" ? searchDate(updatedMetadata.asOf) : null;
  const retrieval = evidenceSearchValues({...updatedMetadata, sourceSpans:spans});
  const tags = Array.isArray(updatedMetadata.tags) ? updatedMetadata.tags as string[] : undefined;
  if (record.content === content && metadata.evidenceContentVersion === EVIDENCE_CONTENT_VERSION
    && JSON.stringify(searchDate(record.asOf)) === JSON.stringify(asOf)
    && (record.tags === undefined || JSON.stringify(record.tags) === JSON.stringify(tags))
    && JSON.stringify(storedProjection(record)) === JSON.stringify(retrieval)) return { status: "current" };

  return {
    status: "update", needsEmbedding: record.content !== content,
    reclassifiedUndatedEvent: !!reclassified,
    originalFingerprint: fingerprint(record),
    document: {
      id: record.id, content, asOf,
      ...retrieval,
      ...(tags ? {tags} : {}),
      ...(reclassified ? {whenStarted:searchDate(updatedMetadata.whenStarted),whenEnded:searchDate(updatedMetadata.whenEnded)} : {}),
      metadata: JSON.stringify({ ...updatedMetadata, evidenceContentVersion: EVIDENCE_CONTENT_VERSION }),
    },
  };
}

export async function applyEvidenceContentUpdate(
  update: Extract<EvidenceContentUpdate, { status: "update" }>,
  dependencies: {
    dimensions: number;
    embed(text: string): Promise<number[]>;
    read(id: string): Promise<StoredEvidence>;
    merge(document: Extract<EvidenceContentUpdate, { status: "update" }>["document"]): Promise<void>;
  },
): Promise<void> {
  const document = { ...update.document };
  if (update.needsEmbedding) {
    const vector = await dependencies.embed(document.content);
    if (vector.length !== dependencies.dimensions || !vector.every(Number.isFinite)) {
      throw new Error("Backfill embedding does not match the index vector dimensions");
    }
    document.content_vector = vector;
  }
  const latest = await dependencies.read(document.id);
  if (fingerprint(latest) !== update.originalFingerprint) {
    throw new Error(`Evidence record ${document.id} changed during backfill; rerun after ingestion finishes`);
  }
  // Merge keeps the existing ID and unrelated fields. Unlike merge-or-upload,
  // it cannot recreate a record that was deleted after the read.
  await dependencies.merge(document);
}
