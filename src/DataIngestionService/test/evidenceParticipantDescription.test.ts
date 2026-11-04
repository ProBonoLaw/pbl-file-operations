import {Document} from "@langchain/core/documents";
import {describe,expect,it} from "vitest";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.ts";
import {applyCanonicalizationDecisions,findCanonicalizationPairs} from "../src/processors/evidence/evidenceCanonicalization.ts";
import {partitionIdentityDecisions} from "../src/processors/evidence/evidenceIdentityReview.ts";

const header = "**Client:** Alex Casey Morgan\n**Examiner:** Jordan Lane, Ph.D.";
function fixture(descriptor = "boy", age = "five") {
  const quote = `Alex Casey Morgan is a ${age} year old ${descriptor}.`;
  const source = new EvidenceSource(new Document({pageContent:header + "<!-- PageBreak -->" + quote,metadata:{pages:[1,2]}}));
  const primary = {pageNumber:2,sourceOffset:0,sourceQuote:quote};
  const supporting = {pageNumber:1,sourceOffset:0,sourceQuote:header};
  const docs = [`Casey was described as a ${age}-year-old ${descriptor}.`,`Alex Casey Morgan is ${age} years old.`]
    .map((what,index) => new Document({pageContent:what,metadata:{what,accountId:"account",sourceId:"report",
      sourceContentHash:source.contentHash,who:index ? ["Alex Casey Morgan"] : ["Casey","Jordan Lane, Ph.D."],
      subject:index ? ["Alex Casey Morgan"] : ["Casey"],reportedBy:index ? [] : ["Jordan Lane, Ph.D."],
      factType:"attribute",tags:["fact",`facet:demographic${index}`],where:"Unknown",why:"Unknown",asOf:null,
      pages:index ? [2] : [2,1],sourceQuote:quote,sourceOffset:0,sourceSpans:index ? [primary] : [primary,supporting]}}));
  return {source,docs,quote};
}
function prepare(descriptor = "boy", reverse = false, age = "five") {
  const {source,docs,quote} = fixture(descriptor,age), richer = docs[0];
  if (reverse) docs.reverse();
  const pairs = findCanonicalizationPairs(docs,{source});
  expect(pairs).toHaveLength(1);
  const side = reverse ? "right" : "left";
  const rows = pairs.map(pair => {
    const contextIndex = pair.metadataReview!.documentContext.findIndex(span=>span.sourceQuote.includes("**Client:**"));
    expect(contextIndex).toBeGreaterThanOrEqual(0);
    return {pairId:pair.id,relation:"same_assertion",leftOnlyDetails:reverse ? [] : [descriptor],
      rightOnlyDetails:reverse ? [descriptor] : [],reason:"Same client and age observation; preserve the explicitly sourced description.",
      semanticAssessment:{relationship:reverse ? "right_entails_left" : "left_entails_right",contextualDetails:[{
        side,detail:descriptor,kind:"participant_description",sourceQuote:quote,
        explanation:"The descriptor identifies the same source-described client in the same age observation; it is not a separate occurrence or action."}]},
      metadataResolutions:pair.metadataReview!.fields.map(field=>({field,
        explanation:"Casey is the client's familiar name; Alex Casey Morgan is the full name. Jordan Lane is the examiner/report author, not another client.",
        citations:[{side:"left",citationIndex:0,sourceQuote:quote},{side:"right",citationIndex:0,sourceQuote:quote},
          {side:"document",citationIndex:contextIndex,sourceQuote:header}]}))};
  });
  return {source,docs,pairs,rows,richer,side};
}
function run(fixture: ReturnType<typeof prepare>) {
  const {source,docs,pairs,rows} = fixture;
  const partition = partitionIdentityDecisions(pairs,rows,docs,source);
  const decisions = partition.valid.flatMap(row=>row.survivor === "none" ? [] : [{...row,survivor:row.survivor}]);
  return {partition,decisions,...applyCanonicalizationDecisions(docs,pairs,decisions,source)};
}

