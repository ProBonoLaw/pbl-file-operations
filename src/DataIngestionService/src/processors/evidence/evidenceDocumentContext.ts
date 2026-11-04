import { createHash } from "node:crypto";
import type { SourceSpan } from "./evidenceSource.js";

export interface ContextPassage extends SourceSpan {
  id: string;
  section: string;
  dateCue: boolean;
  attributionCue: boolean;
  identityCue: boolean;
  locationCue: boolean;
}

const dateCue = /\b(?:\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?|(?:19|20)\d{2}|January|February|March|April|May|June|July|August|September|October|November|December|dated?|session|assessment|evaluation|during|before|after)\b/i;
const attributionCue = /\b(?:author|examiner|evaluator|prepared by|signed|reported|stated|according to|mother|father|parent|teacher|witness|testified|said)\b/i;
const identityCue = /(?:^|\n)\s*(?:#{1,6}\s*|\*\*)?(?:author|examiner(?: signature)?|evaluator|prepared by|written by|report by|signed by|from)\s*(?:\*\*)?:\s*(?:\*\*)?\s*\S|\b(?:report|document|evaluation) (?:prepared|written|authored) by\s+\S/i;
// Reserve facility/encounter passages even when clinical text dominates lexical
// retrieval. These cues select source evidence; they never assign a location.
const locationCue = /(?:^|\n)\s*(?:#{1,6}\s*|\*\*)?(?:(?:facility|hospital|clinic|encounter location|place of service)\s*(?:\*\*)?:\s*\S|[\p{L}\p{N}][\p{L}\p{N} '&.,()/-]{1,100}\b(?:medical cent(?:er|re)|hospital|clinic|health cent(?:er|re))\b)/imu;
const terms = (text: string) => new Set([
  ...(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
  // Keep short document identifiers such as W-17 intact for participant lookup.
  ...(text.toLowerCase().match(/[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+/gu) ?? []),
]);

function participantIdentityHeader(quote: string): boolean {
  for (const line of quote.split("\n")) {
    const header = line.match(/^\s*(?:#{1,6}\s*)?(?:\*\*)?(client|patient|student(?: name)?|parents?|mother|father|subject|respondent|petitioner)\s*(?:\*\*)?\s*[:|]\s*(?:\*\*)?(.+)$/iu);
    if (!header) continue;
    if (header[1].toLowerCase() !== "subject") return true;
    // Email/memo subjects are topics, not participant identities. A bare
    // Subject label needs a person-shaped value or an explicit identity cue.
    const value = header[2].replace(/\*\*|[.]+$/gu, "").trim();
    if (/^(?:re|fw|fwd)\s*:|\b(?:invoice|regarding|meeting|report|request|update|assessment|evaluation)\b/iu.test(value)) continue;
    if (/^(?:\p{Lu}[\p{L}\p{M}'’.-]*)(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*){1,3}$/u.test(value)
      || /\b(?:name|DOB|date of birth|patient ID|student ID)\s*:/iu.test(value)) return true;
  }
  return false;
}

/** Source passages only: no inferred dates, speakers, or shared extractor answers. */
export class EvidenceDocumentContext {
  private readonly passages: ContextPassage[] = [];
  private readonly passageTerms = new Map<string, Set<string>>();
  private readonly lookups = new Map<string, readonly ContextPassage[]>();
  cacheHits = 0;

  constructor(pages: readonly { pageNumber: number; text: string }[]) {
    let section = "";
    for (const page of pages) {
      for (const match of page.text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g)) {
        const block = match[0];
        const heading = block.match(/^\s*#{1,6}\s+(.+)/m);
        if (heading) section = heading[1].trim();
        // Bound each passage, retaining exact source offsets and text.
        for (let offset = 0; offset < block.length; offset += 900) {
          const sourceQuote = block.slice(offset, offset + 1_100);
          if (!sourceQuote.trim()) continue;
          const sourceOffset = match.index + offset;
          const id = `context:${page.pageNumber}:${sourceOffset}`;
          this.passages.push({ id,
            pageNumber: page.pageNumber, sourceOffset, sourceQuote, section,
            dateCue: dateCue.test(sourceQuote), attributionCue: attributionCue.test(sourceQuote),
            identityCue: identityCue.test(sourceQuote), locationCue: locationCue.test(sourceQuote) });
          this.passageTerms.set(id, terms(sourceQuote + " " + section));
        }
      }
    }
  }

  /** Explicit identity passages remain evidence hints, including competing authors. */
  identities(pageNumber: number, limit = 3): readonly ContextPassage[] {
    return this.passages.filter(passage => passage.identityCue).sort((a, b) =>
      Math.abs(a.pageNumber - pageNumber) - Math.abs(b.pageNumber - pageNumber)
      || a.pageNumber - b.pageNumber || a.sourceOffset - b.sourceOffset).slice(0, limit);
  }

  /** Participant headers are lookup evidence, never a document-wide alias map. */
  participantIdentities(pageNumber: number, limit = 4): readonly ContextPassage[] {
    return this.passages.filter(passage => participantIdentityHeader(passage.sourceQuote)
      || /\b(?:also known as|known as|goes by|was born .{0,60} to (?:his|her|their) parents)\b/iu.test(passage.sourceQuote))
      .sort((a, b) => Math.abs(a.pageNumber - pageNumber) - Math.abs(b.pageNumber - pageNumber)
        || a.pageNumber - b.pageNumber || a.sourceOffset - b.sourceOffset).slice(0, limit);
  }

  /** Prefer preceding encounter headers; retain alternatives as unassigned evidence. */
  locations(pageNumber: number, limit = 3): readonly ContextPassage[] {
    return this.passages.filter(passage => passage.locationCue).sort((a, b) =>
      Number(a.pageNumber > pageNumber) - Number(b.pageNumber > pageNumber)
      || Math.abs(a.pageNumber - pageNumber) - Math.abs(b.pageNumber - pageNumber)
      || a.sourceOffset - b.sourceOffset).slice(0, limit);
  }

  lookup(pageNumber: number, query: string, purpose: "dates" | "attribution" | "review",
    limit = 4): readonly ContextPassage[] {
    const key = createHash("sha256").update(JSON.stringify([pageNumber, query, purpose, limit])).digest("hex");
    const cached = this.lookups.get(key);
    if (cached) { this.cacheHits++; return cached; }
    const words = terms(query);
    const ranked = this.passages.filter(passage => purpose === "dates" ? passage.dateCue
      : purpose === "attribution" ? passage.attributionCue : true).map(passage => {
      const overlap = [...this.passageTerms.get(passage.id)!].filter(word => words.has(word)).length;
      const cue = purpose === "dates" ? passage.dateCue : purpose === "attribution"
        ? passage.attributionCue : passage.dateCue || passage.attributionCue;
      return { passage, score: overlap * 3 + (cue ? 6 : 0) + (passage.pageNumber === pageNumber ? 2 : 0) };
    }).filter(entry => entry.score > 2).sort((a, b) => b.score - a.score
      || Math.abs(a.passage.pageNumber - pageNumber) - Math.abs(b.passage.pageNumber - pageNumber)
      || a.passage.sourceOffset - b.passage.sourceOffset);
    const result = ranked.slice(0, limit).map(entry => entry.passage);
    // Bounded per-document cache; rebuilding an evicted lookup is deterministic.
    if (this.lookups.size >= 512) this.lookups.delete(this.lookups.keys().next().value!);
    this.lookups.set(key, result);
    return result;
  }
}
