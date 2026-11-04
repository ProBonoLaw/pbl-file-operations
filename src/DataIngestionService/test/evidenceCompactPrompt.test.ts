import { describe, expect, it } from "vitest";
import { Document } from "@langchain/core/documents";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.js";
import { canonicalPromptValue, stablePromptId, poolPromptPassages, poolPromptRecords, omitPromptDefaults,
  mergePromptContexts, compactEvidencePrompt, evidencePromptCompaction } from "../src/processors/evidence/evidenceCompactPrompt.js";

const scope = {accountId:"account-a", sourceId:"391", contentHash:"document-revision-a"};
const source = new EvidenceSource(new Document({pageContent:"A source page.", metadata:{pages:[1]}}));
const longQuote = "The witness denied seeing the vehicle and could not identify the driver. ".repeat(12);

describe("compact model input", () => {
  it("keeps identifiers stable across batches, object order, retries and restarts without conflating tenants or revisions", () => {
    const first = {assertion:{what:"A denied B", who:["A","B"]}, evidence:{sourceQuote:longQuote, pageNumber:1}};
    const reordered = {evidence:{pageNumber:1, sourceQuote:longQuote}, assertion:{who:["A","B"], what:"A denied B"}};
    expect(stablePromptId("r",scope,first)).toBe(stablePromptId("r",scope,reordered));
    for (const changed of [{...scope,accountId:"account-b"},{...scope,sourceId:"392"},{...scope,contentHash:"revision-b"}])
      expect(stablePromptId("r",changed,first)).not.toBe(stablePromptId("r",scope,first));
    expect(stablePromptId("r",scope,{...first,assertion:{what:"A denied B",who:["B","A"]}}))
      .not.toBe(stablePromptId("r",scope,first));
    expect(stablePromptId("p",scope,longQuote+" ")).not.toBe(stablePromptId("p",scope,longQuote));
    expect(stablePromptId("r",scope,first)).not.toBe(stablePromptId("p",scope,first));
  });

  it("pools only exact repeated text and preserves each occurrence's page, offset, order and negation", () => {
    const rows = [{sourceQuote:longQuote,pageNumber:1,sourceOffset:20},{sourceQuote:longQuote,pageNumber:4,sourceOffset:99},
      {sourceQuote:longQuote.replace("denied", "affirmed"),pageNumber:1,sourceOffset:1}];
    const pooled:any = poolPromptPassages({rows},scope);
    const differentBatch:any = poolPromptPassages({rows:[rows[2],rows[1],rows[0],rows[1]]},scope);
    expect(pooled.passages).toHaveLength(1);
    expect(differentBatch.rows[1].sourceQuote).toEqual(pooled.rows[0].sourceQuote);
    expect(pooled.rows[0].sourceQuote).toEqual(pooled.rows[1].sourceQuote);
    const lookup = new Map(pooled.passages.map((p:any) => [p.id,p.text]));
    expect(pooled.rows.map((r:any) => ({...r,sourceQuote:typeof r.sourceQuote === "string" ? r.sourceQuote : lookup.get(r.sourceQuote.passageId)}))).toEqual(rows);
    expect(rows[0].sourceQuote).toBe(longQuote);
  });

  it("uses stable record references even when a record moves to a repair batch or changes sides", () => {
    const a = {assertion:{what:"denied",who:["witness"]}, evidence:{sourceQuote:longQuote}};
    const b = {assertion:{what:"uncertain",who:[]}, evidence:{sourceQuote:"Could not identify."}};
    const first:any = poolPromptRecords({pairs:[{pairId:"1",left:a,right:b},{pairId:"2",left:b,right:a}]},scope);
    const repair:any = poolPromptRecords({pairs:[{pairId:"2",left:b,right:a,validationFeedback:"Review again"}]},scope);
    expect(first.records).toHaveLength(2);
    expect(first.pairs[0].left).toEqual(repair.pairs[0].right);
    expect(first.pairs[0].right).toEqual(repair.pairs[0].left);
    const lookup = new Map(first.records.map((r:any) => [r.id,r.record]));
    expect(lookup.get(first.pairs[0].left.recordId)).toEqual(a);
    expect(repair.pairs[0].validationFeedback).toBe("Review again");
  });

  it("omits only known defaults, keeping populated diagnostics, wrong types and explicit clearing instructions", () => {
    const candidate = {candidateId:"1",kind:"claim",item:{whenStartedYear:null,whenStartedDay:"3",claimant:"Unknown",who:[],polarity:"denies"},
      citationErrors:[],citationChoices:null,classificationIssues:["review classification"],boundaryContext:[],eventClassificationConcerns:[],
      corrections:[{field:"who",value:[]},{field:"whenStartedYear",value:null}]};
    const input = {candidates:[candidate],source:{citedContext:[{pageNumber:1,sourceOffset:0,sourceQuote:"Quote",dateCue:false,identityCue:true}]}};
    const compact:any = omitPromptDefaults(input);
    expect(compact.candidates[0]).toEqual({candidateId:"1",kind:"claim",item:{whenStartedDay:"3",claimant:"Unknown",who:[],polarity:"denies"},
      citationChoices:null,classificationIssues:["review classification"],corrections:candidate.corrections});
    expect(compact.source.citedContext[0]).not.toHaveProperty("dateCue");
    expect(compact.source.citedContext[0].identityCue).toBe(true);
    expect(input.candidates[0].item.whenStartedYear).toBeNull();
  });

  it("merges overlapping context without hiding primary quotations or changing their exact neighborhoods", () => {
    const text = "Prefix ".repeat(40)+"Alice said the door was open. Bob denied seeing it."+" Suffix".repeat(40);
    const doc = new EvidenceSource(new Document({pageContent:text,metadata:{pages:[7]}}));
    const candidates = ["Alice said the door was open.","Bob denied seeing it."].map((quote,i) => {
      const span = doc.locateSupporting(7,quote)!;
      return {candidateId:String(i),sourcePage:7,sourceQuote:quote,...doc.quoteContext(span,200)};
    });
    const compact:any = mergePromptContexts({candidates},doc,scope);
    expect(compact.sourcePassages).toHaveLength(1);
    for (const [i,candidate] of compact.candidates.entries()) {
      const passage = compact.sourcePassages.find((p:any) => p.id === candidate.context.passageId);
      const offset = candidate.context.sourceOffset - passage.startOffset, end = offset+candidate.sourceQuote.length;
      expect(candidate.sourceQuote).toBe(candidates[i].sourceQuote);
      expect(passage.text.slice(offset,end)).toBe(candidate.sourceQuote);
      expect(passage.text.slice(Math.max(0,offset-200),offset)).toBe(candidates[i].before);
      expect(passage.text.slice(end,end+200)).toBe(candidates[i].after);
    }
    const reversed:any = mergePromptContexts({candidates:[...candidates].reverse()},doc,scope);
    expect(reversed.sourcePassages).toEqual(compact.sourcePassages);
  });

  it("leaves ambiguous or non-verbatim source contexts literal", () => {
    const doc = new EvidenceSource(new Document({pageContent:"A repeated quote. A repeated quote.",metadata:{pages:[1]}}));
    const original = {candidates:[{candidateId:"1",sourcePage:1,sourceQuote:"A repeated quote.",before:"",after:""}]};
    expect(mergePromptContexts(original,doc,scope)).toBe(original);
  });

  it("includes dictionary instructions only when total encoded input is cheaper", () => {
    const short = compactEvidencePrompt(JSON.stringify({candidates:[{sourceQuote:"short"},{sourceQuote:"short"}]}),"claim-attribution",source,scope,"json");
    expect(short.instructions).toBe("");
    expect(JSON.parse(short.content)).not.toHaveProperty("passages");
    const long = compactEvidencePrompt(JSON.stringify({candidates:Array.from({length:16},(_,i)=>({candidateId:String(i),sourceQuote:longQuote}))}),"claim-attribution",source,scope,"json");
    expect(long.instructions).toContain("INPUT PASSAGES");
    expect(JSON.parse(long.content).passages).toHaveLength(1);
    expect(canonicalPromptValue({z:"quote\n",a:["b","a"]})).toEqual({a:["b","a"],z:"quote\n"});
    expect(evidencePromptCompaction("")).toBe("off");
    expect(evidencePromptCompaction("on")).toBe("on");
    expect(()=>evidencePromptCompaction("invalid")).toThrow("EVIDENCE_PROMPT_COMPACTION");
  });
});