describe("supported descriptions of an already resolved participant", () => {
  it.each(["boy","girl","child","left-handed child"])("retains the sourced descriptor %s in either input order", descriptor => {
    for (const reverse of [false,true]) {
      const fixture = prepare(descriptor,reverse), result = run(fixture);
      expect(result.partition.errors.size).toBe(0);
      expect(result.partition.valid[0]).toMatchObject({verdict:"duplicate",survivor:fixture.side});
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.what).toBe(fixture.richer.metadata.what);
      expect(result.documents[0].metadata.who).toEqual(expect.arrayContaining(["Casey","Alex Casey Morgan","Jordan Lane, Ph.D."]));
      expect(result.documents[0].metadata.tags).toEqual(expect.arrayContaining(["fact","facet:demographic0","facet:demographic1"]));
      expect(result.documents[0].metadata.sourceSpans).toEqual(expect.arrayContaining(fixture.docs.flatMap(d=>d.metadata.sourceSpans)));
      expect(result.documents[0].metadata.reportedBy).toContain("Jordan Lane, Ph.D.");
      expect(result.documents[0].metadata.metadataResolutions).toHaveLength(1);
    }
  });

  it("requires source-supported context even when identity resolutions succeed", () => {
    const fixture = prepare();
    fixture.rows[0].semanticAssessment.contextualDetails = [];
    const result = run(fixture);
    expect(result.documents).toHaveLength(2);
    expect(result.partition.valid[0].reason).toContain("unrecognized enrichment");
  });

  it("accepts a hyphenated age-description inventory against the exact unhyphenated source excerpt", () => {
    const fixture = prepare();
    fixture.rows[0].leftOnlyDetails = ["five-year-old boy"];
    fixture.rows[0].semanticAssessment.contextualDetails[0].detail = "five-year-old boy";
    const result = run(fixture);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.what).toBe(fixture.richer.metadata.what);
    expect(result.decisions[0].leftOnlyDetails).toEqual(["five-year-old boy"]);
  });

  it.each(["header only","invented quote","substring only","empty explanation","wrong side"])(
    "rejects invalid description support: %s", variant => {
      const fixture = prepare(), context = fixture.rows[0].semanticAssessment.contextualDetails[0];
      if (variant === "header only") context.sourceQuote = header;
      if (variant === "invented quote") context.sourceQuote = "A doctor described Casey as a boy.";
      if (variant === "substring only") {
        const quote = "Casey's boyfriend completed the form.";
        fixture.docs[0].metadata.sourceSpans.push({pageNumber:2,sourceOffset:100,sourceQuote:quote});
        context.sourceQuote = quote;
      }
      if (variant === "empty explanation") context.explanation = "";
      if (variant === "wrong side") context.side = "right";
      expect(run(fixture).documents).toHaveLength(2);
    });

  it("does not accept the description as a substitute for identity resolution", () => {
    const fixture = prepare();
    fixture.rows[0].metadataResolutions = [];
    expect(run(fixture).documents).toHaveLength(2);
  });

  it("does not drop the descriptor when applying a saved decision in the wrong direction", () => {
    const fixture = prepare(), result = run(fixture);
    expect(result.decisions).toHaveLength(1);
    expect(applyCanonicalizationDecisions(fixture.docs,fixture.pairs,
      [{...result.decisions[0],survivor:"right"}],fixture.source).applied).toEqual([]);
  });

  it("revalidates the supporting description when applying saved decisions", () => {
    const fixture = prepare(), result = run(fixture), decision = result.decisions[0];
    const changed = {...decision,semanticAssessment:{...decision.semanticAssessment!,contextualDetails:
      decision.semanticAssessment!.contextualDetails.map(context=>({...context,sourceQuote:header}))}};
    expect(applyCanonicalizationDecisions(fixture.docs,fixture.pairs,[changed],fixture.source).applied).toEqual([]);
  });

  it.each(["contradictory","related","uncertain"])("preserves conflicting or unresolved meaning: %s", relationship => {
    const fixture = prepare();
    fixture.rows[0].semanticAssessment.relationship = relationship;
    expect(run(fixture).documents).toHaveLength(2);
  });

  it("retains both records when each contains a conflicting description", () => {
    const fixture = prepare();
    fixture.docs[1].metadata.what = "Alex Casey Morgan is a five-year-old girl.";
    fixture.rows[0].rightOnlyDetails = ["girl"];
    expect(run(fixture).documents).toHaveLength(2);
  });

  it("does not conflate age observations from different dates", () => {
    const {source,docs} = fixture();
    docs[0].metadata.asOf = {year:"2018"};
    docs[1].metadata.asOf = {year:"2019"};
    expect(findCanonicalizationPairs(docs,{source})).toEqual([]);
  });

  it("does not conflate different numeric ages even with the same participant", () => {
    const {source,docs} = fixture("boy","5");
    docs[1].metadata.what = "Alex Casey Morgan is 6 years old.";
    expect(findCanonicalizationPairs(docs,{source})).toEqual([]);
  });

  it("does not treat another action as a participant description", () => {
    const fixture = prepare();
    fixture.docs[0].metadata.what = fixture.docs[1].metadata.what + " Casey started school.";
    fixture.rows[0].leftOnlyDetails = ["Casey started school"];
    fixture.rows[0].semanticAssessment.contextualDetails[0].detail = "Casey started school";
    fixture.rows[0].semanticAssessment.contextualDetails[0].sourceQuote = "Casey started school";
    fixture.docs[0].metadata.sourceSpans.push({pageNumber:2,sourceOffset:100,sourceQuote:"Casey started school"});
    expect(run(fixture).documents).toHaveLength(2);
  });
});
