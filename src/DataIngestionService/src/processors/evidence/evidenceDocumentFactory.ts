import { Document } from "@langchain/core/documents";
import { EVIDENCE_CONTENT_VERSION, formatEvidenceContent } from "./evidenceContent.js";
import { validateEventDateDecision } from "./evidenceEventDates.js";
import { orderedEventCitations, resolveEventStructure } from "./evidenceEventStructure.js";
import { buildDate, cleanDatePart, emptyDate, knownOrUnknown } from "./evidenceExtractionDates.js";
import type { EvidenceExtractionMode } from "./evidenceExtractionMode.js";
import type {
  ClaimExtractionResponse, EventExtractionResponse, FactExtractionResponse, LocatedEvidence,
} from "./evidenceExtractionSchemas.js";
import { EVIDENCE_TAXONOMY_VERSION, facetTags } from "./evidenceTaxonomy.js";

/** Converts verified candidates into indexed documents without model or storage access. */
export class EvidenceDocumentFactory {
  constructor(private readonly accountId: string, private readonly sourceId: string,
    private readonly extractionMode: EvidenceExtractionMode,
    private readonly track: (name: string, properties: Record<string, string>) => void) {}

  createEventDocument(located: LocatedEvidence<EventExtractionResponse>, source: Document, contentHash: string): Document {
    const { item: event, sourceOffset, sourceQuote } = located;
    const structure = event.eventStructure ? resolveEventStructure(event,
      orderedEventCitations(event, located.sourceSpans)) : undefined;
    if (structure?.triggerIssue) this.track("eventTriggerUnresolved", {reason: structure.triggerIssue,
      page: String(located.pageNumber), sourceOffset: String(sourceOffset)});
    if (located.eventDateResolution) {
      const resolution = validateEventDateDecision(located.eventDateResolution);
      const assignsEndpoints = resolution.status === "dated" && resolution.relation !== "bounded";
      for (const [prefix, parts] of [["whenStarted", resolution.start], ["whenEnded", resolution.end]] as const) {
        for (const part of ["year", "month", "day", "season", "quarter"] as const) {
          const field = prefix + part[0].toUpperCase() + part.slice(1);
          const actual = cleanDatePart(event[field as keyof EventExtractionResponse] as string | null);
          if (actual !== (assignsEndpoints ? parts[part] || null : null)) {
            throw new Error("Event date fields do not match the validated date resolution");
          }
        }
      }
    }
    const whenStarted = buildDate({
      year: event.whenStartedYear,
      month: event.whenStartedMonth,
      day: event.whenStartedDay,
      season: event.whenStartedSeason,
      quarter: event.whenStartedQuarter,
    }) ?? emptyDate();

    const whenEnded = buildDate({
      year: event.whenEndedYear,
      month: event.whenEndedMonth,
      day: event.whenEndedDay,
      season: event.whenEndedSeason,
      quarter: event.whenEndedQuarter,
    });
    const where = knownOrUnknown(event.where);
    const why = knownOrUnknown(event.why);
    const who = event.who.map((name) => name.trim()).filter(Boolean);
    const whenStartedStr = JSON.stringify(whenStarted);
    const facets = facetTags(event.facets);

    return this.evidenceDocument({
      headers: [where, why, whenStartedStr],
      where,
      whenStarted,
      whenEnded,
      ...(located.eventDateResolution ? { eventDateResolution: located.eventDateResolution } : {}),
      why,
      what: event.what,
      eventType: event.eventType,
      who,
      sourceQuote,
      sourceOffset,
      tags: this.tags(source, ["fact", "event", "eventType:" + event.eventType, ...facets]),
      title: source.metadata?.title,
      source: source.metadata?.source,
      sourceId: source.metadata?.sourceId,
      ...this.citationMetadata(located, contentHash),
      ...(structure ? {eventStructure: structure} : {}),
    });
  }

