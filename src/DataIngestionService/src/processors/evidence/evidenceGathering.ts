import type { EvidenceWindow } from "./evidenceSource.js";
import { positiveIntegerSetting } from "./evidenceRetryPolicy.js";
import { EvidenceGatheringTimeoutError } from "./evidenceReconciliationDeadline.js";
import { EvidenceReviewPending } from "./evidenceAsync.js";
import { titledSectionStarts, parseGatheringStructure, type GatheringStructure } from "./evidenceGatheringSections.js";

const MAX_SPLIT_DEPTH = 2;
const MIN_SEGMENT_CHARS = 500;
const CONTEXT_CHARS = 700;

export class EvidenceGatheringOutputLimitError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, {cause});
    this.name = "EvidenceGatheringOutputLimitError";
  }
}

/** The split was saved; retry this unit to dispatch its smaller children. */
export class EvidenceGatheringPartitionScheduledError extends EvidenceGatheringOutputLimitError {
  constructor(cause: EvidenceGatheringOutputLimitError) {
    super(cause.message, cause);
    this.name = "EvidenceGatheringPartitionScheduledError";
  }
}

export const GATHERING_STAGES = ["primary-events", "primary-facts", "primary-claims", "independent"] as const;
export type GatheringStage = typeof GATHERING_STAGES[number];
export interface GatheringUnit {
  stage: GatheringStage;
  startOffset: number;
  characterCount: number;
  depth: number;
}
export interface GatheringLimits { maxChars: number; maxUnits: number; overlapChars: number }

/** These are workload limits, not evidence filters or candidate/output caps. */
export function gatheringLimits() {
  const setting = (name: string, fallback: number, minimum: number, maximum: number) => {
    const value = Number(process.env[name]?.trim() || fallback);
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new Error(`${name} must be between ${minimum} and ${maximum}`);
    return value;
  };
  const primaryChars = setting("EVIDENCE_GATHER_PRIMARY_MAX_CHARS", 5000, 500, 5000);
  const independentChars = setting("EVIDENCE_GATHER_INDEPENDENT_MAX_CHARS", 1500, 500, 5000);
  const overlapChars = setting("EVIDENCE_GATHER_OVERLAP_CHARS", 150, 0, Math.floor(Math.min(primaryChars, independentChars) / 3));
  return {
    primary: {maxChars: primaryChars, maxUnits: setting("EVIDENCE_GATHER_PRIMARY_MAX_UNITS", 48, 1, 100), overlapChars},
    independent: {maxChars: independentChars, maxUnits: setting("EVIDENCE_GATHER_INDEPENDENT_MAX_UNITS", 16, 1, 100), overlapChars},
  };
}

const safeBoundary = (text: string, offset: number) =>
  offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]) ? offset - 1 : offset;

/** Plan before inference. Each character remains a target; overlapping edges retain local context. */
export function planGatheringWindows(window: EvidenceWindow, pageText: string, limits: GatheringLimits,
  structure = parseGatheringStructure(pageText)): EvidenceWindow[] {
  const boundaries = structure.unitEnds.map(offset => offset - window.startOffset);
  const result: EvidenceWindow[] = [];
  const headings = structure.headings.filter(heading => heading.start >= window.startOffset && heading.start < window.startOffset + window.text.length)
    .map(heading => ({...heading, start:heading.start - window.startOffset, end:heading.end - window.startOffset}));
  const sections = [...titledSectionStarts(window.text, headings), window.text.length];
  let previousWasWholeSection = false;
  for (let section = 0; section < sections.length - 1; section++) {
    const firstSegment = result.length;
    const sectionEnd = sections[section + 1];
    let start = sections[section];
    while (start < sectionEnd) {
      let end = Math.min(start + limits.maxChars, sectionEnd);
      const densityEnd = boundaries.filter(offset => offset > start)[limits.maxUnits - 1];
      if (densityEnd !== undefined) end = Math.min(end, densityEnd);
      if (end < sectionEnd) {
        const lower = start + Math.floor((end - start) * 0.65);
        const blockEnd = structure.blockEnds.map(offset => offset - window.startOffset)
          .filter(offset => offset >= lower && offset <= end && offset > start).at(-1);
        const rowEnd = structure.tables.flatMap(table => table.rowEnds).map(offset => offset - window.startOffset)
          .filter(offset => offset >= lower && offset <= end && offset > start).at(-1);
        if (blockEnd !== undefined || rowEnd !== undefined) end = blockEnd ?? rowEnd!;
        else for (const pattern of [/[.!?][ \t]+/g, /\r?\n/g, /\s+/g]) {
          const preferred = [...window.text.slice(start, end).matchAll(pattern)]
            .map(match => start + match.index + match[0].length).filter(offset => offset >= lower && offset > start).at(-1);
          if (preferred !== undefined) { end = preferred; break; }
        }
      }
      end = safeBoundary(window.text, end);
      // Whitespace after a completed unit does not add model work. Keep it with
      // the preceding section instead of creating a whitespace-only request.
      while (end < sectionEnd && end - start < limits.maxChars && /\s/.test(window.text[end])) end++;
      const absoluteStart = window.startOffset + start, absoluteEnd = window.startOffset + end;
      result.push({...window, startOffset: absoluteStart, text: window.text.slice(start, end),
        before: start === 0 ? window.before : pageText.slice(Math.max(0, absoluteStart - CONTEXT_CHARS), absoluteStart),
        after: end === window.text.length ? window.after : pageText.slice(absoluteEnd, absoluteEnd + CONTEXT_CHARS)});
      if (end === sectionEnd) break;
      start = safeBoundary(window.text, end - Math.min(limits.overlapChars, Math.floor((end - start) / 4)));
    }
    const wholeSection = result.length === firstSegment + 1;
    if (wholeSection && previousWasWholeSection && firstSegment > 0) {
      const previous = result[firstSegment - 1], current = result[firstSegment];
      const begin = previous.startOffset - window.startOffset, end = current.startOffset - window.startOffset + current.text.length;
      if (end - begin <= limits.maxChars && boundaries.filter(offset => offset > begin && offset <= end).length <= limits.maxUnits) {
        previous.text = window.text.slice(begin, end);
        previous.after = current.after;
        result.pop();
      }
    }
    previousWasWholeSection = wholeSection;
  }
  return result;
}

