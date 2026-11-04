import { z } from "zod";
import type { EvidenceCheckpointIdentity } from "./evidenceCheckpoint.js";
import { compactEventDateSchema, compactReconciliationSchema } from "./evidenceCompactResponses.js";
import { EventDateDecisionSchema, EventDateResponseSchema, type EventDateDecision } from "./evidenceEventDates.js";
import { eventStructureField } from "./evidenceEventStructure.js";
import type { GatheringStage } from "./evidenceGathering.js";
import { correctionField } from "./evidenceReconciliation.js";
import type { EvidenceWindow, SourceSpan } from "./evidenceSource.js";
import { eventTypeField, facetsField } from "./evidenceTaxonomy.js";

const datePart = (description: string) => z.string().nullable().describe(description);
// Use a fresh field schema in each response object so JSON Schema conversion
// does not emit a reference to a nested property in another object.
const sourceQuoteField = () => z.string().min(1).describe(
  "A distinctive, exact, contiguous quotation from target.text on the target page. Never use precedingContext, followingContext, or a page read as the primary anchor. Use supportingQuotes for additional passages needed to support the full item.",
);
const supportingQuotesField = () => z.array(z.object({
  pageNumber: z.number().int().nonnegative().describe("Source page number supplied by the application, not a page-number comment in the source."),
  quote: z.string().min(1).describe("Distinctive exact quotation supporting attribution, dates, or other details not established by the primary sourceQuote."),
})).describe("Additional supporting passages from this document, including other pages. Use an empty array when sourceQuote alone supports the entire item.");

// Date fields remain flat so the structured response does not create deeply nested types.
export const EventResponseSchema = z.object({
  whenStartedYear: datePart("Whole-number year the event started as a string, or null if unknown."),
  whenStartedMonth: datePart("Numeric month (1-12) the event started as a string, or null if unknown."),
  whenStartedDay: datePart("Numeric day (1-31) the event started as a string, or null if unknown."),
  whenStartedSeason: datePart("Season the event started (`Spring`, `Summer`, `Fall`, `Winter`), or null if unknown."),
  whenStartedQuarter: datePart("Year-quarter (Q1-Q4) the event started, or null if unknown."),
  whenEndedYear: datePart("Whole-number year the event ended as a string, or null if unknown or ongoing."),
  whenEndedMonth: datePart("Numeric month (1-12) the event ended as a string, or null if unknown."),
  whenEndedDay: datePart("Numeric day (1-31) the event ended as a string, or null if unknown."),
  whenEndedSeason: datePart("Season the event ended (`Spring`, `Summer`, `Fall`, `Winter`), or null if unknown."),
  whenEndedQuarter: datePart("Year-quarter (Q1-Q4) the event ended, or null if unknown."),
  where: z.string().describe("Actual event location, supported by the occurrence or its linked encounter context; otherwise 'Unknown'. Document provenance alone is insufficient."),
  what: z.string().min(1).describe("A concise, self-contained description of one atomic occurrence or action. A static result, score, attribute, or condition belongs in facts."),
  who: z.array(z.string()).describe("People or entities involved in this event; use an empty array when none are named."),
  why: z.string().describe("Cause only if explicitly stated or directly supported; otherwise 'Unknown'."),
  eventType: eventTypeField(),
  facets: facetsField(),
  sourceQuote: sourceQuoteField(),
  supportingQuotes: supportingQuotesField(),
  eventStructure: eventStructureField().optional(),
});

export const FactResponseSchema = z.object({
  what: z.string().min(1).describe("One self-contained, source-supported static fact, such as an assessment result, measured value, identity, relationship, or condition. For an assessment row, keep its scale, range, T-score, and percentile together as one result. Do not phrase a table result as an event that was recorded."),
  subject: z.array(z.string()).describe("People or entities the fact is about. Do not put a reporter here unless the fact is about the reporter."),
  reportedBy: z.array(z.string()).describe("People or entities that supplied the underlying report or measurement, if stated. Keep separate from the subject; use an empty array if unknown."),
  where: z.string().describe("Place where the fact applies or was observed, supported by the fact or its linked encounter context; otherwise 'Unknown'. Document provenance alone is insufficient."),
  asOfYear: datePart("Year when this fact applies or was measured, as a string, or null if unstated. Do not use the document date by default."),
  asOfMonth: datePart("Numeric month (1-12) when this fact applies or was measured, as a string, or null."),
  asOfDay: datePart("Numeric day (1-31) when this fact applies or was measured, as a string, or null."),
  factType: z.enum([
    "assessmentResult", "measurement", "recordedValue", "attribute",
    "relationship", "condition", "undatedOccurrence", "other",
  ]).describe("Type of fact. An occurrence without a source-supported calendar date is undatedOccurrence; assessment scores and classifications are assessmentResult."),
  facets: facetsField(),
  sourceQuote: sourceQuoteField(),
  supportingQuotes: supportingQuotesField(),
});

