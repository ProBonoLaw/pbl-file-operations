import { GraphRecursionError } from "@langchain/langgraph";
import { MultipleStructuredOutputsError } from "langchain";
import { z } from "zod";
import { needsClaimantReview } from "./evidenceAttribution.js";
import { prepareEvidenceCitations } from "./evidenceCitationResolution.js";
import {
  compactReconciliationSchema, expandCompactEventDate, expandCompactReconciliation,
} from "./evidenceCompactResponses.js";
import { isEvidenceContentFilter } from "./evidenceContentFilter.js";
import { EventDateResponseSchema } from "./evidenceEventDates.js";
import {
  evidenceRequestSchema, ReconciliationResponseSchema, type Candidate, type EventExtractionResponse,
  type StageCheckpointContext,
} from "./evidenceExtractionSchemas.js";
import { EvidenceExtractionValidation } from "./evidenceExtractionValidation.js";
import type { EvidenceModel } from "./evidenceModels.js";
import { DecisionEnvelopeSchema, partitionDecisions } from "./evidenceReviewDecisions.js";
import { boundaryReviewContext, eventClassificationConcerns } from "./evidenceReviewRouting.js";
import { EvidenceSource, type EvidenceWindow } from "./evidenceSource.js";
import { EvidenceStageCheckpoints } from "./evidenceStageCheckpoints.js";
import { EvidenceStructuredResponseError, type EvidenceStructuredInvoker } from "./evidenceStructuredInvocation.js";
import type { EvidenceReviewIssue } from "./evidenceSupport.js";
import { classificationIssues } from "./evidenceTaxonomy.js";

/** Builds source context and validates/checkpoints decisions independently per candidate. */
export class EvidenceDecisionReview {
  constructor(private readonly settings: {
    promptCompaction: "off" | "on";
    eventStructureMode: "off" | "annotate";
    reconciliationFallback: EvidenceModel | null;
  }, private readonly invokeStructured: EvidenceStructuredInvoker,
    private readonly checkpoints: EvidenceStageCheckpoints,
    private readonly validation: EvidenceExtractionValidation,
    private readonly track: (name: string, properties: Record<string, string>) => void) {}

  private reviewIssue(category: EvidenceReviewIssue, stage: string, model: EvidenceModel,
    properties: Record<string, string>): void {
    this.track("reviewIssue", { category, stage, model: model.deployment, ...properties });
  }

  reviewCandidateInput(candidate: Candidate, source: EvidenceSource, window: EvidenceWindow) {
    return {
      candidateId: candidate.id, kind: candidate.kind, item: candidate.item, feedback: candidate.feedback,
      citationErrors: this.validation.citationResult(candidate.item, source, window).errors,
      citationChoices: prepareEvidenceCitations(candidate.item, source, window).choices.map(choice => ({ ...choice,
        ...(choice.reason === "quotation-mismatch" ? {context: source.quoteContext(choice, 180)} : {}) })),
      classificationIssues: classificationIssues(candidate.item),
      boundaryContext: boundaryReviewContext(candidate.item.sourceQuote, source, window),
      eventClassificationConcerns: candidate.kind === "event"
        ? eventClassificationConcerns(candidate.item as EventExtractionResponse) : [],
    };
  }

  reviewContext(candidates: Candidate[], source: EvidenceSource, window: EvidenceWindow,
    purpose: "dates" | "review") {
    const hits = source.context.cacheHits;
    const passages = new Map<string, ReturnType<typeof source.context.lookup>[number]>();
    for (const candidate of candidates) {
      const item = candidate.item;
      const eventRoles = this.settings.eventStructureMode === "annotate" && candidate.kind === "event";
      if (purpose === "review" && !("claimant" in item && needsClaimantReview(item.claimant))
        && !("reportedBy" in item && item.reportedBy.length === 0) && !eventRoles) continue;
      const query = ("statement" in item ? item.statement : item.what) + " " + item.sourceQuote
        + (eventRoles && "who" in item ? " " + item.who.join(" ") : "");
      const focus = purpose === "review" && !eventRoles ? "attribution" : purpose;
      for (const passage of source.context.lookup(window.pageNumber, query, focus, 3)) {
        if (purpose === "review" && passage.pageNumber === window.pageNumber
          && passage.sourceOffset >= window.startOffset
          && passage.sourceOffset + passage.sourceQuote.length <= window.startOffset + window.text.length) continue;
        passages.set(passage.id, passage);
      }
    }
    const selected = [...passages.values()].slice(0, 6);
    this.track("documentContextSelected", { page: String(window.pageNumber), purpose,
      passageCount: String(selected.length), cacheHits: String(source.context.cacheHits - hits),
      characterCount: String(selected.reduce((sum, passage) => sum + passage.sourceQuote.length, 0)) });
    return selected;
  }

