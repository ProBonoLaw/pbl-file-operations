import { findCanonicalizationPairs } from "./evidenceCanonicalization.js";
import { measureCanonicalizationPlan } from "./evidenceCanonicalizationPrompt.js";
import type { RetrievedDuplicatePair } from "./evidenceDocumentDeduplication.js";
import type { IndexedEvidenceSnapshot } from "./evidenceSearchLookup.js";
import type { EvidenceSource } from "./evidenceSource.js";

/** Compare retrieval on the same stored vectors; these represent indexed
 * content, not the assertion-only embeddings used during fresh ingestion.
 * Candidate coverage is not an adjudicated duplicate recall measurement.
 */
export function compareIndexedEvidenceRetrieval(snapshot: IndexedEvidenceSnapshot, searchPairs: readonly RetrievedDuplicatePair[],
  source: EvidenceSource, accountId: string, topK = 8) {
  const start = performance.now();
  const lexical = findCanonicalizationPairs(snapshot.documents, {source});
  const lexicalElapsedMs = performance.now() - start;
  const hasVectors = snapshot.records.some(record => record.content_vector?.some(value => value !== 0));
  const localStarted = performance.now();
  const local = hasVectors ? findCanonicalizationPairs(snapshot.documents, {source,
    vectors: snapshot.records.map(record => record.content_vector ?? null), embeddingTopK: topK}) : lexical;
  const localElapsedMs = hasVectors ? performance.now() - localStarted : lexicalElapsedMs;
  const search = findCanonicalizationPairs(snapshot.documents, {source, searchPairs});
  const lexicalIds = new Set(lexical.map(pair => pair.id));
  const localIds = new Set(local.map(pair => pair.id)), searchIds = new Set(search.map(pair => pair.id));
  const scope = {accountId, sourceId: String(source.document.metadata.sourceId), contentHash: source.contentHash};
  return {
    snapshotFingerprint: snapshot.fingerprint, records: snapshot.records.length,
    reference: hasVectors ? "Local scan of the same indexed-content vectors; not an assertion-embedding or quality baseline."
      : "Local lexical candidates only; no stored vectors available and no vector-recall comparison.",
    lexicalPairs: lexical.length,
    lexicalCandidatePlanningMs: lexicalElapsedMs,
    local: {...measureCanonicalizationPlan(local, snapshot.documents, source, scope), candidatePlanningMs: localElapsedMs},
    search: measureCanonicalizationPlan(search, snapshot.documents, source, scope),
    preservedLexicalPairs: lexical.filter(pair => searchIds.has(pair.id)).length,
    sharedPairs: local.filter(pair => searchIds.has(pair.id)).length,
    searchOnlyPairIds: search.filter(pair => !localIds.has(pair.id)).map(pair => pair.id),
    localOnlyPairIds: local.filter(pair => !searchIds.has(pair.id)).map(pair => pair.id),
    addedSearchPairs: search.filter(pair => !lexicalIds.has(pair.id)).length,
    planningElapsedMs: performance.now() - start,
    pairs: search,
  };
}
