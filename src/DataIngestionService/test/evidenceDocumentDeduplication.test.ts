import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { evidenceComparisonNumbers, findDocumentDuplicateCandidates } from "../src/processors/evidence/evidenceDocumentDeduplication.ts";
import { applyCanonicalizationDecisions, findCanonicalizationPairs } from "../src/processors/evidence/evidenceCanonicalization.ts";
import { deduplicateEvidenceDocuments } from "../src/processors/evidence/evidenceDeduplication.ts";
import { partitionIdentityDecisions } from "../src/processors/evidence/evidenceIdentityReview.ts";
import { evidenceComparisonText } from "../src/processors/evidence/evidencePageIdentity.ts";
import { eventCitationId, validateResolvedEventStructure } from "../src/processors/evidence/evidenceEventStructure.ts";

function fact(what: string, overrides: Record<string, unknown> = {}) {
  const sourceQuote = "Casey Morgan completed the reading assessment. The score was 110, at percentile 67.";
  return new Document({pageContent: what, metadata: {accountId: "account", sourceId: "source", sourceContentHash: "hash",
    what, who: ["Casey Morgan"], subject: ["Casey Morgan"], reportedBy: [], factType: "assessmentResult",
    where: "Unknown", why: "Unknown", tags: ["fact"], pages: [1], sourceQuote, sourceOffset: 0,
    sourceSpans: [{pageNumber: 1, sourceQuote, sourceOffset: 0}], ...overrides}});
}
function review(documents: Document[], relation: "same_assertion" | "independent_assertions" | "uncertain" = "same_assertion") {
  const pairs = findCanonicalizationPairs(documents);
  const assessments = partitionIdentityDecisions(pairs, pairs.map(pair => ({pairId: pair.id, relation,
    leftOnlyDetails: [], rightOnlyDetails: [], reason: "The cited source and all material fields were compared."})), documents);
  return applyCanonicalizationDecisions(documents, pairs, assessments.valid.flatMap(row => row.verdict === "duplicate" && row.survivor !== "none"
    ? [{...row, survivor: row.survivor}] : []));
}

