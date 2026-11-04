import { Document } from "@langchain/core/documents";
import { createHash } from "node:crypto";
import {currentEvidenceReviewDispatcher, currentEvidenceTaskCancellation} from "./evidenceAsync.js";
import {
  applyCanonicalizationDecisionsAsync, canonicalizationReviewBatchesAsync, findCanonicalizationPairsAsync,
  type CanonicalizationDecision,
} from "./evidenceCanonicalization.js";
import type { EvidenceCheckpointIdentity } from "./evidenceCheckpoint.js";
import { budgetErrorCode } from "./evidenceCostBudget.js";
import {
  duplicateEmbeddingInputs, type DuplicateEmbeddingProvider, type DuplicateRetrievalOptions,
} from "./evidenceDocumentDeduplication.js";
import { linkEventMentions } from "./evidenceEventMentions.js";
import type { EvidenceModel } from "./evidenceModels.js";
import { EvidenceSource } from "./evidenceSource.js";
import { type EvidenceSourceLookup } from "./evidenceSourceLookup.js";
import { EvidenceStageCheckpoints } from "./evidenceStageCheckpoints.js";
import type { EvidenceStructuredInvoker } from "./evidenceStructuredInvocation.js";
import {assertReconciliationActive} from "./evidenceReconciliationDeadline.js";
import {reviewCanonicalizationPairs} from "./evidenceCanonicalizationReviewBatch.js";
import {dispatchCanonicalizationReviews, validateCanonicalizationPlan} from "./evidenceCanonicalizationQueue.js";

export interface EvidenceCanonicalizationRuntime {
  duplicateEmbeddings?: DuplicateEmbeddingProvider;
  reconciliationModel: EvidenceModel;
  promptCompaction: "on" | "off";
  checkpoints: EvidenceStageCheckpoints;
  sourceLookup(source: EvidenceSource): Promise<EvidenceSourceLookup | undefined>;
  checkpointIdentity(source: EvidenceSource): Promise<EvidenceCheckpointIdentity | null>;
  invokeStructured: EvidenceStructuredInvoker;
  track(name: string, properties: Record<string, string>): void;
}

/** Retrieve paraphrases after source validation, before final indexing embeddings. */
export async function canonicalizeEvidenceDocuments(runtime: EvidenceCanonicalizationRuntime, documents: readonly Document[], sourceDocument: Document,
  options: {retrieval?: DuplicateRetrievalOptions; sourceContext?: "prefetch"} = {}) {
  const source = new EvidenceSource(sourceDocument);
  if (documents.some(document => document.metadata.sourceContentHash !== source.contentHash)) {
    throw new Error("Evidence canonicalization source does not match the documents");
  }
  const baseIdentity = await runtime.checkpointIdentity(source);
  const identity = baseIdentity && options.sourceContext ? {...baseIdentity, runFingerprint: createHash("sha256")
    .update(JSON.stringify([baseIdentity.runFingerprint, options.sourceContext])).digest("hex")} : baseIdentity;
  const window = source.windows()[0];
  const context = identity && window ? {identity, windowIndex:0} : undefined;
  const queued = !!currentEvidenceReviewDispatcher() && !!context && !options.retrieval && !options.sourceContext;
  const generatePlan = async () => {
    runtime.track("canonicalizationPlanStarted", {documentCount:String(documents.length)});
    if (options.retrieval) {
      // Indexed-evidence reviews reuse stored vectors/Search leads. Do not pay
      // for another embedding pass or silently discard invalid retrieval input.
      return {pairs:await findCanonicalizationPairsAsync(documents, {...options.retrieval, source}), embeddingInputCount:0};
    }
    try {
      const vectors = runtime.duplicateEmbeddings && documents.length > 1
        ? await runtime.duplicateEmbeddings.vectors(duplicateEmbeddingInputs(documents)) : undefined;
      assertReconciliationActive();
      currentEvidenceTaskCancellation()?.signal.throwIfAborted();
      return {pairs:await findCanonicalizationPairsAsync(documents, {vectors, source}), embeddingInputCount:vectors?.filter(vector => vector !== null).length ?? 0};
    } catch (error) {
      assertReconciliationActive();
      currentEvidenceTaskCancellation()?.signal.throwIfAborted();
      if (budgetErrorCode(error) || error instanceof Error
        && ["AbortError", "TimeoutError"].includes(error.name)) throw error;
      runtime.track("canonicalizationEmbeddingFallback", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return {pairs:await findCanonicalizationPairsAsync(documents, {source}), embeddingInputCount:0};
    }
  };
  // Freeze the complete plan before fan-out. A resumed finalizer neither
  // re-embeds the corpus nor regroups partially completed queue tasks.
  const plan = queued ? await runtime.checkpoints.run(context, source, window,
    "canonicalization-plan-v2", {documents:documents.map(({pageContent, metadata}) => ({pageContent, metadata})),
      promptCompaction:runtime.promptCompaction,
      embeddingFingerprint:runtime.duplicateEmbeddings?.fingerprint ?? (runtime.duplicateEmbeddings ? "unspecified" : "disabled")},
    value => validateCanonicalizationPlan(value, documents.length), async () => {
      const plan = await generatePlan();
      const batches = await canonicalizationReviewBatchesAsync(plan.pairs, runtime.promptCompaction === "on");
      const indexes = new Map(plan.pairs.map((pair, index) => [pair.id, index]));
      return {...plan, batches:batches.map(batch => batch.map(pair => indexes.get(pair.id)!))};
    }) : {...await generatePlan(), batches:[]};
  const {pairs, embeddingInputCount} = plan;
  runtime.track("canonicalizationPlanReady", {documentCount:String(documents.length), pairCount:String(pairs.length), queued:String(queued)});
  const {reviewDecisions, failedBatches, failedPairIds} = queued
    ? await dispatchCanonicalizationReviews(runtime, documents, source, plan, context!)
    : await reviewCanonicalizationPairs(runtime, documents, source, pairs, context, options);
  const decisions: CanonicalizationDecision[] = reviewDecisions.flatMap(decision =>
    decision.verdict === "duplicate" && decision.survivor !== "none"
      ? [{pairId:decision.pairId, survivor:decision.survivor, reason:decision.reason,
        leftOnlyDetails:decision.leftOnlyDetails, rightOnlyDetails:decision.rightOnlyDetails,
        ...(decision.metadataResolutions ? {metadataResolutions:decision.metadataResolutions} : {}),
        ...(decision.semanticAssessment ? {semanticAssessment:decision.semanticAssessment, relation:decision.relation} : {})}] : []);
  const applied = await applyCanonicalizationDecisionsAsync(documents, pairs, decisions, source);
  runtime.track("canonicalizationCompleted", {
    documentCount: String(documents.length), pairCount: String(pairs.length),
    embeddingCandidateCount: String(pairs.filter(pair => pair.matchReasons?.includes("embedding")).length),
    searchCandidateCount: String(pairs.filter(pair => pair.matchReasons?.includes("search")).length),
    embeddingInputCount: String(embeddingInputCount),
    tokenCandidateCount: String(pairs.filter(pair => pair.matchReasons?.some(reason => reason === "token_overlap" || reason === "token_difference")).length),
    proposedMergeCount: String(decisions.length), mergedCount: String(applied.applied.length),
    indexedCount: String(applied.documents.length), failedBatches: String(failedBatches),
    failedPairCount:String(failedPairIds.length),
    model: runtime.reconciliationModel.deployment,
  });
  return { ...applied, documents: linkEventMentions(applied.documents).documents, pairs, decisions, reviewDecisions, failedBatches, failedPairIds };
}