  async decisionBatch<T extends { candidateId: string }>(candidates: Candidate[], schema: z.AnyZodObject,
    validate: (value: unknown) => T, instructions: string, content: (items: Candidate[]) => string,
    model: EvidenceModel, stage: string, source: EvidenceSource, window: EvidenceWindow, batchId: string,
    context?: StageCheckpointContext, systemPrompt?: string, cacheable: (decision: T) => boolean = () => true) {
    const progressStage = `decisions:${stage}:${batchId}`;
    const input = { candidates, deployment: model.deployment, provider: model.provider };
    const saved = await this.checkpoints.read(context, source, window, progressStage, input, value => {
      const rows = DecisionEnvelopeSchema.parse(value).decisions;
      const parsed = rows.map(validate);
      const ids = new Set(parsed.map(row => row.candidateId));
      if (ids.size !== rows.length || parsed.some(row => !candidates.some(item => item.id === row.candidateId) || !cacheable(row))) {
        throw new Error("Decision checkpoint has invalid candidate IDs");
      }
      return parsed;
    }) ?? [];
    const remaining = candidates.filter(candidate => !saved.some(row => row.candidateId === candidate.id));
    if (!remaining.length) return { valid: saved, errors: new Map<string, string>(), unexpectedIds: [] as string[] };
    let response: z.infer<typeof DecisionEnvelopeSchema>;
    try {
      response = await this.invokeStructured(schema, instructions, content(remaining), model, stage, source,
        { batchId, useContextSearch: true, systemPrompt, parse: value => DecisionEnvelopeSchema.parse(value) });
    } catch (error) {
      if (isEvidenceContentFilter(error)) throw error;
      const exhausted = error instanceof GraphRecursionError || error instanceof MultipleStructuredOutputsError;
      const invalidResponse = error instanceof z.ZodError || error instanceof EvidenceStructuredResponseError;
      if (exhausted || invalidResponse) {
        this.reviewIssue(exhausted ? "loop" : "schema", stage, model,
          { batchId, candidateCount: String(remaining.length), scope: "response" });
      }
      if (exhausted && stage === "reconciliation" && this.settings.reconciliationFallback) {
        this.track("reviewLoopEscalated", {batchId, model:model.deployment,
          candidateCount:String(remaining.length), reusedCount:String(saved.length), reason:error.name});
      } else if (!invalidResponse || !this.settings.reconciliationFallback) throw error;
      return { valid: saved, errors: new Map(remaining.map(candidate => [candidate.id,
        (exhausted ? "Review loop exhausted; independently review the remaining candidate: " : "Invalid structured review response: ")
          + error.message])), unexpectedIds: [] as string[] };
    }
    // Decode only new model rows; checkpoints continue to contain the validated
    // durable shape. Partition first so one bad compact row cannot discard peers.
    const decode = this.settings.promptCompaction !== "on" ? (value: unknown) => value
      : schema === ReconciliationResponseSchema
        ? (value: unknown) => expandCompactReconciliation(value,
          evidenceRequestSchema(schema, this.settings.eventStructureMode, this.settings.promptCompaction) as ReturnType<typeof compactReconciliationSchema>)
        : schema === EventDateResponseSchema ? expandCompactEventDate : (value: unknown) => value;
    const result = partitionDecisions(remaining.map(candidate => candidate.id), response.decisions, value => validate(decode(value)));
    if (result.errors.size || result.unexpectedIds.length) {
      this.reviewIssue("schema", stage, model, { batchId, candidateCount: String(result.errors.size),
        unexpectedIdCount: String(result.unexpectedIds.length), scope: "decisions" });
    }
    result.valid.unshift(...saved);
    const reusable = result.valid.filter(cacheable);
    if (reusable.length) await this.checkpoints.save(context, source, window, progressStage, input, { decisions: reusable });
    this.track("reviewDecisionsValidated", { stage, batchId, validCount: String(result.valid.length),
      invalidCount: String(result.errors.size), ignoredForeignIds: String(result.unexpectedIds.length),
      reusedCount: String(saved.length), model: model.deployment });
    return result;
  }

}
