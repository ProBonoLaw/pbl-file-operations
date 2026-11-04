import { describe, expect, it } from "vitest";
import { createReviewBatches } from "../src/processors/evidence/evidenceReviewBatching.js";

describe("evidence review batching", () => {
  it("preserves the existing 16-candidate fixed batches", () => {
    const candidates = Array.from({ length: 34 }, (_, index) => index);
    const batches = createReviewBatches(candidates, "fixed");

    expect(batches.map(batch => batch.items.length)).toEqual([16, 16, 2]);
    expect(batches.flatMap(batch => batch.items)).toEqual(candidates);
  });

  it("packs by both the candidate count and estimated token budget without dropping IDs", () => {
    const candidates = Array.from({ length: 50 }, (_, index) => index);
    const countLimited = createReviewBatches(candidates, "tokenAware", () => 100);
    const tokenLimited = createReviewBatches(candidates, "tokenAware", () => 1_000);

    expect(countLimited.map(batch => batch.items.length)).toEqual([24, 24, 2]);
    expect(tokenLimited.map(batch => batch.items.length)).toEqual(Array(10).fill(5));
    expect(tokenLimited.flatMap(batch => batch.items)).toEqual(candidates);
    expect(tokenLimited.every(batch => (batch.estimatedCandidateTokens ?? 0) <= 5_000)).toBe(true);
  });

  it("puts one oversized candidate in its own batch", () => {
    const batches = createReviewBatches(["short", "long", "last"], "tokenAware",
      candidate => candidate === "long" ? 6_000 : 100);

    expect(batches.map(batch => batch.items)).toEqual([["short"], ["long"], ["last"]]);
    expect(batches.map(batch => batch.estimatedCandidateTokens)).toEqual([100, 6_000, 100]);
  });

  it("rejects invalid token estimates", () => {
    expect(() => createReviewBatches([1], "tokenAware", () => -1)).toThrow(/Invalid/);
  });
});