export const ClaimResponseSchema = z.object({
  statement: z.string().min(1).describe("Concise, self-contained statement of exactly what is claimed."),
  claimant: z.string().describe("Person or entity making or adopting the claim, or 'Unknown'."),
  claimType: z.enum([
    "factualAssertion", "allegation", "denial", "opinion", "belief",
    "estimate", "intent", "causation", "legalPosition", "other",
  ]),
  polarity: z.enum(["asserts", "denies", "uncertain"]),
  facets: facetsField(),
  who: z.array(z.string()).describe("People or entities materially involved in the claim."),
  whenStartedYear: datePart("Whole-number year of the claimed occurrence as a string, not the date the claim was made, or null."),
  whenStartedMonth: datePart("Numeric month (1-12) of the claimed occurrence as a string, or null."),
  whenStartedDay: datePart("Numeric day (1-31) of the claimed occurrence as a string, or null."),
  whenEndedYear: datePart("Whole-number year the claimed occurrence ended as a string, or null."),
  whenEndedMonth: datePart("Numeric month (1-12) the claimed occurrence ended as a string, or null."),
  whenEndedDay: datePart("Numeric day (1-31) the claimed occurrence ended as a string, or null."),
  where: z.string().describe("Location relevant to the claimed occurrence, or 'Unknown'."),
  sourceQuote: sourceQuoteField(),
  supportingQuotes: supportingQuotesField(),
});

export const EvidenceExtractionResponseSchema = z.object({
  events: z.array(EventResponseSchema).describe("Every supported atomic occurrence or action anchored in the target text."),
  facts: z.array(FactResponseSchema).describe("Every supported static fact, including table scores, classifications, measurements, and conditions."),
  claims: z.array(ClaimResponseSchema).describe("Every attributed assertion, allegation, denial, opinion, or position anchored in the target text. Directly recorded identities, attributes and measurements belong in facts unless the source presents them as reported assertions."),
});
export const FastExtractionEnvelopeSchema = z.object({ events:z.array(z.unknown()), facts:z.array(z.unknown()), claims:z.array(z.unknown()) });
/** Shared with offline benchmark adapters so candidate validation cannot drift. */
export const evidenceCandidateSchemas = { event: EventResponseSchema, fact: FactResponseSchema, claim: ClaimResponseSchema };
export const EventBatchSchema = z.object({ events: z.array(EventResponseSchema) });
export const FactBatchSchema = z.object({ facts: z.array(FactResponseSchema) });
export const ClaimBatchSchema = z.object({ claims: z.array(ClaimResponseSchema) });
export const gatheringDefinitions: Record<GatheringStage, {schema: z.AnyZodObject; instructions: string}> = {
  "primary-events": {schema: EventBatchSchema, instructions: "EVENT WORKER: Find every atomic occurrence, action, interaction, or state change in the target text. Include undated occurrences provisionally so their dates can be checked later; they become facts or attributed claims if no date can be established. Split compound descriptions. A reported allegation supports an event that it was reported, not an event that the allegation is true. Table scores, measurements, classifications, attributes, and conditions are facts, not events. Do not make a separate event for each result being recorded."},
  "primary-facts": {schema: FactBatchSchema, instructions: "FACT WORKER: Find every distinct static fact in the target text, including each assessment row, measurement, identity, relationship, and condition. For each assessment row, make one fact containing its scale, range, T-score, and percentile together; do not split those values into separate facts. Keep the subject separate from the reporter, preserve the instrument in what, and cite row headings when needed. A completed assessment is an event, while its resulting scores are facts. Do not turn reported symptoms into established facts; those are attributed claims."},
  "primary-claims": {schema: ClaimBatchSchema, instructions: "CLAIM WORKER: Find every distinct attributed assertion, allegation, denial, opinion, belief, estimate, intent, causal explanation, and legal position in the target text. Include quotes, tables, and the author's own narrative when they express claimed content. Preserve uncertainty, negation, and nested attribution. Split compound statements. A reported symptom can be a claim; directly recorded identities, attributes, measurements and assessment scores are static facts. Do not duplicate direct records as factualAssertion claims merely because a document states them."},
  "independent": {schema: EvidenceExtractionResponseSchema, instructions: "INDEPENDENT EXTRACTOR: Independently inventory every sentence, table row, list item, and quoted passage in the target. Extract every supported atomic event, fact, and attributed claim, including minor details, scores, classifications, denials, obligations, and undated items. Undated events are provisional for date lookup and become facts or attributed claims if no date is established. Keep one assessment row's range, T-score, and percentile together in one fact. You have no other extractor's answers. Inspect referenced pages when needed. Do not summarize separate occurrences as one or treat a static result as an event."},
};
export type GatheringPassResult = z.infer<typeof EvidenceExtractionResponseSchema> | z.infer<typeof EventBatchSchema>
  | z.infer<typeof FactBatchSchema> | z.infer<typeof ClaimBatchSchema>;
