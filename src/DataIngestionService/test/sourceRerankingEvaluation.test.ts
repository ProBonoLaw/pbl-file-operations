import {Document} from "@langchain/core/documents";
import {describe, expect, it} from "vitest";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.ts";
import {evaluateRerankerThresholds, filterRerankedHits} from "../scripts/evaluate-source-reranking.mjs";

function fixture() {
  const primary = "Morgan scored 42.", support = "The report was signed on May 3.";
  const source = new EvidenceSource(new Document({pageContent: primary + "\n\n" + support,
    metadata: {accountId: "account", sourceId: "source", pages: [1]}}));
  const documents = ["Morgan recorded a score of 42.", "Morgan scored 42."].map(what => ({metadata: {
    accountId: "account", sourceId: "source", sourceContentHash: source.contentHash, what,
    sourceSpans: [{pageNumber: 1, sourceOffset: 0, sourceQuote: primary},
      {pageNumber: 1, sourceOffset: primary.length + 2, sourceQuote: support}],
  }}));
  const suite = {accountId: "account", sourceId: "source", sourceContentHash: source.contentHash,
    cases: [{id: "case-1", duplicate: true, documents}]};
  const queries = documents.map((document, i) => ({id: "case-1:" + (i === 0 ? "left" : "right"), text: document.metadata.what, vector: [1, 0]}));
  const hits = [
    {id: "primary", content: primary, rerankerScore: 2.4, searchScore: 0.02, contentOrigin: "extracted"},
    {id: "support", content: support, rerankerScore: 1.4, searchScore: 100, contentOrigin: "extracted"},
    {id: "generated", content: "A generated interpretation with no citation proof.", rerankerScore: 0.5, contentOrigin: "generated"},
  ].map(hit => ({...hit, sourceId: "source", tags: [], pages: [1],
    metadata: JSON.stringify({accountId: "account", sourceContentHash: source.contentHash})}));
  const results = queries.map(query => ({id: query.id, hits}));
  const evaluate = (thresholds = [1, 2, 2.5]) => evaluateRerankerThresholds(suite, source, queries, results, thresholds);
  return {source, suite, queries, hits, results, evaluate};
}

describe("offline source reranker calibration", () => {
  it("measures prompt savings and flags losses of primary and supporting quotations separately", () => {
    const {evaluate, hits} = fixture(), original = JSON.stringify(hits);
    const {summary} = evaluate(), [baseline, safe, supportLost, primaryLost] = summary.rows;
    expect(baseline).toMatchObject({keptHits: 6, rawPrimaryQuoteQueries: 2, suppliedPrimaryQuoteQueries: 2,
      suppliedSupportingQuotes: 2, passageCount: 4, unverifiedCount: 2});
    expect(safe).toMatchObject({keptHits: 4, lostRawPrimaryQueries: [], lostSuppliedPrimaryQueries: [],
      lostSuppliedSupportingQuotes: [], unverifiedCount: 0});
    expect(safe.contextTokens).toBeLessThan(baseline.contextTokens);
    expect(supportLost.lostSuppliedSupportingQuotes).toHaveLength(2);
    expect(supportLost.lostRawPrimaryQueries).toEqual([]);
    expect(primaryLost.lostSuppliedPrimaryQueries).toHaveLength(2);
    expect(primaryLost.emptyContextQueryIds).toHaveLength(2);
    expect(summary).toMatchObject({chatModelCalls: 0, newEmbeddingCalls: 0, missingRerankerScores: 0});
    expect(JSON.stringify(hits)).toBe(original);
  });

  it("keeps missing scores, treats zero as scored, and never substitutes the hybrid search score", () => {
    const hits = [{id: "missing", searchScore: 100}, {id: "zero", searchScore: 100, rerankerScore: 0},
      {id: "boundary", searchScore: 0.01, rerankerScore: 2}];
    expect(filterRerankedHits(hits, 2).map(hit => hit.id)).toEqual(["missing", "boundary"]);
    expect(filterRerankedHits(hits, 0)).toEqual(hits);
    expect(filterRerankedHits(hits, null)).toEqual(hits);
    const {evaluate, results} = fixture();
    delete results[0].hits[0].rerankerScore;
    expect(evaluate().summary.missingRerankerScores).toBe(2);
  });

  it.each([-1, 4.1, NaN, Infinity, "2"])("rejects invalid threshold %s", threshold => {
    expect(() => filterRerankedHits([], threshold)).toThrow("threshold");
  });

  it("requires complete, correctly associated query results and literal citations", () => {
    for (const scenario of ["missing", "query", "scope", "citation", "score"]) {
      const {evaluate, results, queries, suite} = fixture();
      if (scenario === "missing") results.pop();
      if (scenario === "query") queries[0].text = "An unrelated query";
      if (scenario === "scope") results[0].hits[0].sourceId = "other";
      if (scenario === "citation") suite.cases[0].documents[0].metadata.sourceSpans[0].sourceOffset = 1;
      if (scenario === "score") results[0].hits[0].rerankerScore = NaN;
      expect(evaluate).toThrow();
    }
  });

  it("does not confuse matching words at another occurrence with the supplied citation", () => {
    const {suite, queries, results} = fixture();
    const quote = suite.cases[0].documents[0].metadata.sourceSpans[0].sourceQuote;
    const source = new EvidenceSource(new Document({pageContent: quote + "\n\n" + quote,
      metadata: {accountId: "account", sourceId: "source", pages: [1]}}));
    suite.sourceContentHash = source.contentHash;
    for (const document of suite.cases[0].documents) {
      document.metadata.sourceContentHash = source.contentHash;
      document.metadata.sourceSpans = [{pageNumber: 1, sourceOffset: quote.length + 2, sourceQuote: quote}];
    }
    for (const result of results) {
      result.hits = [{...result.hits[0], metadata: JSON.stringify({accountId: "account", sourceContentHash: source.contentHash})}];
    }
    const {summary} = evaluateRerankerThresholds(suite, source, queries, results, [1]);
    expect(summary.rows[0]).toMatchObject({rawPrimaryQuoteQueries: 2, suppliedPrimaryQuoteQueries: 0});
  });
});
