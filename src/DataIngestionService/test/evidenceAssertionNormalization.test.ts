import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { prepareConsistencyRecords } from "../src/processors/evidence/evidenceConsistency.ts";
import { assessAssertionAlignment } from "../src/processors/evidence/evidenceAssertionAlignment.ts";
import { normalizeAssertionPair } from "../src/processors/evidence/evidenceAssertionNormalization.ts";

function pair(quote:string,left:string,right:string,header?:string) {
  const source=new Document({pageContent:header ? `${header}\n| --- | --- | --- |\n${quote}` : quote,metadata:{sourceId:"normalization-fixture",pages:[1]}});
  const sourceHash=new EvidenceSource(source).contentHash;
  const span={pageNumber:1,sourceOffset:source.pageContent.indexOf(quote),sourceQuote:quote};
  const documents=[left,right].map(what=>new Document({pageContent:"",metadata:{what,sourceId:source.metadata.sourceId,sourceContentHash:sourceHash,
    factType:"assessmentResult",tags:["fact"],who:["Casey"],sourceQuote:quote,sourceOffset:span.sourceOffset,pages:[1],
    sourceSpans:[span,...(header ? [{pageNumber:1,sourceOffset:0,sourceQuote:header}] : [])]}}));
  return prepareConsistencyRecords(documents,source);
}
const header="| Subtest | Score | Percentile |";
const row="| Recall | 7 | 16 |";
const numericLeft="Casey's Measure-X Recall score was 7, at the 16th percentile.";
const numericRight="Casey's Measure-X Recall result was score 7, percentile 16.";

