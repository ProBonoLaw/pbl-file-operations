import type { Document } from "@langchain/core/documents";
import { evidenceComparisonText, evidencePrimarySpan, sharedPrimaryPassage } from "./evidencePageIdentity.js";
import {finishEvidenceComputation, runEvidenceComputation} from "./evidenceCooperativeComputation.js";

export type DuplicateMatchReason = "phrase_overlap" | "token_overlap" | "token_difference" | "shared_passage" | "communication" | "embedding" | "search";
export interface RetrievedDuplicatePair { leftIndex: number; rightIndex: number }
export interface DuplicateRetrievalOptions {
  vectors?: readonly (readonly number[] | null)[];
  embeddingThreshold?: number;
  embeddingTopK?: number;
  /** Additional Search leads, never merge decisions. Lexical retrieval remains enabled. */
  searchPairs?: readonly RetrievedDuplicatePair[];
}
export interface DuplicateEmbeddingProvider {
  readonly fingerprint?: string;
  vectors(texts: readonly string[]): Promise<(number[] | null)[]>;
}

// Embed the assertion, not its tags or entire quotation: different propositions
// can share a citation. Source context is supplied separately to semantic review.
export const duplicateEmbeddingInputs = (documents: readonly Document[]): string[] =>
  documents.map(document => typeof document.metadata.what === "string" ? document.metadata.what.trim() : "");
export interface DocumentDuplicateCandidate {
  id: string;
  leftIndex: number;
  rightIndex: number;
  similarity: number;
  embeddingSimilarity?: number;
  matchReasons: DuplicateMatchReason[];
}

interface Neighbor { id: string; score: number }
/** Keep a sorted, bounded list without reallocating/sorting it per pair. */
function insertNeighbor(best: Neighbor[], candidate: Neighbor, limit: number): void {
  let position = 0;
  while (position < best.length && (best[position].score > candidate.score
    || best[position].score === candidate.score && best[position].id.localeCompare(candidate.id) < 0)) position++;
  if (position >= limit) return;
  best.splice(position, 0, candidate);
  if (best.length > limit) best.pop();
}

// Retrieval only: keep names, negation, modality, relationships and measure
// descriptors. The exploratory scan removed these, requiring manual repairs.
const grammatical = new Set("a an the of to and was is were are be been being in on for with as that by at this has have had s".split(" "));
const comparison = (value: unknown) => evidenceComparisonText(value)
  .replace(/[–—]/gu, "-").replace(/\b(\d+)(?:st|nd|rd|th)\b/gu, "$1");
const words = (value: string) => value.match(/[\p{L}\p{N}]+/gu) ?? [];
const stem = (word: string) => word.length > 4 && /^[a-z]+$/u.test(word)
  ? word.replace(/(?:ing|ed|s)$/u, "").replace(/e$/u, "") : word;

/** Comparison values preserve signs, decimals and full dates. Stored wording
 * is untouched. Equal numbers do not establish equal measures or assertions.
 */
export const evidenceComparisonNumbers = (value: unknown): string[] =>
  [...new Set(comparison(value).match(/(?<![\p{L}\p{N}])[-+]?\d+(?:[.,:/-]\d+)*(?:%)?/gu) ?? [])].sort();

function profile(value: unknown) {
  const tokens = words(comparison(value));
  return {
    phrases: tokens.length < 3 ? tokens : tokens.slice(0, -1).map((token, index) => token + " " + tokens[index + 1]),
    terms: new Set(tokens.filter(token => !grammatical.has(token)).map(stem)),
    numbers: evidenceComparisonNumbers(value),
  };
}

function phraseOverlap(left: readonly string[], right: readonly string[]): number {
  if (!left.length || !right.length) return 0;
  const counts = new Map<string, number>();
  for (const term of right) counts.set(term, (counts.get(term) ?? 0) + 1);
  let common = 0;
  for (const term of left) {
    const count = counts.get(term) ?? 0;
    if (count) { common++; counts.set(term, count - 1); }
  }
  return 2 * common / (left.length + right.length);
}

/** Scan all evidence representations together, within each primary page of
 * one account/source revision. Token Jaccard and small symmetric differences
 * recover reordered/inflected wording missed by phrase overlap. This component
 * proposes comparisons only; metadata and semantic review authorize removal.
 */
export function findDocumentDuplicateCandidates(documents: readonly Document[], options: DuplicateRetrievalOptions = {}): DocumentDuplicateCandidate[] {
  return finishEvidenceComputation(duplicateCandidateSteps(documents, options));
}

export function findDocumentDuplicateCandidatesAsync(documents: readonly Document[], options: DuplicateRetrievalOptions = {}): Promise<DocumentDuplicateCandidate[]> {
  return runEvidenceComputation(duplicateCandidateSteps(documents, options));
}

