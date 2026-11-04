import { EvidenceSource, type EvidenceWindow, type SourceSpan } from "./evidenceSource.js";

export interface BoundaryReviewContext {
  reason: "quotation-crosses-boundary" | "sentence-crosses-boundary";
  target: SourceSpan;
  neighboring: SourceSpan;
}

/** Source continuity warrants review, never automatic acceptance or citation replacement. */
export function boundaryReviewContext(quotation: string, source: EvidenceSource,
  window: EvidenceWindow): BoundaryReviewContext[] {
  if (source.matchInWindow(window, quotation).length) return [];
  const pageIndex = source.pages.findIndex(page => page.pageNumber === window.pageNumber);
  const page = source.pages[pageIndex];
  if (!page) return [];
  const span = (pageNumber: number, sourceOffset: number, sourceQuote: string): SourceSpan =>
    ({ pageNumber, sourceOffset, sourceQuote });
  const target = span(window.pageNumber, window.startOffset, window.text);
  const beforePage = window.startOffset ? page : source.pages[pageIndex - 1];
  const beforeEnd = window.startOffset || beforePage?.text.length || 0;
  const beforeStart = Math.max(0, beforeEnd - 1_200);
  const afterStart = window.startOffset + window.text.length;
  const afterPage = afterStart < page.text.length ? page : source.pages[pageIndex + 1];
  const afterOffset = afterPage === page ? afterStart : 0;
  const pairs: { left: SourceSpan; right: SourceSpan; targetSide: "left" | "right" }[] = [];
  if (beforePage) pairs.push({
    left: span(beforePage.pageNumber, beforeStart, beforePage.text.slice(beforeStart, beforeEnd)),
    right: target, targetSide: "right",
  });
  if (afterPage) pairs.push({ left: target,
    right: span(afterPage.pageNumber, afterOffset, afterPage.text.slice(afterOffset, afterOffset + 1_200)),
    targetSide: "left" });
  const contexts: BoundaryReviewContext[] = [];
  for (const {left, right, targetSide} of pairs) {
    const joined = left.sourceQuote + " " + right.sourceQuote;
    const boundary = left.sourceQuote.length;
    const matches = source.matchInWindow({...window, startOffset: 0, text: joined}, quotation);
    const crossing = matches.find(match => match.sourceOffset < boundary
      && match.sourceOffset + match.sourceQuote.length > boundary + 1);
    const clip = (original: SourceSpan, start: number, end: number) =>
      span(original.pageNumber, original.sourceOffset + start, original.sourceQuote.slice(start, end));
    let a: SourceSpan, b: SourceSpan;
    let reason: BoundaryReviewContext["reason"];
    if (crossing) {
      a = clip(left, crossing.sourceOffset, boundary);
      b = clip(right, 0, crossing.sourceOffset + crossing.sourceQuote.length - boundary - 1);
      reason = "quotation-crosses-boundary";
    } else {
      // A quotation wholly on the adjacent page can still belong to an
      // unfinished sentence whose other fragment is in this target window.
      if (/[.!?:;]["'”’)\]]*\s*$/.test(left.sourceQuote)
        || /^\s*(?:#{1,6}\s|\||[-*]\s|\d+\.\s)/.test(right.sourceQuote)) continue;
      const breaks = [...left.sourceQuote.matchAll(/[.!?]["'”’)\]]*\s+|\n[ \t]*\n/g)];
      const last = breaks.at(-1);
      const start = last ? last.index + last[0].length : 0;
      const endMatch = /[.!?]["'”’)\]]*(?=\s|$)|\n[ \t]*\n/.exec(right.sourceQuote);
      const end = endMatch ? endMatch.index + endMatch[0].length : right.sourceQuote.length;
      a = clip(left, start, left.sourceQuote.length);
      b = clip(right, 0, Math.min(end, 1_200));
      const adjacent = targetSide === "left" ? b : a;
      if (!source.matchInWindow({...window, startOffset: 0, text: adjacent.sourceQuote}, quotation).length) continue;
      reason = "sentence-crosses-boundary";
    }
    if (!/[\p{L}\p{N}]/u.test(a.sourceQuote) || !/[\p{L}\p{N}]/u.test(b.sourceQuote)) continue;
    contexts.push({ reason, target: targetSide === "left" ? a : b,
      neighboring: targetSide === "left" ? b : a });
  }
  return contexts;
}

/** Routing hints only: an actual occurrence can itself quote a hypothetical or recurring statement. */
export function eventClassificationConcerns(item: { what: string; sourceQuote: string }): string[] {
  const text = item.what + "\n" + item.sourceQuote;
  const concerns: string[] = [];
  if (/\b(?:usually|typically|often|generally|habitually|routinely|whenever|each time|tends? to)\b/i.test(text)
    || /\bwhen\b[^\n.!?]{0,160}\b(?:will|would|can|says?|gets?|becomes?|feels?)\b/i.test(text)) {
    concerns.push("Possible habitual behavior rather than a particular occurrence");
  }
  if (/\b(?:should|would|could|might|recommend(?:s|ed|ation)?|proposed|plans? to)\b/i.test(text)
    || /\bif\b[^\n.!?]{0,160}\b(?:will|can|may)\b/i.test(text)) {
    concerns.push("Possible recommendation, hypothetical or future scenario rather than an occurrence");
  }
  return concerns;
}
