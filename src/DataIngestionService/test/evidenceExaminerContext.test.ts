import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { prepareConsistencyRecords, type ConsistencyRecord } from "../src/processors/evidence/evidenceConsistency.ts";
import { assessAssertionAlignment } from "../src/processors/evidence/evidenceAssertionAlignment.ts";
import { normalizeExaminerContext } from "../src/processors/evidence/evidenceExaminerContext.ts";

function pair(dateList="5/15/18, 7/18/18, 8/21/18") {
  const client="**Client:** Taylor Casey Reed",examiner="**Examiner:** Morgan A. Lane, Ph.D.";
  const quote=`**Interview and examination dates:** ${dateList}`;
  const source=new Document({pageContent:[client,examiner,quote].join("\n"),metadata:{sourceId:"examiner-context-fixture",pages:[1]}});
  const sourceHash=new EvidenceSource(source).contentHash;
  const spans=[quote,client,examiner].map(sourceQuote=>({sourceQuote,pageNumber:1,sourceOffset:source.pageContent.indexOf(sourceQuote)}));
  const statements=[
    "An interview and examination session for Casey took place on August 21, 2018.",
    "An interview and examination session for Taylor Casey Reed took place on August 21, 2018, with Morgan A. Lane identified as examiner.",
  ];
  return prepareConsistencyRecords(statements.map((what,i)=>new Document({pageContent:"",metadata:{
    what,sourceId:source.metadata.sourceId,sourceContentHash:sourceHash,tags:i ? ["claim"] : ["event","eventType:assessment"],
    claimType:i ? "other" : undefined,claimPolarity:i ? "asserts" : undefined,
    who:[i ? "Taylor Casey Reed" : "Casey",i ? "Morgan A. Lane" : "Morgan A. Lane, Ph.D."],
    whenStarted:{year:"2018",month:"8",day:"21",season:null,quarter:null},whenEnded:null,
    sourceSpans:spans,sourceQuote:quote,sourceOffset:spans[0].sourceOffset,pages:[1],
  }})),source);
}

