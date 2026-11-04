import { EvidenceSource, type EvidenceWindow, type SourceSpan } from "./evidenceSource.js";

interface CitableEvidence {
  sourceQuote: string;
  supportingQuotes: { pageNumber: number; quote: string }[];
}
export interface CitationChoice extends SourceSpan {
  id: string;
  field: "sourceQuote" | "supportingQuotes";
  supportingIndex?: number;
  reason?: "quotation-mismatch";
}

export class InvalidCitationChoiceError extends Error {
  constructor(id: string) {
    super(`Invalid citation choice: ${id}`);
    this.name = "InvalidCitationChoiceError";
  }
}

/** Extend a known occurrence with source characters until its quote is unique. */
function distinctiveSpan(source: EvidenceSource, span: SourceSpan, window?: EvidenceWindow): SourceSpan | null {
  const page = source.pages.find(page => page.pageNumber === span.pageNumber);
  if (!page) return null;
  const occurrences = window ? source.matchInWindow(window, span.sourceQuote)
    : source.matchOnPage(span.pageNumber, span.sourceQuote);
  const index = occurrences.findIndex(match => match.sourceOffset === span.sourceOffset);
  const first = Math.max(window?.startOffset ?? 0,
    index > 0 ? occurrences[index - 1].sourceOffset + occurrences[index - 1].sourceQuote.length : 0);
  const last = Math.min(window ? window.startOffset + window.text.length : page.text.length,
    occurrences[index + 1]?.sourceOffset ?? page.text.length);
  for (const width of [48, 128, 384, 1024, 2048]) {
    const start = Math.max(first, span.sourceOffset - width);
    const end = Math.min(last, span.sourceOffset + span.sourceQuote.length + width);
    const quote = page.text.slice(start, end);
    const match = window ? source.locate(window, quote) : source.locateSupporting(span.pageNumber, quote);
    if (match) return match;
  }
  return null;
}

