import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document } from "@langchain/core/documents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIndexedEvidenceReview, indexedReviewCheckpoints, indexedSearchQueryCache } from "../scripts/review-indexed-evidence.mjs";
import { EvidenceSearchLookup } from "../src/processors/evidence/evidenceSearchLookup.ts";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { formatEvidenceContent } from "../src/processors/evidence/evidenceContent.ts";
import { reconciliationCheckpointGuard, withReconciliationDeadline } from "../src/processors/evidence/evidenceReconciliationDeadline.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true}))); });
async function fixture(count = 2) {
  const directory = await mkdtemp(join(tmpdir(), "indexed-evidence-review-"));
  directories.push(directory);
  const text = "Casey attended the meeting.";
  const file = join(directory, "source.md");
  await writeFile(file, text);
  const source = new Document({pageContent: text, metadata: {sourceId: "source", pages: [1]}});
  const sourceHash = new EvidenceSource(source).contentHash;
  const rows = Array.from({length: count}, (_, index) => {
    const metadata = {accountId: "account", sourceId: "source", sourceContentHash: sourceHash,
      what: text, who: ["Casey"], subject: ["Casey"], reportedBy: [], tags: ["fact"], factType: "attribute",
      pages: [1], sourceOffset: 0, sourceQuote: text, sourceSpans: [{pageNumber: 1, sourceOffset: 0, sourceQuote: text}]};
    return {id: String(index), sourceId: "source", sourceContentHash: sourceHash, evidenceKind: "fact",
      content: formatEvidenceContent(metadata), metadata: JSON.stringify(metadata), content_vector: [1, 0]};
  });
  const search = vi.fn(async (query: string) => ({count: query === "*" ? rows.length : undefined,
    results: (async function* () { for (const document of rows) yield {document}; })()}));
  const lookup = new EvidenceSearchLookup({search} as any, "account", source);
  const values = {endpoint: "https://example.search.windows.net", index: "account-index", "account-id": "account",
    "source-id": "source", source: file, output: join(directory, "output")};
  return {directory, lookup, values, search, rows, source};
}

