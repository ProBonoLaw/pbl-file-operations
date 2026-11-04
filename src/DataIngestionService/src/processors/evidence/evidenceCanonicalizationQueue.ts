import {Document} from "@langchain/core/documents";
import {z} from "zod";
import {currentEvidenceReviewDispatcher, currentEvidenceTaskCancellation, EvidenceReviewPending, type EvidenceReviewTask} from "./evidenceAsync.js";
import {findCanonicalizationPairsAsync, type CanonicalizationPair} from "./evidenceCanonicalization.js";
import {canonicalizationPairInput} from "./evidenceCanonicalizationPrompt.js";
import type {EvidenceCanonicalizationRuntime} from "./evidenceCanonicalizationReview.js";
import {reviewCanonicalizationPairs} from "./evidenceCanonicalizationReviewBatch.js";
import type {StageCheckpointContext} from "./evidenceExtractionSchemas.js";
import {StoredCanonicalizationReviewSchema, partitionIdentityDecisions, type IdentityDecision} from "./evidenceIdentityReview.js";
import {METADATA_REVIEW_FIELDS} from "./evidenceMetadataReview.js";
import {assertReconciliationActive} from "./evidenceReconciliationDeadline.js";
import type {EvidenceSource} from "./evidenceSource.js";

const span = z.object({pageNumber:z.number().int().nonnegative(), sourceOffset:z.number().int().nonnegative(), sourceQuote:z.string().min(1)});
const pairSchema = z.object({id:z.string().min(1), leftIndex:z.number().int().nonnegative(), rightIndex:z.number().int().nonnegative(),
  similarity:z.number().finite(), allowedSurvivors:z.array(z.enum(["left", "right"])).min(1).max(2),
  matchReasons:z.array(z.enum(["phrase_overlap", "token_overlap", "token_difference", "shared_passage", "communication", "embedding", "search"])).optional(),
  metadataReview:z.object({inputHash:z.string(), fields:z.array(z.enum(METADATA_REVIEW_FIELDS)), documentContext:z.array(span)}).optional(),
}).passthrough();
const planSchema = z.object({pairs:z.array(pairSchema), embeddingInputCount:z.number().int().nonnegative(),
  batches:z.array(z.array(z.number().int().nonnegative()).min(1).max(16))});
const batchSchema = z.object({pairs:z.array(pairSchema).min(1).max(16),
  documents:z.array(z.object({index:z.number().int().nonnegative(), pageContent:z.string(), metadata:z.record(z.unknown())})).min(2).max(32)});
const resultSchema = StoredCanonicalizationReviewSchema.extend({failedPairIds:z.array(z.string()).max(16)});

export interface CanonicalizationPlan {
  pairs: CanonicalizationPair[];
  batches: number[][];
  embeddingInputCount: number;
}

export function validateCanonicalizationPlan(value: unknown, documentCount: number): CanonicalizationPlan {
  const plan = planSchema.parse(value);
  if (new Set(plan.pairs.map(pair => pair.id)).size !== plan.pairs.length || plan.pairs.some(pair =>
    pair.leftIndex === pair.rightIndex || pair.leftIndex >= documentCount || pair.rightIndex >= documentCount
    || pair.id !== `${Math.min(pair.leftIndex,pair.rightIndex)}:${Math.max(pair.leftIndex,pair.rightIndex)}`))
    throw new Error("Invalid canonicalization plan indexes");
  const indexes = plan.batches.flat();
  if (indexes.length !== plan.pairs.length || new Set(indexes).size !== indexes.length
    || indexes.some(index => index >= plan.pairs.length)) throw new Error("Invalid canonicalization plan batches");
  return plan;
}