/** A cited Markdown heading can identify a repeated bullet's section without interpreting the claim. */
function sectionMatch(source: EvidenceSource, matches: SourceSpan[], evidence: CitableEvidence): SourceSpan | null {
  const selected = matches.filter(match => {
    const text = source.pages.find(page => page.pageNumber === match.pageNumber)!.text;
    const headings = [...text.slice(0, match.sourceOffset).matchAll(/^#{1,6}[^\S\n]+[^\n]+/gm)];
    const heading = headings.at(-1);
    if (!heading) return false;
    return evidence.supportingQuotes.some(quote => {
      if (quote.pageNumber !== match.pageNumber) return false;
      const located = source.locateSupporting(quote.pageNumber, quote.quote);
      return located?.sourceOffset === heading.index && located.sourceQuote.trim() === heading[0].trim();
    });
  });
  return selected.length === 1 ? selected[0] : null;
}

/** Retrieve close passages for semantic review, never as automatically accepted citations. */
function nearbySpans(source: EvidenceSource, quotation: string, pageNumber: number, window?: EvidenceWindow): SourceSpan[] {
  const words = quotation.trim().split(/\s+/u);
  const text = window?.text ?? source.pages.find(page => page.pageNumber === pageNumber)?.text ?? "";
  // Bound optional retrieval work; short or substantially rewritten quotes need source review.
  if (words.length < 8 || words.length > 128 || text.length > 50_000) return [];
  const tokens = [...text.matchAll(/\S+/gu)];
  const budget = Math.min(2, Math.floor(words.length / 8));
  let costs = words.map((_, index) => index + 1);
  costs.unshift(0);
  let starts = costs.map(() => 0);
  const candidates: { span: SourceSpan; distance: number }[] = [];
  // Substring edit distance over words. Offsets always refer to verbatim source characters.
  for (let index = 0; index < tokens.length; index++) {
    const nextCosts = [0];
    const nextStarts = [index + 1];
    for (let word = 1; word <= words.length; word++) {
      let cost = costs[word - 1] + (tokens[index][0] === words[word - 1] ? 0 : 1);
      let start = starts[word - 1];
      if (costs[word] + 1 < cost) { cost = costs[word] + 1; start = starts[word]; }
      if (nextCosts[word - 1] + 1 < cost) { cost = nextCosts[word - 1] + 1; start = nextStarts[word - 1]; }
      nextCosts.push(cost);
      nextStarts.push(start);
    }
    costs = nextCosts;
    starts = nextStarts;
    if (costs[words.length] > budget) continue;
    const start = tokens[starts[words.length]].index;
    const end = tokens[index].index + tokens[index][0].length;
    candidates.push({ distance: costs[words.length], span: { pageNumber,
      sourceOffset: (window?.startOffset ?? 0) + start, sourceQuote: text.slice(start, end) } });
  }
  const selected: SourceSpan[] = [];
  const choices: SourceSpan[] = [];
  for (const {span} of candidates.sort((a, b) => a.distance - b.distance || a.span.sourceOffset - b.span.sourceOffset)) {
    if (selected.some(other => span.sourceOffset < other.sourceOffset + other.sourceQuote.length
      && other.sourceOffset < span.sourceOffset + span.sourceQuote.length)) continue;
    const unique = (window ? source.locate(window, span.sourceQuote) : source.locateSupporting(pageNumber, span.sourceQuote))
      ?? distinctiveSpan(source, span, window);
    if (!unique) continue;
    selected.push(span);
    choices.push(unique);
    if (choices.length === 4) break;
  }
  return choices;
}

/** A stitched multi-line quotation may have exact component lines but no contiguous match. */
function fragmentSpans(source: EvidenceSource, quotation: string, window: EvidenceWindow): SourceSpan[] {
  if (window.text.length > 50_000) return [];
  const lines = quotation.split(/\r?\n/u).map(line => line.trim())
    .filter(line => line.length >= 28 && line.length <= 512);
  if (lines.length < 2 || lines.length > 16) return [];
  const choices: SourceSpan[] = [];
  for (const line of lines.reverse()) {
    for (const match of source.matchInWindow(window, line).slice(0, 8)) {
      const span = source.locate(window, line) ?? distinctiveSpan(source, match, window);
      if (!span || choices.some(choice => choice.sourceOffset === span.sourceOffset)) continue;
      choices.push(span);
      if (choices.length === 4) return choices;
    }
  }
  return choices;
}

/** Resolve explicitly cited sections; offer ambiguous or nearby passages for a reviewer to select. */
export function prepareEvidenceCitations<T extends CitableEvidence>(original: T, source: EvidenceSource,
  window: EvidenceWindow): { item: T; choices: CitationChoice[] } {
  const item = { ...original, supportingQuotes: original.supportingQuotes.map(quote => ({ ...quote })) };
  const choices: CitationChoice[] = [];
  const primary = source.matchInWindow(window, item.sourceQuote);
  if (primary.length > 1) {
    const selected = sectionMatch(source, primary, item);
    const distinctive = selected && distinctiveSpan(source, selected, window);
    if (distinctive) item.sourceQuote = distinctive.sourceQuote;
    else for (const [index, span] of primary.slice(0, 16).entries()) {
      const choice = distinctiveSpan(source, span, window);
      if (choice) choices.push({ ...choice, id: `cite:primary:${index}`, field: "sourceQuote" });
    }
  } else if (primary.length === 0) {
    const nearby = nearbySpans(source, item.sourceQuote, window.pageNumber, window);
    (nearby.length ? nearby : fragmentSpans(source, item.sourceQuote, window)).forEach((span, index) =>
      choices.push({ ...span, id: `cite:primary:${index}`, field: "sourceQuote", reason: "quotation-mismatch" }));
  }
  item.supportingQuotes.forEach((quote, supportingIndex) => {
    const matches = source.matchOnPage(quote.pageNumber, quote.quote);
    if (matches.length === 0) {
      nearbySpans(source, quote.quote, quote.pageNumber).forEach((span, index) =>
        choices.push({ ...span, id: `cite:support:${supportingIndex}:${index}`,
          field: "supportingQuotes", supportingIndex, reason: "quotation-mismatch" }));
    }
    if (matches.length <= 1) return;
    const selected = sectionMatch(source, matches, item);
    const distinctive = selected && distinctiveSpan(source, selected);
    if (distinctive) quote.quote = distinctive.sourceQuote;
    else for (const [index, span] of matches.slice(0, 16).entries()) {
      const choice = distinctiveSpan(source, span);
      if (choice) choices.push({ ...choice, id: `cite:support:${supportingIndex}:${index}`,
        field: "supportingQuotes", supportingIndex });
    }
  });
  return { item: item as T, choices };
}

/** IDs reference application-validated source text; they cannot select another field or page. */
export function expandCitationChoices<T extends CitableEvidence>(original: T, choices: readonly CitationChoice[]): T {
  const expand = (quote: string, field: CitationChoice["field"], pageNumber?: number): string => {
    if (!quote.startsWith("cite:")) return quote;
    const choice = choices.find(choice => choice.id === quote && choice.field === field
      && (pageNumber === undefined || pageNumber === choice.pageNumber));
    if (!choice) throw new InvalidCitationChoiceError(quote);
    return choice.sourceQuote;
  };
  return { ...original, sourceQuote: expand(original.sourceQuote, "sourceQuote"),
    supportingQuotes: original.supportingQuotes.map(quote => ({ ...quote,
      quote: expand(quote.quote, "supportingQuotes", quote.pageNumber) })) };
}
