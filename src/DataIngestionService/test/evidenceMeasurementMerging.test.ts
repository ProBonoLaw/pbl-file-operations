import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { applyCanonicalizationDecisions, findCanonicalizationPairs } from "../src/processors/evidence/evidenceCanonicalization.ts";
import { partitionIdentityDecisions } from "../src/processors/evidence/evidenceIdentityReview.ts";
import { compatibleIdentityDetail } from "../src/processors/evidence/evidenceAtomicity.ts";

function record(what: string, quote = what, offset = 0, changes: Record<string, unknown> = {}) {
  return new Document({pageContent: what, metadata: {accountId: "account", sourceId: "report", sourceContentHash: "hash",
    what, who: ["Casey"], subject: ["Casey"], reportedBy: [], factType: "assessmentResult", tags: ["fact"],
    where: "Unknown", why: "Unknown", pages: [5], sourceQuote: quote, sourceOffset: offset,
    sourceSpans: [{pageNumber: 5, sourceQuote: quote, sourceOffset: offset}], ...changes}});
}

function review(documents: Document[], details: string[], reverse = false, relation = "same_assertion") {
  const docs = reverse ? [...documents].reverse() : documents;
  const pairs = findCanonicalizationPairs(docs, {vectors: [[1, 0], [1, 0]]});
  expect(pairs).toHaveLength(1);
  const richer = pairs[0].leftIndex === (reverse ? 0 : 1) ? "left" : "right";
  const assessment = {pairId: pairs[0].id, relation, leftOnlyDetails: richer === "left" ? details : [], rightOnlyDetails: richer === "right" ? details : [],
    reason: "Same assessment result; retain its measurement qualifiers.", semanticAssessment: {
      relationship: richer === "left" ? "left_entails_right" : "right_entails_left", contextualDetails: []}};
  const partition = partitionIdentityDecisions(pairs, [assessment], docs);
  expect([...partition.errors]).toEqual([]);
  const decisions = partition.valid.flatMap(row => row.verdict === "duplicate" && row.survivor !== "none" ? [{...row, survivor: row.survivor}] : []);
  return {docs, pairs, assessment, partition, richer, ...applyCanonicalizationDecisions(docs, pairs, decisions)};
}

const scores = (type = "scaled") => [
  record("On the WPPSI-IV, Casey's Similarities subtest score was 15.", "| Similarities | 15 |"),
  record(`Casey's WPPSI-IV Similarities ${type} score was 15.`, "| Similarities | 15 |", 0, {tags: ["fact", "evidence:score"]}),
];
const populationDetail = "compared with children his age";
const populations = () => [
  record("On the WPPSI-IV, Casey's Full Scale IQ score was 120 (Superior), at the 91st percentile.",
    "| Full Scale IQ | 120 | 91 | Superior |"),
  record(`Casey's WPPSI-IV Full Scale IQ was 120, at the 91st percentile and in the Superior range ${populationDetail}.`,
    "Casey's FSIQ was in the Superior range when compared to other children his age (FSIQ = 120) and at the 91st percentile.", 200),
];