export const ReconciliationResponseSchema = z.object({
  decisions: z.array(z.object({
    candidateId: z.string(),
    verdict: z.enum(["supported", "unsupported", "unresolved"]),
    keepOriginal: z.boolean().describe("True only when the original candidate is fully supported without any correction. Its original fields and citations will be retained by the application."),
    reason: z.string().describe("Empty for an unchanged supported candidate; otherwise explain the specific correction, rejection, or uncertainty."),
    corrections: z.array(correctionField()).describe("Small field replacements for one supported candidate of the same kind. Empty for keepOriginal, replacements, or unsupported/unresolved decisions."),
    events: z.array(EventResponseSchema).describe("Corrected or split events only. Empty when keepOriginal is true or verdict is not supported."),
    facts: z.array(FactResponseSchema).describe("Corrected or reclassified facts only. Empty when keepOriginal is true or verdict is not supported."),
    claims: z.array(ClaimResponseSchema).describe("Corrected or reclassified claims only. Empty when keepOriginal is true or verdict is not supported."),
  })),
});
const sourceSpanSchema = z.object({
  pageNumber: z.number().int().nonnegative(),
  sourceOffset: z.number().int().nonnegative(),
  sourceQuote: z.string().min(1),
});
const locatedSchema = <T extends z.ZodTypeAny>(item: T) => z.object({
  item, pageNumber: z.number().int().nonnegative(), sourceOffset: z.number().int().nonnegative(),
  sourceQuote: z.string().min(1), sourceSpans: z.array(sourceSpanSchema).min(1),
  extractedBy: z.array(z.string().min(1)).min(1),
  eventDateResolution: EventDateDecisionSchema.optional(),
});
export const WindowCheckpointSchema = z.object({
  version: z.literal(1),
  pageNumber: z.number().int().nonnegative(),
  startOffset: z.number().int().nonnegative(),
  textHash: z.string(),
  evidence: z.object({
    events: z.array(locatedSchema(EventResponseSchema)),
    facts: z.array(locatedSchema(FactResponseSchema)),
    claims: z.array(locatedSchema(ClaimResponseSchema)),
  }),
});

const candidateBase = {
  id: z.string().min(1),
  extractedBy: z.array(z.string().min(1)).min(1),
};
export const StageCheckpointSchema = z.object({
  version: z.literal(1), stage: z.string(), pageNumber: z.number().int().nonnegative(),
  startOffset: z.number().int().nonnegative(), textHash: z.string(), inputHash: z.string(),
  valueHash: z.string(), value: z.unknown(),
});
export interface StageCheckpointContext { identity: EvidenceCheckpointIdentity; windowIndex: number }
export const CandidateSnapshotSchema = z.object({
  version: z.literal(1),
  sourceContentHash: z.string(),
  pageNumber: z.number().int().nonnegative(),
  startOffset: z.number().int().nonnegative(),
  textHash: z.string(),
  candidates: z.array(z.discriminatedUnion("kind", [
    z.object({ ...candidateBase, kind: z.literal("event"), item: EventResponseSchema }),
    z.object({ ...candidateBase, kind: z.literal("fact"), item: FactResponseSchema }),
    z.object({ ...candidateBase, kind: z.literal("claim"), item: ClaimResponseSchema }),
  ])),
});

