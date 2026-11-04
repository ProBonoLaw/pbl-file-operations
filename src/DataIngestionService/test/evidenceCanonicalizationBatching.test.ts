import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { canonicalizationReviewBatches, type CanonicalizationPair } from "../src/processors/evidence/evidenceCanonicalization.ts";
import { measureCanonicalizationPlan } from "../src/processors/evidence/evidenceCanonicalizationPrompt.ts";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";

function fixture() {
  const text = "Casey completed the assessment. " + "The source explains the same assessment context in detail. ".repeat(30);
  const source = new EvidenceSource(new Document({pageContent: text, metadata: {sourceId: "source", pages: [1]}}));
  const documents = Array.from({length: 80}, (_, index) => new Document({pageContent: "", metadata: {
    what: `Casey completed assessment ${index}.`, who: ["Casey"], tags: ["fact"], factType: "attribute",
    sourceSpans: [{pageNumber: 1, sourceOffset: 0, sourceQuote: text}],
  }}));
  const pairs: CanonicalizationPair[] = [];
  // Interleave independent stars as a similarity-ranked retrieval list can do.
  for (let neighbor = 1; neighbor <= 9; neighbor++) for (let group = 0; group < 8; group++) {
    const leftIndex = group * 10, rightIndex = leftIndex + neighbor;
    pairs.push({id: `${leftIndex}:${rightIndex}`, leftIndex, rightIndex, similarity: 1 - neighbor / 100,
      allowedSurvivors: ["left", "right"]});
  }
  return {source, documents, pairs};
}

describe("canonicalization request grouping", () => {
  it("keeps every pair exactly once, with stable IDs and bounded deterministic batches", () => {
    const {pairs} = fixture(), before = JSON.stringify(pairs);
    const batches = canonicalizationReviewBatches(pairs, true);
    expect(batches.every(batch => batch.length <= 16)).toBe(true);
    expect(batches.flat().map(pair => pair.id).sort()).toEqual(pairs.map(pair => pair.id).sort());
    expect(canonicalizationReviewBatches(pairs, true)).toEqual(batches);
    expect(JSON.stringify(pairs)).toBe(before);
    expect(canonicalizationReviewBatches([], true)).toEqual([]);
  });

  it("reduces repeated record payloads while preserving the same comparisons", () => {
    const {source, documents, pairs} = fixture();
    const report = measureCanonicalizationPlan(pairs, documents, source,
      {accountId: "account", sourceId: "source", contentHash: source.contentHash});
    expect(report.pairCount).toBe(pairs.length);
    expect(report.batchCount).toBe(5);
    expect(report.groupedCompactPayloadTokens).toBeLessThan(report.sequentialCompactPayloadTokens);
    expect(report.groupedCompactPayloadTokens).toBeLessThan(report.sequentialPayloadTokens);
  });

  it.each([0, -1, 1.5, NaN])("rejects invalid batch size %s", size => {
    expect(() => canonicalizationReviewBatches([], true, size)).toThrow("batch size");
  });
});
