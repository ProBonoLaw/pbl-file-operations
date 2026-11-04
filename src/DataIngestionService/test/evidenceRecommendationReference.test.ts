import {Document} from "@langchain/core/documents";
import {describe, expect, it} from "vitest";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.ts";
import {findCanonicalizationPairs, applyCanonicalizationDecisions} from "../src/processors/evidence/evidenceCanonicalization.ts";
import {partitionIdentityDecisions} from "../src/processors/evidence/evidenceIdentityReview.ts";
import {recommendationReferenceSide, reviewableRecommendationReference} from "../src/processors/evidence/evidenceRecommendationReference.ts";

function fixture(recommendation = "It is recommended that Casey's parents receive parent training.") {
  const sentence = "Parent training will focus on fostering a sense of family through family meetings.";
  const text = recommendation + " " + sentence;
  const source = new EvidenceSource(new Document({pageContent:text,metadata:{pages:[1]}}));
  const span = (sourceQuote:string) => ({pageNumber:1,sourceOffset:text.indexOf(sourceQuote),sourceQuote});
  const short = "Jordan Lane states that parent training for Casey’s parents will focus on fostering a sense of family through family meetings.";
  const full = "Jordan Lane states that the recommended parent training for Casey's parents will focus on fostering a sense of family through family meetings.";
  const docs = [short,full].map((what,index) => {
    const primary = span(index ? "fostering a sense of family through family meetings." : "a sense of family through family meetings.");
    return new Document({pageContent:what,metadata:{what,accountId:"account",sourceId:"report",sourceContentHash:source.contentHash,
      claimant:"Jordan Lane",claimType:"opinion",claimPolarity:"asserts",who:["Casey's parents"],where:"Unknown",why:"Unknown",
      tags:["claim",index ? "topic:family" : "topic:training"],pages:[1],sourceQuote:primary.sourceQuote,sourceOffset:primary.sourceOffset,
      sourceSpans:[primary,span(index ? recommendation : text)]}});
  });
  return {source,docs,recommendation};
}