export const ReviewCandidatesSchema = z.array(z.discriminatedUnion("kind", [
  z.object({...candidateBase, feedback: z.string().optional(), kind: z.literal("event"), item: EventResponseSchema}),
  z.object({...candidateBase, feedback: z.string().optional(), kind: z.literal("fact"), item: FactResponseSchema}),
  z.object({...candidateBase, feedback: z.string().optional(), kind: z.literal("claim"), item: ClaimResponseSchema}),
]));
export const ReconciliationPlanSchema = z.object({
  accepted: WindowCheckpointSchema.shape.evidence,
  pending: ReviewCandidatesSchema, escalated: ReviewCandidatesSchema, dateCandidates: ReviewCandidatesSchema,
  classificationCandidates: ReviewCandidatesSchema, attributionCandidates: ReviewCandidatesSchema,
});
export interface ReconciliationPlan {
  accepted: LocatedExtraction; pending: Candidate[]; escalated: Candidate[];
  dateCandidates: Candidate[]; classificationCandidates: Candidate[]; attributionCandidates: Candidate[];
}

export const eventDateFields = [
  "whenStartedYear", "whenStartedMonth", "whenStartedDay", "whenStartedSeason", "whenStartedQuarter",
  "whenEndedYear", "whenEndedMonth", "whenEndedDay", "whenEndedSeason", "whenEndedQuarter",
];
export const factDateFields = ["asOfYear", "asOfMonth", "asOfDay"];
export const claimDateFields = [
  "whenStartedYear", "whenStartedMonth", "whenStartedDay",
  "whenEndedYear", "whenEndedMonth", "whenEndedDay",
];

export type EventExtractionResponse = z.infer<typeof EventResponseSchema>;
export type FactExtractionResponse = z.infer<typeof FactResponseSchema>;
export type ClaimExtractionResponse = z.infer<typeof ClaimResponseSchema>;
export type EvidenceExtractionResponse = z.infer<typeof EvidenceExtractionResponseSchema>;

export interface LocatedEvidence<T> {
  item: T;
  pageNumber: number;
  sourceOffset: number;
  sourceQuote: string;
  sourceSpans: SourceSpan[];
  extractedBy: string[];
  eventDateResolution?: EventDateDecision;
}

export type Candidate = {
  id: string;
  kind: "event" | "fact" | "claim";
  item: EventExtractionResponse | FactExtractionResponse | ClaimExtractionResponse;
  extractedBy: string[];
  feedback?: string;
};

/** Optional private benchmark snapshots; production ingestion does not use them. */
export interface EvidenceCandidateSnapshotStore {
  mode: "capture" | "captureOnly" | "replay";
  get(window: EvidenceWindow): Promise<unknown | null>;
  put(window: EvidenceWindow, value: unknown): Promise<void>;
}

export interface LocatedExtraction {
  events: LocatedEvidence<EventExtractionResponse>[];
  facts: LocatedEvidence<FactExtractionResponse>[];
  claims: LocatedEvidence<ClaimExtractionResponse>[];
}

// Legacy snapshots remain parseable, while opt-in model requests require the
// compact annotation object. Off mode carries no annotation schema overhead.
export function evidenceRequestSchema(schema: z.AnyZodObject, eventStructureMode: "off" | "annotate", promptCompaction: "off" | "on"): z.AnyZodObject {
  const event = eventStructureMode === "annotate"
    ? EventResponseSchema.required({eventStructure: true}) : EventResponseSchema.omit({eventStructure: true});
  if (promptCompaction === "on") {
    if (schema === ReconciliationResponseSchema) return compactReconciliationSchema(event, FactResponseSchema, ClaimResponseSchema);
    if (schema === EventDateResponseSchema) return compactEventDateSchema();
  }
  if (schema === EventBatchSchema) return EventBatchSchema.extend({events: z.array(event)});
  if (schema === EvidenceExtractionResponseSchema) return EvidenceExtractionResponseSchema.extend({events: z.array(event)});
  if (schema === ReconciliationResponseSchema) return ReconciliationResponseSchema.extend({
    decisions: z.array(ReconciliationResponseSchema.shape.decisions.element.extend({events: z.array(event)})),
  });
  return schema;
}

