import { createHash } from "node:crypto";
import { Document } from "@langchain/core/documents";
import { EVIDENCE_CONTENT_VERSION, formatEvidenceContent, formatEvidenceDate } from "./evidenceContent.js";
import { validateEventDateDecision } from "./evidenceEventDates.js";

const emptyDate = () => ({ year: null, month: null, day: null, season: null, quarter: null });
const people = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((name): name is string => typeof name === "string").map(name => name.trim()).filter(Boolean))] : [];

/** A bounded occurrence has dates even though neither bound is an actual start/end. */
export function hasEventDate(metadata: Record<string, unknown>): boolean {
  if (metadata.eventDateResolution) {
    const resolution = validateEventDateDecision(metadata.eventDateResolution);
    if (resolution.status !== "dated") return false;
    if (resolution.relation === "bounded") {
      return !!formatEvidenceDate(resolution.start) && !!formatEvidenceDate(resolution.end);
    }
  }
  return !!(formatEvidenceDate(metadata.whenStarted) || formatEvidenceDate(metadata.whenEnded));
}

/** Preserve an undated occurrence as a cited fact; contextual claim rules run afterward. */
export function reclassifyUndatedEventMetadata(metadata: Record<string, unknown>): Record<string, unknown> | null {
  const tags = people(metadata.tags);
  if (metadata.claimType || metadata.factType || !tags.includes("event") || hasEventDate(metadata)) return null;
  const spans = metadata.sourceSpans;
  if (!Array.isArray(spans) || !spans.length) throw new Error("Undated event requires source citations");
  const subject = people(metadata.who);
  const eventType = typeof metadata.eventType === "string" ? metadata.eventType : null;
  const original = {eventType, whenStarted:metadata.whenStarted ?? null, whenEnded:metadata.whenEnded ?? null,
    eventDateResolution:metadata.eventDateResolution ?? null, tags};
  const trace = {
    id:createHash("sha256").update(JSON.stringify(["undated-event-date-policy-1", metadata.sourceContentHash,
      spans[0], original])).digest("hex"),
    version:"undated-event-date-policy-1", ruleId:"undated-event-to-fact", action:"reclassified",
    reason:"No source-supported calendar date or bounded occurrence date was established.",
    original, cue:{...spans[0],section:""},
  };
  const result:Record<string, unknown> = {
    ...metadata,
    tags:[...new Set(tags.filter(tag => tag !== "event" && !tag.startsWith("eventType:")
      && !tag.startsWith("factType:")).concat("fact", "factType:undatedOccurrence"))],
    factType:"undatedOccurrence", subject, reportedBy:[], asOf:emptyDate(),
    whenStarted:emptyDate(), whenEnded:null,
    headers:["undatedOccurrence",metadata.where ?? "Unknown",JSON.stringify(emptyDate())],
    classificationHistory:[...(Array.isArray(metadata.classificationHistory) ? metadata.classificationHistory : []),trace],
    evidenceContentVersion:EVIDENCE_CONTENT_VERSION,
  };
  delete result.eventType;
  return result;
}

export function reclassifyUndatedEvents(documents: readonly Document[]): {documents: Document[]; count: number} {
  let count = 0;
  const updated = documents.map(document => {
    const metadata = reclassifyUndatedEventMetadata(document.metadata);
    if (!metadata) return document;
    count++;
    return new Document({metadata,pageContent:formatEvidenceContent(metadata)});
  });
  return {documents:updated,count};
}
