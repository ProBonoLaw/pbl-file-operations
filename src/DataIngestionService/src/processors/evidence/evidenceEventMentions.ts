import { createHash } from "node:crypto";
import { Document } from "@langchain/core/documents";
import { eventDateMeaning } from "./evidenceEventDates.js";
import { eventRoleSignature, validateResolvedEventStructure } from "./evidenceEventStructure.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normal = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const qualifiers = (text: string) => [
  /\b(?:not|never|no|denied|denies|failed|without)\b/i.test(text),
  /\b(?:may|might|could|possible|possibly|alleged|suspected)\b/i.test(text),
  /\b(?:should|recommended|recommendation|would|will)\b/i.test(text),
];

/** Document-local, bounded retrieval leads. These never authorize a merge or assert coreference. */
export function linkEventMentions(documents: readonly Document[]): {documents: Document[]; pairCount: number} {
  const buckets = new Map<string, number[]>();
  const ids = new Map<number, string>();
  const links = new Map<number, Set<string>>();
  let pairCount = 0;
  documents.forEach((document, index) => {
    const m = document.metadata;
    if (!m.eventStructure || m.claimType || m.factType || !m.sourceContentHash) return;
    const structure = validateResolvedEventStructure(m.eventStructure, m.sourceSpans);
    const dates = [m.whenStarted, m.whenEnded].map(date =>
      ["year", "month", "day", "season", "quarter"].map(part => date?.[part] ?? null));
    const type = (m.tags as string[]).find(tag => tag.startsWith("eventType:"));
    const id = "event:" + hash([m.sourceContentHash, m.sourceId, m.sourceSpans[0], m.what, type,
      eventRoleSignature(structure), dates, eventDateMeaning(m.eventDateResolution)]);
    ids.set(index, id);
    links.set(index, new Set());
    if (!structure.roles.length || !type || type === "eventType:other") return;
    const key = JSON.stringify([m.sourceContentHash, m.sourceId, type, eventRoleSignature(structure), dates,
      eventDateMeaning(m.eventDateResolution), [...new Set((m.what as string).match(/\b\d+(?:[.,:/-]\d+)*\b/g) ?? [])].sort(),
      qualifiers(m.what)]);
    const bucket = buckets.get(key) ?? [];
    const tokens = (text: string) => new Set(normal(text).match(/[\p{L}\p{N}]+/gu) ?? []);
    const words = tokens(m.what);
    for (const other of bucket.slice(-32)) {
      if (links.get(index)!.size >= 8) break;
      if (ids.get(other) === id || links.get(other)!.size >= 8) continue;
      const previous = documents[other].metadata;
      if (previous.sourceSpans[0].pageNumber === m.sourceSpans[0].pageNumber
        && previous.sourceSpans[0].sourceOffset === m.sourceSpans[0].sourceOffset) continue;
      const otherWords = tokens(previous.what);
      const overlap = [...words].filter(word => otherWords.has(word)).length;
      if (overlap / Math.max(1, new Set([...words, ...otherWords]).size) < 0.6) continue;
      links.get(index)!.add(ids.get(other)!);
      links.get(other)!.add(id);
      pairCount++;
    }
    bucket.push(index);
    buckets.set(key, bucket);
  });
  return {pairCount, documents: documents.map((document, index) => ids.has(index)
    ? new Document({pageContent: document.pageContent, metadata: {...document.metadata,
      eventMentionId: ids.get(index), possibleRelatedEventMentionIds: [...links.get(index)!]}}) : document)};
}