describe("source-anchored assertion normalization",()=>{
  it("normalizes score/result and ordinal percentile wording using a shared row and header",()=>{
    const [a,b]=pair(row,numericLeft,numericRight,header),before=JSON.stringify([a,b]);
    const result=assessAssertionAlignment(a,b);
    expect(result).toMatchObject({version:"3",status:"likely-aligned",normalizations:[{ruleId:"cited-score-percentile",evidence:[a.sourceSpans[0],a.sourceSpans[1]]}]});
    expect(JSON.stringify([a,b])).toBe(before);
    expect(a.embeddingInput).toBe(b.embeddingInput);
  });
  it.each([[1,"st"],[2,"nd"],[3,"rd"],[11,"th"],[12,"th"],[13,"th"],[21,"st"],[100,"th"]])("accepts the valid ordinal for %i",(value,suffix)=>{
    const [a,b]=pair(`| Recall | 7 | ${value} |`,numericLeft.replace("16th",`${value}${suffix}`),numericRight.replace("16",String(value)),header);
    expect(assessAssertionAlignment(a,b).status).toBe("likely-aligned");
  });
  it.each([
    [numericLeft,numericRight.replace("16","17")],
    [numericLeft,numericRight.replace("score 7, percentile 16","score 16, percentile 7")],
    [numericLeft,numericRight.replace("Recall","Attention")],
    [numericLeft,numericRight.replace("Measure-X","Measure-Y")],
    [numericLeft.replace("16th","16st"),numericRight],
    [numericLeft.replace("score was","score was not"),numericRight],
    [numericLeft,numericRight.replace("score 7","standard score 7")],
    [numericLeft,numericRight.replace("percentile 16","percentile 16 and another result was 10")],
    [numericLeft.replace("7,","1.5,"),numericRight.replace("score 7","score 5.1")],
  ])("preserves measure, metric role, qualification and value differences",(left,right)=>{
    const [a,b]=pair(row,left,right,header);
    expect(normalizeAssertionPair(a,b).applied).toEqual([]);
    expect(assessAssertionAlignment(a,b).status).not.toBe("likely-aligned");
  });
  it.each([undefined,"| Subtest | Percentile | Score |","| Subtest | Score | Percentage |","| Subtest | Standard Score | Percentile |"])("requires explicit shared column roles: %s",columnHeader=>{
    const [a,b]=pair(row,numericLeft,numericRight,columnHeader);
    expect(normalizeAssertionPair(a,b).applied).toEqual([]);
  });
  it("requires both records to cite the header and values to match the cited row",()=>{
    const [a,b]=pair(row,numericLeft,numericRight,header);
    expect(normalizeAssertionPair(a,{...b,sourceSpans:[b.sourceSpans[0]]}).applied).toEqual([]);
    const [c,d]=pair("| Recall | 9 | 16 |",numericLeft,numericRight,header);
    expect(normalizeAssertionPair(c,d).applied).toEqual([]);
  });
  it.each(["sourceId","sourceContentHash","documentGroup"] as const)("requires shared %s",field=>{
    const [a,b]=pair(row,numericLeft,numericRight,header);
    expect(normalizeAssertionPair(a,{...b,[field]:"different"}).applied).toEqual([]);
  });
  it("requires the same citation occurrence, not just repeated text",()=>{
    const [a,b]=pair(row,numericLeft,numericRight,header);
    expect(normalizeAssertionPair(a,{...b,sourceSpans:[{...b.sourceSpans[0],sourceOffset:b.sourceSpans[0].sourceOffset+100},b.sourceSpans[1]]}).applied).toEqual([]);
  });
  it("does not turn a shared different-subtest row into an equivalent assessment",()=>{
    const [a,b]=pair("| Recall | 7 | 16 |",numericLeft,"Casey's Measure-X Attention score was 10, at the 50th percentile.",header);
    expect(assessAssertionAlignment(a,b).status).not.toBe("likely-aligned");
  });
  it("recognizes an anchored passive causal phrase without changing its qualification",()=>{
    const quote="The question of a learning disorder was raised due to a family history of reading difficulty.";
    const [a,b]=pair(quote,quote.replace("due to","because of"),quote);
    expect(assessAssertionAlignment(a,b)).toMatchObject({status:"likely-aligned",normalizations:[{ruleId:"anchored-causal-phrase"}]});
  });
  it.each([
    ["The payment was due to Casey.","The payment was because of Casey."],
    ["The delay caused the concern.","The concern caused the delay."],
    ["The question was not raised because of family history.","The question was raised due to family history."],
    ["The question was raised because of family history.","The diagnosis was confirmed due to family history."],
    ["The question was raised because of family history.","The question was raised due to family history and low test scores."],
  ])("does not conflate obligation, causal direction, negation or compound assertions",(left,right)=>{
    const [a,b]=pair(`${left} ${right}`,left,right);
    expect(assessAssertionAlignment(a,b).status).not.toBe("likely-aligned");
  });
  it("requires source support for the causal phrasing",()=>{
    const [a,b]=pair("The payment arrived.","The payment was delayed because of a dispute.","The payment was delayed due to a dispute.");
    expect(normalizeAssertionPair(a,b).applied).toEqual([]);
  });
  it("does not rewrite only one side when an intervening role blocks the other pattern",()=>{
    const quote="The question was raised due to family history.";
    const [a,b]=pair(quote,"The question was raised because of family history.","The question was raised for Casey because of family history.");
    expect(normalizeAssertionPair(a,b).applied).toEqual([]);
    expect(assessAssertionAlignment(a,b).status).toBe("likely-aligned");
  });
  it("recognizes parental-help wording anchored to the same source assertion",()=>{
    const [a,b]=pair('Casey resists parent help by saying, "I know."',
      'Casey resists help from his parents by saying, “I know.”','Casey resists parental help by saying, "I know."');
    expect(assessAssertionAlignment(a,b)).toMatchObject({status:"likely-aligned",normalizations:[{ruleId:"anchored-parent-help"}]});
  });
  it.each([
    ["Casey resists help from his parents.","Casey resists help to his parents."],
    ["Casey resists help from his parents.","Casey resists help from her parents."],
    ["Casey resists help from his parents.","Casey resists help from his teacher."],
    ["Casey does not resist help from his parents.","Casey resists parental help."],
    ["Casey resists help from his parents.","Casey resists parental help and avoids teachers."],
  ])("preserves help direction, participants and qualifications",(left,right)=>{
    const [a,b]=pair(`${left} ${right}`,left,right);
    const result=assessAssertionAlignment(a,b);
    if(left.includes("his parents")&&right.includes("her parents"))expect(result.normalizations).toEqual([]);
    expect(result.status).not.toBe("likely-aligned");
  });
  it("does not normalize uncited help phrasing",()=>{
    const [a,b]=pair("Casey completed an examination.","Casey resists help from his parents.","Casey resists parental help.");
    expect(normalizeAssertionPair(a,b).applied).toEqual([]);
  });
});
