import {Document} from "@langchain/core/documents";
import {describe, expect, it} from "vitest";
import {statementDetailLosses} from "../src/processors/evidence/evidenceAtomicity.ts";
import {containsCondition} from "../src/processors/evidence/evidenceConditionComparison.ts";
import {reviewedStatementDetailLosses, type SemanticAssessment} from "../src/processors/evidence/evidenceSemanticReview.ts";
import {partitionIdentityDecisions} from "../src/processors/evidence/evidenceIdentityReview.ts";
import {applyCanonicalizationDecisions, findCanonicalizationPairs, type CanonicalizationPair} from "../src/processors/evidence/evidenceCanonicalization.ts";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.ts";
import {formatEvidenceContent} from "../src/processors/evidence/evidenceContent.ts";

const condition = "If the applicant served a proposed plan with the notice, and if no objection is filed within 30 days after the notice was served (or if the parties agree):";
const consequence = "Both parties may follow that plan.";
const passive = "If a proposed plan is served with the notice and no objection is filed within 30 days after the notice was served (or if the parties agree), both parties may follow that plan.";
const active = "If the applicant served a proposed plan with the notice and no objection is filed within 30 days after the notice was served, or if the parties agree, both parties may follow that plan.";
const semanticAssessment: SemanticAssessment = {relationship:"equivalent", contextualDetails:[]};

function fixture(statements = [passive, active], sourceCondition = condition) {
  const source = new EvidenceSource(new Document({pageContent:sourceCondition + "\n\n" + consequence,
    metadata:{sourceId:"source", pages:[1]}}));
  const primary = {pageNumber:1, sourceOffset:sourceCondition.length + 2, sourceQuote:consequence};
  const documents = statements.map((what, index) => {
    const metadata = {what, who:["Applicant", "Other party"], subject:["Applicant", "Other party"],
      factType:"condition", tags:["fact"], where:"Unknown", why:"Unknown",
      accountId:"account", sourceId:"source", sourceContentHash:source.contentHash,
      pages:[1], sourceOffset:primary.sourceOffset, sourceQuote:primary.sourceQuote,
      sourceSpans:[primary, {pageNumber:1, sourceOffset:0, sourceQuote:sourceCondition}], extractedBy:[`extractor-${index}`]};
    return new Document({metadata, pageContent:formatEvidenceContent(metadata)});
  });
  const pair: CanonicalizationPair = {id:"0:1", leftIndex:0, rightIndex:1, similarity:1, allowedSurvivors:["right"]};
  const review = {pairId:pair.id, relation:"same_assertion" as const, leftOnlyDetails:[], rightOnlyDetails:[],
    reason:"Same source-supported condition and permission.", semanticAssessment};
  return {source, documents, pair, review};
}