describe("cited examiner context",()=>{
  it.each([false,true])("aligns the same dated examination with source-supported name context (reversed=%s)",reverse=>{
    const records=pair(),before=JSON.stringify(records);
    const [a,b]=reverse ? [...records].reverse() : records;
    expect(assessAssertionAlignment(a,b)).toMatchObject({version:"3",status:"likely-aligned",normalizations:[{
      ruleId:"cited-examiner-context",evidence:a.sourceSpans,
    }]});
    expect(JSON.stringify(records)).toBe(before);
  });
  it.each(["August 21, 2018","May 15, 2018; August 21, 2018","2018-08-21","8/21/2018","8/21/18"])("accepts an unambiguous cited date: %s",dates=>{
    const [a,b]=pair(dates);
    expect(normalizeExaminerContext(a,b)).not.toBeNull();
  });
  it.each(["8/20/18","2019-08-21","August 21, 2019","planned: 8/21/18","not August 21, 2018", "8/21/18 (cancelled)","8/21/18–8/23/18", "8/21/18 for someone else"])("rejects missing or qualified source support: %s",dates=>{
    const [a,b]=pair(dates);
    expect(normalizeExaminerContext(a,b)).toBeNull();
  });
  it("rejects ambiguous slash dates even when both statements agree",()=>{
    const records=pair("8/9/18");
    for(const record of records){
      record.statement=record.statement.replace("August 21","August 9");
      (record.fields.dates as {whenStarted:{day:string}}).whenStarted.day="9";
    }
    expect(normalizeExaminerContext(records[0],records[1])).toBeNull();
  });
  it("keeps separate sessions distinct even when both dates occur in the same source header",()=>{
    const [a,b]=pair();
    b.statement=b.statement.replace("August 21","July 18");
    Object.assign((b.fields.dates as {whenStarted:object}).whenStarted,{month:"7",day:"18"});
    expect(normalizeExaminerContext(a,b)).toBeNull();
    expect(assessAssertionAlignment(a,b).status).not.toBe("likely-aligned");
  });
  const mutations: [string,(a:ConsistencyRecord,b:ConsistencyRecord)=>void][]=[
    ["different source",(_a,b)=>{b.sourceId="different";}],
    ["different source revision",(_a,b)=>{b.sourceContentHash="different";}],
    ["different document group",(_a,b)=>{b.documentGroup="different";}],
    ["different citation occurrence",(_a,b)=>{b.sourceSpans[0].sourceOffset+=1;}],
    ["missing client citation",(_a,b)=>{b.sourceSpans.splice(1,1);}],
    ["missing examiner citation",(_a,b)=>{b.sourceSpans.pop();}],
    ["client on a different page",(a,b)=>{for(const r of [a,b])r.sourceSpans[1].pageNumber=2;}],
    ["client after the examination header",(a,b)=>{for(const r of [a,b])r.sourceSpans[1].sourceOffset=1000;}],
    ["distant client context",(a,b)=>{for(const r of [a,b])r.sourceSpans[0].sourceOffset=3000;}],
    ["multiple client contexts",(a,b)=>{for(const r of [a,b])r.sourceSpans.push({...r.sourceSpans[1],sourceOffset:1,sourceQuote:"**Client:** Taylor Casey Moss"});}],
    ["multiple examiner contexts",(a,b)=>{for(const r of [a,b])r.sourceSpans.push({...r.sourceSpans[2],sourceOffset:1,sourceQuote:"**Examiner:** Dana West"});}],
    ["unrelated short name",(a)=>{a.statement=a.statement.replace("Casey","Jamie");a.fields.people[0]="Jamie";}],
    ["surname alone",(a)=>{a.statement=a.statement.replace("Casey","Reed");a.fields.people=a.fields.people.map(p=>p==="Casey" ? "Reed" : p);}],
    ["no explicit full client name",(_a,b)=>{b.statement=b.statement.replace("Taylor Casey Reed","Casey");}],
    ["wrong examiner",(_a,b)=>{b.statement=b.statement.replace("Morgan A. Lane","Dana West");}],
    ["different examiner initial",(_a,b)=>{b.statement=b.statement.replace("Morgan A. Lane","Morgan B. Lane");}],
    ["additional participant",(_a,b)=>{b.fields.people.push("Dana West");}],
    ["missing examiner participant",(a)=>{a.fields.people=["Casey"];}],
    ["different claimant",(_a,b)=>{b.fields.claimant="Dana West";}],
    ["different event date",(_a,b)=>{b.statement=b.statement.replace("August 21","August 22");}],
    ["date metadata mismatch",(_a,b)=>{(b.fields.dates as {whenStarted:{day:string}}).whenStarted.day="22";}],
    ["unknown event date",(_a,b)=>{(b.fields.dates as {whenStarted:unknown}).whenStarted=null;}],
    ["date range",(_a,b)=>{(b.fields.dates as {whenEnded:unknown}).whenEnded={year:"2018",month:"8",day:"22"};}],
    ["additional as-of date",(_a,b)=>{(b.fields.dates as {asOf:unknown}).asOf={year:"2018"};}],
    ["relative date resolution",(_a,b)=>{(b.fields.dates as {eventDateResolution:unknown}).eventDateResolution={method:"relative"};}],
    ["negation",(a)=>{a.statement=a.statement.replace("took place","did not take place");}],
    ["qualification",(a)=>{a.statement=a.statement.replace("took place","possibly took place");}],
    ["compound assertion",(_a,b)=>{b.statement=b.statement.replace("examiner.","examiner, and a diagnosis was confirmed.");}],
    ["examiner is the client",(_a,b)=>{b.statement=b.statement.replace("Taylor Casey Reed","Morgan A. Lane");}],
    ["both statements already name an examiner",(a)=>{a.statement=a.statement.replace("2018.","2018, with Morgan A. Lane identified as examiner.");}],
    ["neither statement names an examiner",(_a,b)=>{b.statement=b.statement.replace(", with Morgan A. Lane identified as examiner","");}],
    ["impossible date",(a,b)=>{for(const r of [a,b])r.statement=r.statement.replace("August 21","February 30");}],
  ];
  it.each(mutations)("declines unsupported context: %s",(_description,mutate)=>{
    const [a,b]=structuredClone(pair());
    mutate(a,b);
    expect(normalizeExaminerContext(a,b)).toBeNull();
    expect(assessAssertionAlignment(a,b).normalizations.some(n=>n.ruleId==="cited-examiner-context")).toBe(false);
  });
});