/** All batches come from one saved plan; completed siblings never change task identities. */
export async function dispatchCanonicalizationReviews(runtime: EvidenceCanonicalizationRuntime, documents: readonly Document[],
  source: EvidenceSource, plan: CanonicalizationPlan, context: StageCheckpointContext) {
  const dispatcher = currentEvidenceReviewDispatcher();
  if (!dispatcher) throw new Error("Canonicalization reviews require a dispatcher");
  const {pairs} = plan;
  const batches = plan.batches.map(indexes => indexes.map(index => pairs[index]));
  const results: {reviewDecisions:IdentityDecision[]; failedPairIds:string[]}[] = new Array(batches.length);
  let next = 0, pending = 0, completed = 0, failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && next < batches.length) {
      const index = next++, batch = batches[index];
      try {
        assertReconciliationActive();
        currentEvidenceTaskCancellation()?.signal.throwIfAborted();
        const indexes = [...new Set(batch.flatMap(pair => [pair.leftIndex, pair.rightIndex]))].sort((a, b) => a - b);
        const result = resultSchema.parse(await dispatcher.result({version:1, component:"canonicalization", context,
          batchId:`canonicalization:${index + 1}`, candidates:[{pairs:batch,
            documents:indexes.map(index => ({index, pageContent:documents[index].pageContent, metadata:documents[index].metadata}))}],
          initialReviewer:"reconciliation", allowFailover:false}, source.document));
        const expected = new Set(batch.map(pair => pair.id));
        const returned = [...result.decisions.map(decision => decision.pairId), ...result.failedPairIds];
        if (returned.length !== expected.size || new Set(returned).size !== returned.length || returned.some(id => !expected.has(id)))
          throw new Error("Queued canonicalization results do not cover their batch");
        // Interpret the original assessment again with the current merge guards.
        const partition = partitionIdentityDecisions(batch.filter(pair => !result.failedPairIds.includes(pair.id)), result.decisions, documents, source);
        if (partition.errors.size || partition.unexpectedIds.length) throw new Error("Invalid queued canonicalization decisions");
        results[index] = {reviewDecisions:partition.valid, failedPairIds:result.failedPairIds};
        completed++;
      } catch (error) {
        if (error instanceof EvidenceReviewPending) pending++;
        else if (!failed) {failed = true; failure = error;}
      }
    }
  };
  // Bound queue/storage traffic without holding a model permit in the finalizer.
  await Promise.all(Array.from({length:Math.min(16, batches.length)}, worker));
  if (failed) throw failure;
  runtime.track("canonicalizationQueueProgress", {pairCount:String(pairs.length), batchCount:String(batches.length),
    completedBatchCount:String(completed), pendingBatchCount:String(pending)});
  if (pending) throw new EvidenceReviewPending();
  const accepted = new Map(results.flatMap(result => result.reviewDecisions).map(decision => [decision.pairId, decision]));
  return {reviewDecisions:pairs.flatMap(pair => accepted.has(pair.id) ? [accepted.get(pair.id)!] : []),
    failedBatches:results.filter(result => result.failedPairIds.length).length, failedPairIds:results.flatMap(result => result.failedPairIds)};
}

/** Review only this batch's records. Global pair IDs and pair checkpoints survive compaction. */
export async function executeCanonicalizationReviewTask(runtime: EvidenceCanonicalizationRuntime, task: EvidenceReviewTask, source: EvidenceSource) {
  if (task.component !== "canonicalization" || task.allowFailover || task.initialReviewer !== "reconciliation" || task.candidates.length !== 1)
    throw new Error("Invalid canonicalization task");
  const batch = batchSchema.parse(task.candidates[0]);
  const indexes = new Map(batch.documents.map((document, index) => [document.index, index]));
  const references = new Set(batch.pairs.flatMap(pair => [pair.leftIndex, pair.rightIndex]));
  if (indexes.size !== batch.documents.length || references.size !== indexes.size || [...references].some(index => !indexes.has(index))
    || new Set(batch.pairs.map(pair => pair.id)).size !== batch.pairs.length)
    throw new Error("Invalid canonicalization batch references");
  const documents = batch.documents.map(document => {
    const m = document.metadata;
    if (m.accountId !== task.context.identity.accountId || m.sourceId !== task.context.identity.sourceId || m.sourceContentHash !== source.contentHash)
      throw new Error("Canonicalization batch belongs to another source");
    return new Document({pageContent:document.pageContent, metadata:m});
  });
  const pairs = batch.pairs.map(pair => {
    // Left/right follow source offsets, which can differ from the document
    // array order. Only the stable ID sorts the global indexes numerically.
    if (pair.leftIndex === pair.rightIndex || pair.id !== `${Math.min(pair.leftIndex,pair.rightIndex)}:${Math.max(pair.leftIndex,pair.rightIndex)}`)
      throw new Error("Invalid canonicalization pair identity");
    return {...pair, leftIndex:indexes.get(pair.leftIndex)!, rightIndex:indexes.get(pair.rightIndex)!};
  });
  // Recheck eligibility against the source without re-embedding or planning the
  // entire document. A queued payload cannot loosen survivor/detail safeguards.
  const eligible = await findCanonicalizationPairsAsync(documents, {source, searchPairs:pairs});
  for (const pair of pairs) {
    const current = eligible.find(candidate => candidate.leftIndex === pair.leftIndex && candidate.rightIndex === pair.rightIndex);
    if (!current || JSON.stringify(current.allowedSurvivors) !== JSON.stringify(pair.allowedSurvivors)
      || JSON.stringify(canonicalizationPairInput({...current, id:pair.id}, documents, source)) !== JSON.stringify(canonicalizationPairInput(pair, documents, source)))
      throw new Error("Canonicalization batch no longer matches source eligibility");
  }
  const result = await reviewCanonicalizationPairs(runtime, documents, source, pairs, task.context, {batchId:task.batchId});
  return {decisions:result.assessments, failedPairIds:result.failedPairIds};
}
