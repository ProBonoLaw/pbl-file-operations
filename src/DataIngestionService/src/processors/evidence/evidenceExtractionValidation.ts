import { formatEvidenceDate } from "./evidenceContent.js";
import { EvidenceDocumentFactory } from "./evidenceDocumentFactory.js";
import { eventDateMeaning, validateEventDateDecision } from "./evidenceEventDates.js";
import { resolveEventStructure } from "./evidenceEventStructure.js";
import type {
  Candidate, ClaimExtractionResponse, EventExtractionResponse, FactExtractionResponse, LocatedEvidence,
  LocatedExtraction,
} from "./evidenceExtractionSchemas.js";
import { EvidenceSource, type EvidenceWindow, type SourceSpan } from "./evidenceSource.js";

// Merge only identical structured evidence at the same source anchor. Different
// speakers, polarity, dates, or qualifiers must survive even when wording overlaps.
function evidenceKey<T>(located: LocatedEvidence<T>): string {
  const { sourceQuote: _quote, supportingQuotes: _support, ...item } = located.item as EventExtractionResponse | FactExtractionResponse | ClaimExtractionResponse;
  return JSON.stringify([located.pageNumber, located.sourceOffset, item,
    eventDateMeaning(located.eventDateResolution)]);
}

export function uniqueEvidence<T>(items: LocatedEvidence<T>[]): LocatedEvidence<T>[] {
  const unique = new Map<string, LocatedEvidence<T>>();
  for (const located of items) {
    const key = evidenceKey(located);
    const existing = unique.get(key);
    if (existing) {
      existing.extractedBy = [...new Set([...existing.extractedBy, ...located.extractedBy])];
      existing.sourceSpans = uniqueSpans([...existing.sourceSpans, ...located.sourceSpans]);
    } else unique.set(key, located);
  }
  return [...unique.values()];
}

function uniqueSpans(spans: SourceSpan[]): SourceSpan[] {
  return [...new Map(spans.map((span) => [JSON.stringify(span), span])).values()];
}


/** Checks literal citations and persisted evidence before review or checkpoint reuse. */
export class EvidenceExtractionValidation {
  constructor(private readonly eventStructureMode: "off" | "annotate",
    private readonly documents: EvidenceDocumentFactory) {}

  validateCheckpointEvidence(result: LocatedExtraction, source: EvidenceSource, window: EvidenceWindow): void {
    for (const located of [...result.events, ...result.facts, ...result.claims]) {
      const anchor = source.locate(window, located.item.sourceQuote);
      const primary = located.sourceSpans[0];
      if (!anchor || anchor.pageNumber !== located.pageNumber || anchor.sourceOffset !== located.sourceOffset
        || anchor.sourceQuote !== located.sourceQuote || primary.pageNumber !== anchor.pageNumber
        || primary.sourceOffset !== anchor.sourceOffset || primary.sourceQuote !== anchor.sourceQuote) {
        throw new Error("Evidence checkpoint has an invalid primary citation");
      }
      const citations = this.citationResult(located.item, source, window);
      if (citations.errors.length || citations.spans.some(expected => !located.sourceSpans.some(span =>
        span.pageNumber === expected.pageNumber && span.sourceOffset === expected.sourceOffset
          && span.sourceQuote === expected.sourceQuote))) {
        throw new Error("Evidence checkpoint is missing a required citation");
      }
      if (uniqueSpans(located.sourceSpans).length !== located.sourceSpans.length) {
        throw new Error("Evidence checkpoint has repeated citations");
      }
      for (const span of located.sourceSpans) {
        const match = (span.pageNumber === window.pageNumber ? source.locate(window, span.sourceQuote) : null)
          ?? source.locateSupporting(span.pageNumber, span.sourceQuote);
        if (!match || match.sourceOffset !== span.sourceOffset || match.sourceQuote !== span.sourceQuote) {
          throw new Error("Evidence checkpoint has an invalid supporting citation");
        }
      }
      if (located.eventDateResolution) {
        const resolution = validateEventDateDecision(located.eventDateResolution);
        for (const quote of resolution.supportingQuotes) {
          const span = source.locateSupporting(quote.pageNumber, quote.quote);
          if (!span || !located.sourceSpans.some(citation => citation.pageNumber === span.pageNumber
            && citation.sourceOffset === span.sourceOffset && citation.sourceQuote === span.sourceQuote)) {
            throw new Error("Event date resolution has an invalid supporting citation");
          }
        }
      }
    }
    // Catch date/content errors before saving a checkpoint for a completed window.
    result.events.forEach(item => this.documents.createEventDocument(item, source.document, source.contentHash));
    result.facts.forEach(item => this.documents.createFactDocument(item, source.document, source.contentHash));
    result.claims.forEach(item => this.documents.createClaimDocument(item, source.document, source.contentHash));
  }

  private citationMismatch(label: string, pageNumber: number, matches: SourceSpan[], source: EvidenceSource): string {
    if (matches.length === 0) return `${label} was not found on source page ${pageNumber}; check the exact source text and page`;
    const offsets = matches.slice(0, 16).map(match => match.sourceOffset);
    const context = matches.slice(0, 4).map(match => ({
      sourceOffset: match.sourceOffset, ...source.quoteContext(match),
    }));
    return `${label} matched ${matches.length} passages on source page ${pageNumber} at zero-based offsets ${JSON.stringify(offsets)}`
      + `${matches.length > offsets.length ? " (more omitted)" : ""}; surrounding text: ${JSON.stringify(context)}. `
      + "Copy a longer contiguous quotation with distinguishing context from the target passage.";
  }

  citationResult(item: Candidate["item"], source: EvidenceSource, window: EvidenceWindow): { spans: SourceSpan[]; errors: string[] } {
    const spans: SourceSpan[] = [];
    const errors: string[] = [];
    const primary = source.locate(window, item.sourceQuote);
    if (primary) spans.push(primary);
    else errors.push(this.citationMismatch("sourceQuote in target.text", window.pageNumber,
      source.matchInWindow(window, item.sourceQuote), source));
    for (const quote of item.supportingQuotes) {
      const span = (quote.pageNumber === window.pageNumber ? source.locate(window, quote.quote) : null)
        ?? source.locateSupporting(quote.pageNumber, quote.quote);
      if (span) spans.push(span);
      else errors.push(this.citationMismatch("supporting quote", quote.pageNumber,
        source.matchOnPage(quote.pageNumber, quote.quote), source));
    }
    if ("eventType" in item) {
      if (this.eventStructureMode === "annotate" && !item.eventStructure) errors.push("eventStructure is required in annotate mode; return a complete event with trigger and roles");
      else if (item.eventStructure && !errors.length) {
        try { resolveEventStructure(item, spans); }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      }
    }
    return { spans: uniqueSpans(spans), errors };
  }

  dateValidationErrors(item: Candidate["item"]): string[] {
    const fields = item as unknown as Record<string, unknown>;
    try {
      for (const prefix of "asOfYear" in item ? ["asOf"] : ["whenStarted", "whenEnded"]) {
        formatEvidenceDate({year:fields[`${prefix}Year`],month:fields[`${prefix}Month`],day:fields[`${prefix}Day`],
          season:fields[`${prefix}Season`],quarter:fields[`${prefix}Quarter`]});
      }
      return [];
    } catch (error) { return [error instanceof Error ? error.message : String(error)]; }
  }

}