/** A queued unit must be an exact planned segment or one of its bounded recovery children. */
export function resolveGatheringUnit(window: EvidenceWindow, pageText: string, limits: GatheringLimits, unit: GatheringUnit,
  structure?: GatheringStructure): EvidenceWindow {
  let segments = planGatheringWindows(window, pageText, limits, structure);
  if (!Number.isInteger(unit.depth) || unit.depth < 0 || unit.depth > MAX_SPLIT_DEPTH)
    throw new Error("Invalid gathering subdivision depth");
  for (let depth = 0; depth < unit.depth; depth++)
    segments = segments.flatMap(segment => splitGatheringWindow(segment, depth, pageText) ?? []);
  const segment = segments.find(candidate => candidate.startOffset === unit.startOffset && candidate.text.length === unit.characterCount);
  if (!segment) throw new Error("Gathering unit does not match the source plan");
  return segment;
}

/** Stop admission on failure, but drain model calls and storage writes already in progress. */
export class GatheringAttempt {
  private failed = false;
  private failure: unknown;
  assertActive = (): void => { if (this.failed) throw this.failure; };
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.assertActive();
    try { return await work(); }
    catch (error) {
      if (!(error instanceof EvidenceReviewPending) && !this.failed) { this.failed = true; this.failure = error; }
      throw error;
    }
  }
  async settle<T>(work: Promise<T>[]): Promise<T[]> {
    const results = await Promise.allSettled(work);
    this.assertActive();
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return results.map(result => (result as PromiseFulfilledResult<T>).value);
  }
}

export function gatheringTimeoutMs(): number {
  const timeout = positiveIntegerSetting("EVIDENCE_GATHER_TIMEOUT_MS", 180_000);
  if (timeout > 2_147_483_647) throw new Error("EVIDENCE_GATHER_TIMEOUT_MS exceeds the timer limit");
  return timeout;
}

export function isGatheringTimeout(error: unknown): boolean {
  return error instanceof EvidenceGatheringTimeoutError || error instanceof Error
    && (error.name === "TimeoutError" || error.name === "APIConnectionTimeoutError");
}

/** Preserve every source character and offset; nearby text remains citation context. */
export function splitGatheringWindow(window: EvidenceWindow, depth: number, pageText: string): [EvidenceWindow, EvidenceWindow] | null {
  if (depth >= MAX_SPLIT_DEPTH || window.text.length < MIN_SEGMENT_CHARS * 2) return null;
  const midpoint = Math.floor(window.text.length / 2);
  const lower = Math.max(MIN_SEGMENT_CHARS, Math.floor(window.text.length * 0.35));
  const upper = Math.min(window.text.length - MIN_SEGMENT_CHARS, Math.ceil(window.text.length * 0.65));
  let split = midpoint;
  // Prefer a paragraph, sentence, or row boundary before falling back to a word.
  for (const pattern of [/\n\s*\n/g, /[.!?]\s+/g, /\n/g, /\s+/g]) {
    const boundaries = [...window.text.matchAll(pattern)].map(match => match.index + match[0].length)
      .filter(offset => offset >= lower && offset <= upper);
    if (boundaries.length) {
      split = boundaries.sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint) || a - b)[0];
      break;
    }
  }
  // Never divide a UTF-16 surrogate pair at a fallback boundary.
  if (/[\uD800-\uDBFF]/.test(window.text[split - 1]) && /[\uDC00-\uDFFF]/.test(window.text[split])) split++;
  if (split < MIN_SEGMENT_CHARS || window.text.length - split < MIN_SEGMENT_CHARS) return null;
  const boundary = window.startOffset + split;
  return [
    {...window, text: window.text.slice(0, split), after: pageText.slice(boundary, boundary + CONTEXT_CHARS)},
    {...window, startOffset: boundary, text: window.text.slice(split),
      before: pageText.slice(Math.max(0, boundary - CONTEXT_CHARS), boundary)},
  ];
}