function* duplicateCandidateSteps(documents: readonly Document[], options: DuplicateRetrievalOptions): Generator<void,DocumentDuplicateCandidate[]> {
  const threshold = options.embeddingThreshold ?? 0.82, topK = options.embeddingTopK ?? 8;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1 || !Number.isSafeInteger(topK) || topK < 1)
    throw new Error("Invalid duplicate embedding retrieval limits");
  if (options.vectors && options.vectors.length !== documents.length) throw new Error("Duplicate vectors must align with documents");
  const searchPairs = new Set((options.searchPairs ?? []).map(({leftIndex, rightIndex}) => {
    if (![leftIndex, rightIndex].every(index => Number.isSafeInteger(index) && index >= 0 && index < documents.length)
      || leftIndex === rightIndex) throw new Error("Invalid Search duplicate pair indices");
    return `${Math.min(leftIndex, rightIndex)}:${Math.max(leftIndex, rightIndex)}`;
  }));
  let dimensions: number | undefined;
  const normalizeVector = (vector: readonly number[] | null) => {
    if (!vector?.length || !vector.every(Number.isFinite)) return null;
    let squaredNorm = 0;
    for (const value of vector) squaredNorm += value * value;
    const norm = Math.sqrt(squaredNorm);
    if (!Number.isFinite(norm) || !norm) return null;
    dimensions ??= vector.length;
    if (vector.length !== dimensions) throw new Error("Inconsistent duplicate embedding dimensions");
    return Float32Array.from(vector, value => value / norm);
  };
  const vectors: (Float32Array | null)[] | undefined = options.vectors ? [] : undefined;
  if (vectors) for (const vector of options.vectors!) {
    vectors.push(normalizeVector(vector));
    if (vectors.length % 16 === 0) yield;
  }
  const profiles: ReturnType<typeof profile>[] = [];
  for (const document of documents) {
    profiles.push(profile(document.metadata.what));
    if (profiles.length % 32 === 0) yield;
  }
  const buckets = new Map<string, number[]>();
  documents.forEach((document, index) => {
    const m = document.metadata, primary = evidencePrimarySpan(m);
    if (!primary || !m.sourceContentHash || !m.sourceId) return;
    const key = JSON.stringify([m.accountId, m.sourceContentHash, m.sourceId, primary.pageNumber]);
    const indices = buckets.get(key) ?? [];
    indices.push(index);
    buckets.set(key, indices);
  });
  const candidates: DocumentDuplicateCandidate[] = [];
  let comparisons = 0;
  for (const indices of buckets.values()) {
    const semantic = new Map<string, number>();
    const neighbors = new Map<number, Neighbor[]>();
    if (vectors) for (let i = 0; i < indices.length; i++) for (let j = i + 1; j < indices.length; j++) {
      if (++comparisons % 128 === 0) yield;
      const a = indices[i], b = indices[j], left = vectors[a], right = vectors[b];
      if (!left || !right) continue;
      let product = 0;
      for (let dimension = 0; dimension < left.length; dimension++) product += left[dimension] * right[dimension];
      const score = Math.min(1, Math.max(-1, product));
      if (score < threshold) continue;
      const id = `${Math.min(a, b)}:${Math.max(a, b)}`;
      for (const index of [a, b]) {
        const best = neighbors.get(index) ?? [];
        insertNeighbor(best, {id, score}, topK);
        neighbors.set(index, best);
      }
    }
    for (const best of neighbors.values()) for (const neighbor of best) semantic.set(neighbor.id, neighbor.score);
    indices.sort((a, b) => evidencePrimarySpan(documents[a].metadata)!.sourceOffset
      - evidencePrimarySpan(documents[b].metadata)!.sourceOffset || a - b);
    for (let i = 0; i < indices.length; i++) for (let j = i + 1; j < indices.length; j++) {
      if (++comparisons % 32 === 0) yield;
      const leftIndex = indices[i], rightIndex = indices[j];
      const left = documents[leftIndex].metadata, right = documents[rightIndex].metadata;
      const a = profiles[leftIndex], b = profiles[rightIndex];
      const score = phraseOverlap(a.phrases, b.phrases);
      const common = [...a.terms].filter(term => b.terms.has(term)).length;
      const union = a.terms.size + b.terms.size - common;
      const difference = union - common;
      const reasons: DuplicateMatchReason[] = [];
      const id = `${Math.min(leftIndex, rightIndex)}:${Math.max(leftIndex, rightIndex)}`;
      const embeddingSimilarity = semantic.get(id);
      if (searchPairs.has(id)) reasons.push("search");
      if (embeddingSimilarity !== undefined) reasons.push("embedding");
      if (score >= 0.4) reasons.push("phrase_overlap");
      const sameNumbers = JSON.stringify(a.numbers) === JSON.stringify(b.numbers);
      if (sameNumbers && common >= 2) {
        if (common / union >= 0.6) reasons.push("token_overlap");
        if (difference <= 2) reasons.push("token_difference");
      }
      if (sharedPrimaryPassage(left, right)) reasons.push("shared_passage");
      const communication = (m: Record<string, unknown>) => !m.factType && !m.claimType
        && Array.isArray(m.tags) && m.tags.includes("eventType:communication");
      const first = evidencePrimarySpan(left)!, second = evidencePrimarySpan(right)!;
      if (communication(left) && communication(right) && score >= 0.1
        && first.sourceOffset === second.sourceOffset
        && (first.sourceQuote.includes(second.sourceQuote) || second.sourceQuote.includes(first.sourceQuote))) reasons.push("communication");
      if (reasons.length) candidates.push({id,
        leftIndex, rightIndex, similarity: score, matchReasons: reasons,
        ...(embeddingSimilarity !== undefined ? {embeddingSimilarity} : {})});
    }
  }
  return candidates.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
}