  createFactDocument(located: LocatedEvidence<FactExtractionResponse>, source: Document, contentHash: string): Document {
    const { item: fact, sourceOffset, sourceQuote } = located;
    const asOf = buildDate({
      year: fact.asOfYear,
      month: fact.asOfMonth,
      day: fact.asOfDay,
      season: null,
      quarter: null,
    }) ?? emptyDate();
    const subject = fact.subject.map((name) => name.trim()).filter(Boolean);
    const reportedBy = fact.reportedBy.map((name) => name.trim()).filter(Boolean);
    const who = [...new Set([...subject, ...reportedBy])];
    const facets = facetTags(fact.facets);

    return this.evidenceDocument({
      headers: [fact.factType, knownOrUnknown(fact.where), JSON.stringify(asOf)],
      where: knownOrUnknown(fact.where),
      whenStarted: emptyDate(),
      whenEnded: null,
      asOf,
      why: "Unknown",
      what: fact.what,
      who,
      subject,
      reportedBy,
      factType: fact.factType,
      sourceQuote,
      sourceOffset,
      tags: this.tags(source, ["fact", "factType:" + fact.factType, ...facets]),
      title: source.metadata?.title,
      source: source.metadata?.source,
      sourceId: source.metadata?.sourceId,
      ...this.citationMetadata(located, contentHash),
    });
  }

  createClaimDocument(located: LocatedEvidence<ClaimExtractionResponse>, source: Document, contentHash: string): Document {
    const { item: claim, sourceOffset, sourceQuote } = located;
    const whenStarted = buildDate({
      year: claim.whenStartedYear,
      month: claim.whenStartedMonth,
      day: claim.whenStartedDay,
      season: null,
      quarter: null,
    }) ?? emptyDate();
    const whenEnded = buildDate({
      year: claim.whenEndedYear,
      month: claim.whenEndedMonth,
      day: claim.whenEndedDay,
      season: null,
      quarter: null,
    });
    const claimant = knownOrUnknown(claim.claimant);
    const who = claim.who.map((name) => name.trim()).filter(Boolean);

    return this.evidenceDocument({
      headers: [claimant, claim.claimType, claim.polarity],
      where: knownOrUnknown(claim.where),
      whenStarted,
      whenEnded,
      why: "Unknown",
      what: claim.statement,
      who,
      claimant,
      claimType: claim.claimType,
      claimPolarity: claim.polarity,
      sourceQuote,
      sourceOffset,
      tags: this.tags(source, [
        "claim",
        "claimType:" + claim.claimType,
        "claimPolarity:" + claim.polarity,
        ...facetTags(claim.facets),
      ]),
      title: source.metadata?.title,
      source: source.metadata?.source,
      sourceId: source.metadata?.sourceId,
      ...this.citationMetadata(located, contentHash),
    });
  }

  private evidenceDocument(metadata: Record<string, unknown>): Document {
    return new Document({
      pageContent: formatEvidenceContent(metadata),
      metadata: { ...metadata, accountId: this.accountId, sourceId: metadata.sourceId ?? this.sourceId,
        evidenceContentVersion: EVIDENCE_CONTENT_VERSION,
        evidenceTaxonomyVersion: EVIDENCE_TAXONOMY_VERSION },
    });
  }

  private citationMetadata<T>(located: LocatedEvidence<T>, contentHash: string) {
    const spans = located.sourceSpans ?? [{ pageNumber: located.pageNumber, sourceOffset: located.sourceOffset, sourceQuote: located.sourceQuote }];
    return {
      pages: [...new Set(spans.map((span) => span.pageNumber))],
      sourceSpans: spans,
      sourceContentHash: contentHash,
      extractedBy: located.extractedBy ?? [],
      evidenceSchemaVersion: "3",
      evidenceExtractionMode: this.extractionMode ?? "thorough",
    };
  }

  private tags(source: Document, extractedTags: string[]): string[] {
    const inheritedTags: string[] = Array.isArray(source.metadata?.tags)
      ? source.metadata.tags.filter((tag: unknown): tag is string => typeof tag === "string")
      : [];
    return [...new Set([...inheritedTags, ...extractedTags])];
  }

}