describe("measurement specificity on the same evidence result", () => {
  it.each(["scaled", "scaled score", "scaled score was 15", "standard", "raw", "T"])(
    "recognizes %s in the complete score phrase and retains the richer statement in either order", detail => {
      const docs = scores(detail.split(" ")[0]);
      for (const reverse of [false, true]) {
        const result = review(docs, [detail], reverse);
        expect(result.documents).toHaveLength(1);
        expect(result.documents[0].metadata.what).toBe(docs[1].metadata.what);
        expect(result.documents[0].metadata.tags).toContain("evidence:score");
        expect(result.documents[0].metadata.evidenceClassifications).toEqual([{kind: "fact", type: "assessmentResult"}]);
      }
    });

  it.each([populationDetail, "children his age"])("retains cited comparison population %s across table and narrative", detail => {
    const docs = populations();
    for (const reverse of [false, true]) {
      const result = review(docs, [detail], reverse);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.what).toBe(docs[1].metadata.what);
      expect(result.documents[0].metadata.sourceSpans).toEqual(expect.arrayContaining(docs.flatMap(doc => doc.metadata.sourceSpans)));
    }
  });

  it("allows a fuller claim representation to retain the assessment's score qualifier", () => {
    const docs = scores();
    Object.assign(docs[1].metadata, {factType: undefined, claimType: "factualAssertion", claimant: "Unknown", claimPolarity: "asserts", tags: ["claim"]});
    const result = review(docs, ["scaled"]);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata).toMatchObject({what: docs[1].metadata.what, factType: "assessmentResult",
      tags: expect.arrayContaining(["claim", "fact"])});
  });

  it.each([scores, populations])("never drops a measurement qualifier even with empty inventories", fixture => {
    const docs = fixture();
    for (const reverse of [false, true]) {
      const result = review(docs, [], reverse);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.what).toBe(docs[1].metadata.what);
      expect(applyCanonicalizationDecisions(result.docs, result.pairs,
        [{...result.assessment, survivor: result.richer === "left" ? "right" : "left"}]).applied).toHaveLength(0);
    }
  });

  it.each([
    ["Casey's Similarities raw score was 15.", "Casey's Similarities scaled score was 15."],
    ["Casey's Full Scale IQ was 120 compared with older children.", "Casey's Full Scale IQ was 120 compared with children his age."],
  ])("preserves conflicting measurement qualifiers despite empty inventories: %s", (left, right) => {
    for (const reverse of [false, true]) {
      const result = review([record(left), record(right)], [], reverse);
      expect(result.documents).toHaveLength(2);
      for (const survivor of ["left", "right"] as const)
        expect(applyCanonicalizationDecisions(result.docs, result.pairs, [{...result.assessment, survivor}]).applied).toHaveLength(0);
    }
  });

  it.each(["The score was Superior.", "Compared with adults his age.", "Compared with children his age and diagnosed with dyslexia."])(
    "requires the comparison population in the primary result citation: %s", quote => {
      const docs = populations();
      docs[1] = record(docs[1].metadata.what, quote, 200);
      const result = review(docs, [populationDetail]);
      expect(result.documents).toHaveLength(2);
      expect(applyCanonicalizationDecisions(docs, result.pairs, [{...result.assessment, survivor: "right"}]).applied).toHaveLength(0);
    });

  it("does not borrow a population comparison from an unrelated supporting citation", () => {
    const docs = populations(), supported = docs[1].metadata.sourceSpans[0];
    docs[1] = record(docs[1].metadata.what, "Full Scale IQ was 120.", 200);
    docs[1].metadata.sourceSpans.push({...supported, sourceOffset: 500});
    expect(review(docs, [populationDetail]).documents).toHaveLength(2);
  });

  it("does not turn an adjective on another action into a score type", () => {
    const docs = [record("Casey's score was 15."), record("Casey scaled a wall; his score was 15.")];
    expect(compatibleIdentityDetail("scaled", docs[1].metadata, docs[0].metadata)).toBe(false);
    expect(review(docs, ["scaled"]).documents).toHaveLength(2);
  });

  it("does not authorize added outcomes inside a population detail", () => {
    const docs = populations();
    const detail = populationDetail + " and qualified for services";
    docs[1] = record(docs[1].metadata.what.replace(populationDetail, detail));
    expect(review(docs, [detail]).documents).toHaveLength(2);
  });

  it("still requires semantic identity of the same measure and occasion", () => {
    const docs = scores();
    docs[1].metadata.what = docs[1].metadata.what.replace("Similarities", "Information");
    expect(review(docs, ["scaled"], false, "independent_assertions").documents).toHaveLength(2);
  });

  it.each([{accountId: "other"}, {sourceId: "other"}, {sourceContentHash: "other"}, {factType: "attribute"},
    {pages: [6], sourceSpans: [{pageNumber: 6, sourceOffset: 0, sourceQuote: "| Similarities | 15 |"}]}])(
    "does not broaden qualifier permission outside assessment scope: %j", change => {
      const docs = scores();
      if (change.factType) docs[0].metadata.factType = change.factType;
      Object.assign(docs[1].metadata, change);
      expect(compatibleIdentityDetail("scaled", docs[1].metadata, docs[0].metadata)).toBe(false);
    });
});