describe("deeper document duplicate detection", () => {
  it("keeps lexical comparisons when Search returns no leads and rejects malformed lead indices", () => {
    const docs = [fact("Casey completed the assessment."), fact("The assessment was completed by Casey.")];
    expect(findDocumentDuplicateCandidates(docs, {searchPairs: []})).toEqual(findDocumentDuplicateCandidates(docs));
    for (const pair of [{leftIndex: 0, rightIndex: 0}, {leftIndex: -1, rightIndex: 1}, {leftIndex: 0, rightIndex: 2}])
      expect(() => findDocumentDuplicateCandidates(docs, {searchPairs: [pair]})).toThrow("indices");
  });

  it.each([{accountId: "other"}, {sourceId: "other"}, {sourceContentHash: "other"},
    {pages: [2], sourceSpans: [{pageNumber: 2, sourceOffset: 0, sourceQuote: "Other page"}], sourceQuote: "Other page"}])(
    "does not allow Search leads to bypass source scope: %j", change => {
      const docs = [fact("Casey completed the assessment."), fact("Casey completed the assessment.", change)];
      expect(findDocumentDuplicateCandidates(docs, {searchPairs: [{leftIndex: 0, rightIndex: 1}]})).toHaveLength(0);
    });

  it.each(["May 15th, 2025", "15th May 2025"])("reviews ordinal calendar date %s as the same full date", date => {
    const left = `Casey met on ${date}.`, right = "Casey met on 2025-05-15.";
    expect(evidenceComparisonText(left)).toBe(evidenceComparisonText(right));
    expect(evidenceComparisonNumbers(left)).toEqual(evidenceComparisonNumbers(right));
    const documents = [fact(left), fact(right)];
    expect(findCanonicalizationPairs(documents)).toHaveLength(1);
    expect(review(documents).documents).toHaveLength(1);
    expect(findCanonicalizationPairs([fact("Casey may meet on May 15th, 2025."), fact(right)])).toHaveLength(0);
  });

  it("retrieves reordered score wording and ordinal variants without a shared citation", () => {
    const documents = [fact("The assessment recorded Casey's reading score as 110, percentile 67."),
      fact("Reading score: 110; Casey: percentile 67th, recorded by the assessment.", {
        sourceOffset: 200, sourceQuote: "Reading: 110; percentile 67.",
        sourceSpans: [{pageNumber: 1, sourceOffset: 200, sourceQuote: "Reading: 110; percentile 67."}], tags: ["fact", "evidence:assessment"]})];
    const candidates = findDocumentDuplicateCandidates(documents);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].matchReasons).toContain("token_overlap");
    expect(candidates[0].matchReasons).not.toContain("phrase_overlap");
    const pairs = findCanonicalizationPairs(documents);
    expect(pairs).toHaveLength(1);
    expect(applyCanonicalizationDecisions(documents, pairs, []).documents).toHaveLength(2);
    expect(review(documents, "uncertain").documents).toHaveLength(2);
    const merged = review(documents).documents;
    expect(merged).toHaveLength(1);
    expect(merged[0].metadata.sourceSpans).toHaveLength(2);
    expect(merged[0].metadata.tags).toContain("evidence:assessment");
  });

  it("reviews paraphrases with shortened names and nested primary passages", () => {
    const full = fact("Casey Morgan completed the reading assessment.", {factType: "attribute"});
    const short = fact("The reading assessment was completed by Casey.", {factType: undefined,
      claimType: "factualAssertion", claimant: "Unknown", claimPolarity: "asserts", tags: ["claim"],
      who: ["Casey"], subject: ["Casey"], sourceQuote: "Casey Morgan completed the reading assessment.",
      sourceSpans: [{...full.metadata.sourceSpans[0], sourceQuote: "Casey Morgan completed the reading assessment."}]});
    const before = JSON.stringify([full, short]);
    expect(deduplicateEvidenceDocuments([full, short])).toHaveLength(2);
    const result = review([full, short]);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata).toMatchObject({factType: "attribute", tags: ["fact", "claim", "factType:attribute"]});
    expect(result.documents[0].metadata.who).toEqual(expect.arrayContaining(["Casey Morgan", "Casey"]));
    expect(result.documents[0].metadata.evidenceClassifications).toHaveLength(2);
    expect(JSON.stringify([full, short])).toBe(before);
  });

  it("allows omitted middle names only after review, preserving event roles and citations", () => {
    const event = (person: string, role = "subject") => {
      const doc = fact(`${person} completed the reading assessment.`, {factType: undefined,
        who: [person], subject: [person], eventType: "assessment", tags: ["event", "fact"]});
      doc.metadata.eventStructure = {version: 1, trigger: null, roles: [{role, participant: person,
        citationIds: [eventCitationId(doc.metadata.sourceSpans[0])]}]};
      return doc;
    };
    const documents = [event("Casey Morgan"), event("Casey Taylor Morgan")];
    expect(deduplicateEvidenceDocuments(documents)).toHaveLength(2);
    const result = review(documents);
    expect(result.documents).toHaveLength(1);
    const m = result.documents[0].metadata;
    expect(validateResolvedEventStructure(m.eventStructure, m.sourceSpans).roles.map(role => role.participant))
      .toEqual(expect.arrayContaining(["Casey Morgan", "Casey Taylor Morgan"]));
    expect(review([event("Casey Taylor Morgan"), event("Casey Jordan Morgan")]).documents).toHaveLength(2);
    expect(review([event("Casey Morgan", "sender"), event("Casey Taylor Morgan", "recipient")]).documents).toHaveLength(2);
  });

  it.each([
    {accountId: "other"}, {sourceId: "other"}, {sourceContentHash: "other"},
    {pages: [2, 1], sourceSpans: [{pageNumber: 2, sourceOffset: 0, sourceQuote: "Another occurrence."},
      {pageNumber: 1, sourceOffset: 0, sourceQuote: "A supporting citation."}], sourceQuote: "Another occurrence."},
  ])("does not let document scanning cross a primary scope boundary: %j", overrides => {
    expect(findDocumentDuplicateCandidates([fact("Casey completed the assessment."),
      fact("Casey completed the assessment.", overrides)])).toHaveLength(0);
  });

  it.each([
    ["Casey did not complete the assessment.", {}],
    ["Casey may complete the assessment.", {}],
    ["Casey completed the assessment.", {who: ["Jordan"], subject: ["Jordan"]}],
    ["Casey completed the assessment.", {whenStarted: {year: "2026"}}],
  ])("retains material contradictions even in a shared passage: %s", (what, overrides) => {
    const documents = [fact("Casey completed the assessment.", {whenStarted: {year: "2025"}}), fact(what, overrides)];
    expect(review(documents).documents).toHaveLength(2);
  });

  it("does not confuse negative and positive values, or discard decimal differences", () => {
    for (const other of ["5", "-5.1"]) {
      expect(findCanonicalizationPairs([fact("Casey's recorded balance is -5 dollars."),
        fact(`Casey's recorded balance is ${other} dollars.`)])).toHaveLength(0);
    }
  });

  it("cannot bridge different full names through aliases retained by a previous run", () => {
    const previous = fact("Casey completed the assessment.", {who: ["Casey", "Casey Morgan"], subject: ["Casey", "Casey Morgan"]});
    const other = fact("Casey completed the assessment.", {who: ["Casey Brown"], subject: ["Casey Brown"]});
    expect(findCanonicalizationPairs([previous, other])).toHaveLength(0);
    expect(review([previous, other]).documents).toHaveLength(2);
  });

  it("rejects a live-review false merge between an illustrative intervention and a specific recommendation", () => {
    const documents = [fact("Casey's interventions should continue in small-group settings or one-on-one, with reading support as one example."),
      fact("Casey should continue reading support as part of multiple interventions in small-group or one-on-one settings.")];
    const pairs = findCanonicalizationPairs(documents);
    expect(pairs).toHaveLength(1);
    expect(review(documents).documents).toHaveLength(2);
    // Direct callers cannot bypass validation with the saved erroneous verdict.
    expect(applyCanonicalizationDecisions(documents, pairs, [{pairId: pairs[0].id, survivor: "left",
      leftOnlyDetails: [], rightOnlyDetails: [], reason: "The reviewer incorrectly called this a change in emphasis."}]).documents).toHaveLength(2);
    expect(review([documents[0], new Document(documents[0])]).documents).toHaveLength(1);
  });

  it("keeps independent measures and parent reports despite matching numbers", () => {
    for (const [a, b] of [
      ["Mother's Social Cooperation score was 110.", "Father's Social Cooperation score was 110."],
      ["Casey's standard score was 67.", "Casey's percentile rank was 67."],
      ["Casey can begin a task.", "Casey can begin and end a task."],
    ]) expect(review([fact(a), fact(b)], "independent_assertions").documents).toHaveLength(2);
  });
});