describe("English conditions in evidence identity", () => {
  it.each([
    ["If consent is recorded (or the parties agree), proceed.", "If consent is recorded, or the parties agree, proceed."],
    ["If consent is not recorded, retain the record.", "If consent is (not) recorded, retain the record."],
  ])("compares punctuation without deleting any parenthetical content: %s", (left, right) => {
    expect(containsCondition(right, left)).toBe(true);
    expect(containsCondition(left, right)).toBe(true);
  });

  it.each([
    ["If consent is recorded or the parties agree", "If consent is recorded"],
    ["If consent is not recorded", "If consent is recorded"],
    ["If consent is recorded and the parties agree", "If consent is recorded or the parties agree"],
    ["If no objection arrives within 30 days", "If no objection arrives within 60 days"],
    ["If the score is > 30", "If the score is < 30"],
    ["If the value is -30", "If the value is +30"],
    ["If the value is 30.5", "If the value is 30.6"],
  ])("preserves the actual words of prerequisites: %s", (original, kept) => {
    expect(containsCondition(kept, original)).toBe(false);
  });

  it.each([false, true])("merges the source-supported active/passive rule and retains the explicit actor (reversed: %s)", reversed => {
    const f = fixture(reversed ? [active, passive] : [passive, active]);
    const pairs = findCanonicalizationPairs(f.documents, {source:f.source});
    expect(pairs).toHaveLength(1);
    const review = partitionIdentityDecisions(pairs, [f.review], f.documents, f.source);
    expect(review.errors.size).toBe(0);
    const survivor = reversed ? "left" : "right";
    expect(review.valid[0]).toMatchObject({verdict:"duplicate", survivor});
    const result = applyCanonicalizationDecisions(f.documents, pairs, [{...f.review, survivor}], f.source);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.what).toBe(active);
    expect(result.documents[0].metadata.sourceSpans).toEqual(f.documents[0].metadata.sourceSpans);
    expect(result.documents[0].metadata.extractedBy.toSorted()).toEqual(["extractor-0", "extractor-1"]);
  });

  it.each([
    ["If the form is signed, proceed.", "If Casey signed the form, proceed.", "If Casey signed the form:"],
    ["Unless the letter is sent, wait.", "Unless Dana sent the letter, wait.", "Unless Dana sent the letter:"],
    ["Only when the request is approved, proceed.", "Only when the board approved the request, proceed.", "Only when the board approved the request:"],
  ])("recognizes other source-verified passive conditions: %s", (passive, active, sourceCondition) => {
    const f = fixture([passive, active], sourceCondition);
    expect(reviewedStatementDetailLosses(f.documents[1].metadata, f.documents[0].metadata, semanticAssessment, f.source)).toEqual([]);
  });

  it.each([
    active.replace("the applicant served", "the respondent served"),
    active.replace("30 days", "60 days"),
    active.replace("no objection", "an objection"),
    active.replace("notice and no objection", "notice or no objection"),
    active.replace("or if the parties agree", "and if the parties agree"),
    active.replace(", or if the parties agree", ""),
    active.replace(" and no objection is filed within 30 days after the notice was served", ""),
    active.replace("with the notice and", "with the notice after court approval and"),
    active.replace("the applicant served", "the applicant may have served"),
  ])("rejects a changed actor, prerequisite, deadline, alternative or modality despite a model approval: %s", changed => {
    const f = fixture([passive, changed]);
    expect(reviewedStatementDetailLosses(f.documents[1].metadata, f.documents[0].metadata, semanticAssessment, f.source).length).toBeGreaterThan(0);
    expect(partitionIdentityDecisions([f.pair], [f.review], f.documents, f.source).valid[0]).toMatchObject({verdict:"distinct", survivor:"none"});
    expect(applyCanonicalizationDecisions(f.documents, [f.pair], [{...f.review, survivor:"right"}], f.source).applied).toEqual([]);
  });

  it("does not discard an explicitly named actor in the passive statement", () => {
    const f = fixture([passive.replace("is served with", "is served by the respondent with"), active]);
    expect(reviewedStatementDetailLosses(f.documents[1].metadata, f.documents[0].metadata, semanticAssessment, f.source).length).toBeGreaterThan(0);
  });

  it.each([
    "If the form is signed:",
    "If Dana signed the form:",
    "If Casey or Dana signed the form:",
    "If Casey signed the form or Dana signed the form:",
  ])("does not infer a specific actor from an unspecified, different or alternative source actor: %s", sourceCondition => {
    const f = fixture(["If the form is signed, proceed.", "If Casey signed the form, proceed."], sourceCondition);
    expect(reviewedStatementDetailLosses(f.documents[1].metadata, f.documents[0].metadata, semanticAssessment, f.source).length).toBeGreaterThan(0);
    expect(partitionIdentityDecisions([f.pair], [f.review], f.documents, f.source).valid[0].verdict).toBe("distinct");
    expect(applyCanonicalizationDecisions(f.documents, [f.pair], [{...f.review, survivor:"right"}], f.source).applied).toEqual([]);
  });

  it.each(["missing context", "invalid context offset", "invalid primary offset", "different source", "different occurrence"])(
    "requires the same literal occurrence and a valid source condition: %s", failure => {
      const f = fixture();
      const kept = f.documents[1].metadata;
      if (failure === "missing context") kept.sourceSpans.pop();
      if (failure === "invalid context offset") kept.sourceSpans[1].sourceOffset++;
      if (failure === "invalid primary offset") {kept.sourceSpans = structuredClone(kept.sourceSpans);kept.sourceSpans[0].sourceOffset++;kept.sourceOffset++;}
      if (failure === "different source") kept.sourceContentHash = "other";
      if (failure === "different occurrence") {kept.sourceSpans = structuredClone(kept.sourceSpans);kept.sourceSpans[0].pageNumber = 2;kept.pages = [2];}
      expect(reviewedStatementDetailLosses(kept, f.documents[0].metadata, semanticAssessment, f.source).length).toBeGreaterThan(0);
    });

  it.each([undefined, "contradictory", "related", "uncertain"] as const)("does not enable voice paraphrases with assessment %s", relationship => {
    const f = fixture();
    const assessment = relationship ? {relationship, contextualDetails:[]} : undefined;
    expect(reviewedStatementDetailLosses(f.documents[1].metadata, f.documents[0].metadata, assessment, f.source).length).toBeGreaterThan(0);
  });

  it("requires the source and retains a non-equivalent model judgment", () => {
    const f = fixture();
    expect(reviewedStatementDetailLosses(f.documents[1].metadata, f.documents[0].metadata, semanticAssessment).length).toBeGreaterThan(0);
    const distinct = {...f.review, relation:"independent_assertions"};
    expect(partitionIdentityDecisions([f.pair], [distinct], f.documents, f.source).valid[0].verdict).toBe("distinct");
    expect(applyCanonicalizationDecisions(f.documents, [f.pair], [{...distinct, survivor:"right"}], f.source).applied).toEqual([]);
  });
});

describe("conditions continued after a comma", () => {
  it.each([
    ["If the form is late, and the fee is unpaid, the claim is denied.", "If the form is late, and the notice is unpaid, the claim is denied."],
    ["If the form is late, or the fee is unpaid, the claim is denied.", "If the form is late, the claim is denied."],
    ["Unless the form is late, or the fee is unpaid, the claim is approved.", "Unless the form is late, the claim is approved."],
    ["If the form is late, and if the fee is unpaid, the claim is denied.", "If the form is late, and if the notice is unpaid, the claim is denied."],
  ])("reports the full changed prerequisite: %s", (removed, survivor) => {
    expect(statementDetailLosses({what: survivor}, {what: removed})).toEqual([removed.slice(0, removed.lastIndexOf(","))]);
  });

  it("keeps a continued condition and a trailing consequence from being reported", () => {
    const what = "If the form is late, and the fee is unpaid, the claim is denied.";
    expect(statementDetailLosses({what}, {what})).toEqual([]);
    expect(statementDetailLosses({what: "If the form is late and the fee is unpaid, the claim is denied."}, {what})).toEqual([]);
  });
});