describe("recommended as a source-supported reference modifier", () => {
  it.each([false,true])("reviews nested citations and keeps the explicit qualifier in either order (reverse=%s)", reverse => {
    const {source,docs,recommendation} = fixture();
    const fuller = docs[1].metadata.what, citations = docs.flatMap(d => d.metadata.sourceSpans);
    if (reverse) docs.reverse();
    const pairs = findCanonicalizationPairs(docs,{source});
    const side = docs[pairs[0].leftIndex].metadata.what === fuller ? "left" : "right";
    expect(pairs).toHaveLength(1); expect(pairs[0].allowedSurvivors).toEqual([side]);
    expect(applyCanonicalizationDecisions(docs,pairs,[],source).applied).toEqual([]);
    for (const inventory of [false,true]) {
      const assessment = {pairId:pairs[0].id,relation:"same_assertion",reason:"The source identifies the same recommended training.",
        leftOnlyDetails:inventory && side === "left" ? ["recommended"] : [],rightOnlyDetails:inventory && side === "right" ? ["recommended"] : [],
        semanticAssessment:{relationship:inventory ? side === "left" ? "left_entails_right" : "right_entails_left" : "equivalent",
          contextualDetails:inventory ? [{side,detail:"recommended",kind:"reference",sourceQuote:recommendation,
            explanation:"Identifies the training already recommended in both records' source context."}] : []}};
      const reviewed = partitionIdentityDecisions(pairs,[assessment],docs,source);
      expect(reviewed.valid[0]).toMatchObject({verdict:"duplicate",survivor:side});
      const decisions = reviewed.valid.flatMap(d => d.survivor === "none" ? [] : [{...d,survivor:d.survivor}]);
      const result = applyCanonicalizationDecisions(docs,pairs,decisions,source);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.what).toBe(fuller);
      expect(result.documents[0].metadata.sourceSpans).toEqual(expect.arrayContaining(citations));
      expect(result.documents[0].metadata.tags).toEqual(expect.arrayContaining(["claim","topic:family","topic:training"]));
      expect(applyCanonicalizationDecisions(docs,pairs,[{...decisions[0],survivor:side === "left" ? "right" : "left"}],source).applied).toEqual([]);
    }
  });

  it.each(["The training will focus on communication.","Training will focus on communication."])(
    "recognizes the noun reference independently of a particular training topic: %s", what => {
      expect(recommendationReferenceSide({what:"The recommended training will focus on communication."},{what})).toBe("left");
    });

  it.each([
    ["Jordan recommended training.","Jordan provided training."],
    ["Training was recommended.","Training was completed."],
    ["The recommended training should cover communication.","Training will cover communication."],
    ["The recommended training will not cover communication.","Training will cover communication."],
    ["The recommended training will cover communication.","Training will cover discipline."],
    ["The recommended training will cover communication.","Training will cover communication and resolve conflict."],
  ])("does not erase a different action, modality or focus: %s", (left,right) => {
    expect(recommendationReferenceSide({what:left},{what:right})).toBeNull();
    const {source,docs} = fixture();docs[0].metadata.what = left;docs[1].metadata.what = right;
    expect(reviewableRecommendationReference(docs[0].metadata,docs[1].metadata,source)).toBe(false);
  });

  it.each(["missing source","changed source","one-sided support","unrecommended source","different account","different claimant"])(
    "does not allow unsupported or incompatible reference context: %s", variant => {
      const {source,docs} = fixture(variant === "unrecommended source" ? "This section describes parent training." : undefined);
      if (variant === "changed source") docs[0].metadata.sourceContentHash = "other";
      if (variant === "one-sided support") docs[0].metadata.sourceSpans.pop();
      if (variant === "different account") docs[0].metadata.accountId = "other";
      if (variant === "different claimant") docs[0].metadata.claimant = "Another clinician";
      const pairs = findCanonicalizationPairs(docs,variant === "missing source" ? {} : {source});
      if (variant === "different claimant") {
        expect(pairs[0].metadataReview?.fields).toContain("claimant");
        expect(applyCanonicalizationDecisions(docs,pairs,[{pairId:pairs[0].id,survivor:"left",relation:"same_assertion",
          leftOnlyDetails:[],rightOnlyDetails:[],reason:"Same reference, but unresolved claimant.",
          semanticAssessment:{relationship:"equivalent",contextualDetails:[]}}],source).applied).toEqual([]);
      } else expect(pairs).toEqual([]);
    });

  it.each(["independent_assertions","uncertain"])("requires semantic identity despite shared recommendation support: %s", relation => {
    const {source,docs} = fixture(),pairs = findCanonicalizationPairs(docs,{source});
    const result = partitionIdentityDecisions(pairs,[{pairId:pairs[0].id,relation,leftOnlyDetails:[],rightOnlyDetails:[],reason:"Identity was not established."}],docs,source);
    expect(result.valid[0].verdict).not.toBe("duplicate");
  });

  it("requires modern semantic assessment and rechecks the source when applying a saved approval", () => {
    const {source,docs} = fixture(),pairs = findCanonicalizationPairs(docs,{source});
    const decision = {pairId:pairs[0].id,relation:"same_assertion",survivor:pairs[0].allowedSurvivors[0],leftOnlyDetails:[],rightOnlyDetails:[],reason:"Same reference."};
    expect(partitionIdentityDecisions(pairs,[decision],docs,source).valid[0].verdict).toBe("distinct");
    expect(applyCanonicalizationDecisions(docs,pairs,[decision],source).applied).toEqual([]);
    const semantic = {...decision,semanticAssessment:{relationship:"equivalent" as const,contextualDetails:[]}};
    expect(applyCanonicalizationDecisions(docs,pairs,[semantic],source).applied).toHaveLength(1);
    expect(applyCanonicalizationDecisions(docs,pairs,[semantic]).applied).toEqual([]);
    docs[0].metadata.sourceSpans[1].sourceOffset++;
    expect(applyCanonicalizationDecisions(docs,pairs,[semantic],source).applied).toEqual([]);
  });
});
