import {Document} from "@langchain/core/documents";
import {describe, expect, it} from "vitest";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.ts";
import {gradeReconciliationCases, validateReconciliationSuite} from "../scripts/benchmark-source-reconciliation.mjs";

describe("controlled source reconciliation comparison", () => {
  it("counts unresolved duplicates and false merges independently of model claims", () => {
    const result = gradeReconciliationCases([{id: "duplicate", duplicate: true}, {id: "distinct", duplicate: false},
      {id: "missing-review", duplicate: true}], {applied: [{pairId: "0:1"}, {pairId: "2:3"}],
      reviewDecisions: [{pairId: "0:1"}, {pairId: "2:3"}]});
    expect(result).toMatchObject({cases: 3, expectedDuplicates: 2, duplicatesRemoved: 1,
      remainingDuplicates: 1, falseMerges: 1, unreviewed: 1});
  });

  it("rejects unsupported citations, mixed scopes and overlapping case pages before paid review", () => {
    const source = new EvidenceSource(new Document({pageContent: "A supported statement.", metadata: {sourceId: "source"}}));
    const document = {pageContent: "Evidence", metadata: {accountId: "account", sourceId: "source", sourceContentHash: source.contentHash,
      sourceSpans: [{pageNumber: 1, sourceOffset: 0, sourceQuote: "A supported statement."}]}};
    const suite = {accountId: "account", sourceId: "source", sourceContentHash: source.contentHash,
      cases: [{id: "case", duplicate: true, rationale: "Same assertion", documents: [document, structuredClone(document)]}]};
    expect(() => validateReconciliationSuite(suite, source)).not.toThrow();
    for (const scenario of ["scope", "quote", "page", "missing-label"]) {
      const invalid = structuredClone(suite);
      if (scenario === "scope") invalid.cases[0].documents[0].metadata.accountId = "other";
      if (scenario === "quote") invalid.cases[0].documents[0].metadata.sourceSpans[0].sourceOffset = 1;
      if (scenario === "page") invalid.cases.push({...invalid.cases[0], id: "second"});
      if (scenario === "missing-label") delete (invalid.cases[0] as any).duplicate;
      expect(() => validateReconciliationSuite(invalid, source)).toThrow();
    }
  });
});