describe("indexed evidence review command", () => {
  it("saves a complete comparison without invoking a model or writing Search records", async () => {
    const {lookup, values} = await fixture();
    const review = vi.fn();
    const report = await runIndexedEvidenceReview(values, {lookup, review});
    expect(report).toMatchObject({mode: "preview", records: 2, indexChanged: false, newEmbeddingCalls: 0, usage: {calls: 0}});
    expect(report.preservedLexicalPairs).toBe(report.lexicalPairs);
    expect(review).not.toHaveBeenCalled();
    const saved = JSON.parse(await readFile(join(values.output, "snapshot.json"), "utf8"));
    expect(saved.records).toHaveLength(2);
    expect(saved.documents).toHaveLength(2);
    expect(JSON.parse(await readFile(join(values.output, "comparison.json"), "utf8"))).toEqual(report);
  });

  it("preserves the preview and blocks model work when the review bound is too small", async () => {
    const {lookup, values} = await fixture(3);
    const review = vi.fn();
    await expect(runIndexedEvidenceReview({...values, review: true, "max-review-pairs": "1"}, {lookup, review}))
      .rejects.toThrow("exceeding");
    expect(review).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(values.output, "comparison.json"), "utf8")).search.pairCount).toBe(3);
  });

  it("labels semantic-only measurements accurately when stored vectors cannot be read", async () => {
    const {lookup, values, rows} = await fixture();
    for (const row of rows) delete (row as {content_vector?: number[]}).content_vector;
    const report = await runIndexedEvidenceReview({...values, "without-vectors": true,
      "semantic-configuration": "Primary"}, {lookup});
    expect(report.requestedRetrieval).toBe("lexical+semantic");
    expect(report.reference).toContain("no vector-recall comparison");
    expect(report.local.candidatePlanningMs).toBe(report.lexicalCandidatePlanningMs);
    expect(report).toMatchObject({newEmbeddingCalls: 0, searchStats: {hybridQueries: 0, lexicalQueries: 1, cachedQueries: 1}});
  });

  it("produces a local proposal and records usage after verifying the snapshot again", async () => {
    const {lookup, values} = await fixture();
    const snapshot = await lookup.snapshot();
    const review = vi.fn(async (_snapshot, _source, _pairs, _values, usage) => {
      usage.calls++;
      return {documents: snapshot.documents, applied: [], failedBatches: 0, failedPairIds: []};
    });
    const report = await runIndexedEvidenceReview({...values, review: true, "max-review-pairs": "10"}, {lookup, review});
    expect(report).toMatchObject({indexChanged: false, usage: {calls: 1}, review: {remainingRecords: 2}});
    expect(JSON.parse(await readFile(join(values.output, "proposal.json"), "utf8"))).toMatchObject({
      originalIds: ["0", "1"], snapshotFingerprint: snapshot.fingerprint, indexChanged: false,
    });
  });

  it("does not publish a proposal when evidence changed during model review", async () => {
    const {lookup, values} = await fixture();
    const snapshot = await lookup.snapshot();
    vi.spyOn(lookup, "snapshot").mockResolvedValueOnce(snapshot).mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({...snapshot, fingerprint: "changed"});
    const review = vi.fn(async () => ({documents: snapshot.documents, applied: [], failedBatches: 0, failedPairIds: []}));
    await expect(runIndexedEvidenceReview({...values, review: true, "max-review-pairs": "10"}, {lookup, review}))
      .rejects.toThrow("proposal is stale");
    await expect(readFile(join(values.output, "proposal.json"))).rejects.toMatchObject({code: "ENOENT"});
  });

  it("restores paid decisions from disk across restarts and isolates source/model revisions", async () => {
    const {directory} = await fixture();
    const path = join(directory, "checkpoints"), identity = {accountId: "account", sourceId: "source", runFingerprint: "model-v1"};
    const value = {decisions: [{pairId: "0:1", relation: "same_assertion"}]};
    await indexedReviewCheckpoints(path).putStage(identity, 0, "pair-stage", value);
    const restarted = indexedReviewCheckpoints(path);
    expect(await restarted.getStage(identity, 0, "pair-stage")).toEqual(value);
    expect(await restarted.getStage({...identity, runFingerprint: "model-v2"}, 0, "pair-stage")).toBeNull();
    expect(await restarted.getStage({...identity, sourceId: "other"}, 0, "pair-stage")).toBeNull();
  });

  it("publishes acknowledged local decisions after the reconciliation scope closes", async () => {
    const {directory} = await fixture();
    const store = indexedReviewCheckpoints(join(directory, "checkpoints"));
    const identity = {accountId: "account", sourceId: "source", runFingerprint: "model-v1"};
    const value = {decisions: [{pairId: "0:1", relation: "same_assertion"}]};
    const timeout = vi.fn();
    await withReconciliationDeadline(10_000, async () => {
      await store.putStage(identity, 0, "pair-stage", value, reconciliationCheckpointGuard());
      expect(await store.getStage(identity, 0, "pair-stage")).toBeNull();
    }, timeout);
    expect(timeout).not.toHaveBeenCalled();
    expect(await store.getStage(identity, 0, "pair-stage")).toEqual(value);
  });

  it("rejects new local uploads after a deadline scope closes", async () => {
    const {directory} = await fixture();
    const store = indexedReviewCheckpoints(join(directory, "checkpoints"));
    const identity = {accountId: "account", sourceId: "source", runFingerprint: "model-v1"};
    const guard = await withReconciliationDeadline(10_000, async () => reconciliationCheckpointGuard(), vi.fn());
    await expect(store.putStage(identity, 0, "late-stage", {decisions: []}, guard)).rejects.toThrow("already closed");
    expect(await store.getStage(identity, 0, "late-stage")).toBeNull();
  });

  it("resumes Search lookups from disk and still verifies the current full snapshot", async () => {
    const {directory, search, source} = await fixture();
    const create = (indexName = "account-index") => new EvidenceSearchLookup({search, indexName} as any, "account", source, {},
      indexedSearchQueryCache(join(directory, "search-cache")));
    const first = create();
    const expected = await first.duplicatePairs(await first.snapshot());
    const calls = search.mock.calls.length;
    const resumed = create();
    expect(await resumed.duplicatePairs(await resumed.snapshot())).toEqual(expected);
    expect(search.mock.calls.slice(calls).map(([query]) => query)).toEqual(["*", "*"]);
    expect(resumed.stats).toMatchObject({cachedQueries: 2, hybridQueries: 0, lexicalQueries: 0, snapshotQueries: 2});
    const moved = create("another-index");
    await moved.duplicatePairs(await moved.snapshot());
    expect(moved.stats.hybridQueries).toBe(1);
  });
});
