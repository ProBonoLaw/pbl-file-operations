import {Document} from "@langchain/core/documents";
import {describe, expect, it, vi} from "vitest";
import {EvidenceReviewPending, withEvidenceReviewDispatcher, withEvidenceTaskCancellation, type EvidenceReviewTask} from "../src/processors/evidence/evidenceAsync.js";
import {canonicalizeEvidenceDocuments, type EvidenceCanonicalizationRuntime} from "../src/processors/evidence/evidenceCanonicalizationReview.js";
import {executeCanonicalizationReviewTask, validateCanonicalizationPlan} from "../src/processors/evidence/evidenceCanonicalizationQueue.js";
import type {EvidenceCheckpointStore} from "../src/processors/evidence/evidenceCheckpoint.js";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.js";
import {EvidenceStageCheckpoints} from "../src/processors/evidence/evidenceStageCheckpoints.js";
import {EvidenceBudgetError} from "../src/processors/evidence/evidenceCostBudget.js";
import {evidenceTaskHarness} from "./helpers/evidenceTaskHarness.js";
import {processEvidenceJob, EvidenceJobAttemptError, type EvidenceJobOperations} from "../src/processors/evidence/evidenceWorker.js";
import {EvidenceTaskRetry} from "../src/processors/evidence/evidenceTaskQueue.js";
import type {EvidenceJobStore, EvidenceWorkRecord} from "../src/processors/evidence/evidenceWorkStore.js";
import {findCanonicalizationPairs} from "../src/processors/evidence/evidenceCanonicalization.js";
import * as canonicalization from "../src/processors/evidence/evidenceCanonicalization.js";

vi.mock("../src/processors/appInsights.js",()=>({telemetryClient:{trackEvent:vi.fn(),trackException:vi.fn()}}));

type Input = {pairId:string};
const decision = ({pairId}:Input, relation="same_assertion") => ({pairId, relation,
  leftOnlyDetails:[], rightOnlyDetails:[], reason:"The same cited assessment."});

function fixture(count=13, reverseSourceOrder=false) {
  const h = evidenceTaskHarness();
  const quote="Casey completed the assessment.";
  const source = new EvidenceSource(new Document({pageContent:reverseSourceOrder ? `${quote} ${quote}` : quote,
    metadata:{accountId:"account", sourceId:"source", pages:[1]}}));
  const documents = Array.from({length:count},(_,index)=>new Document({pageContent:"", metadata:{
    accountId:"account", sourceId:"source", sourceContentHash:source.contentHash,
    what:quote, who:["Casey"], subject:["Casey"], tags:["fact"], factType:"attribute",
    sourceOffset:reverseSourceOrder && index===0 ? quote.length+1 : 0, sourceQuote:quote, pages:[1],
    sourceSpans:[{pageNumber:1, sourceOffset:reverseSourceOrder && index===0 ? quote.length+1 : 0, sourceQuote:quote}],
    extractedBy:["reviewer-"+index],
  }}));
  const saved = new Map<string,unknown>();
  const key = (identity:unknown,index:number,stage:string)=>JSON.stringify([identity,index,stage]);
  const store: EvidenceCheckpointStore = {get:async()=>null, put:async()=>{}, clearAccount:async()=>{}, clearSource:async()=>{},
    getStage:vi.fn(async(identity,index,stage)=>structuredClone(saved.get(key(identity,index,stage)) ?? null)),
    putStage:vi.fn(async(identity,index,stage,value)=>{saved.set(key(identity,index,stage),structuredClone(value));})};
  const invoke = vi.fn(async(pairs:Input[])=>({decisions:pairs.map(pair=>decision(pair))}));
  const vectors = vi.fn(async(texts:readonly string[])=>texts.map(()=>[1,0,0]));
  const track = vi.fn();
  const runtime: EvidenceCanonicalizationRuntime = {
    duplicateEmbeddings:{fingerprint:"embedding-v1", vectors},
    reconciliationModel:{deployment:"test"} as EvidenceCanonicalizationRuntime["reconciliationModel"],
    promptCompaction:"on", checkpoints:new EvidenceStageCheckpoints(store,track),
    sourceLookup:async()=>undefined,
    checkpointIdentity:async()=>({accountId:"account",sourceId:"source",runFingerprint:"test"}),
    invokeStructured:async(_schema,_instructions,content)=>await invoke(JSON.parse(content).pairs) as any,
    track,
  };
  const dispatcher = () => h.queue.dispatcher({accountId:"account",sourceId:"source",jobId:"job"});
  const run = () => withEvidenceReviewDispatcher(dispatcher(),()=>canonicalizeEvidenceDocuments(runtime,documents,source.document));
  const execute = (id:string) => h.queue.process(id,"review",task=>executeCanonicalizationReviewTask(runtime,task.definition.payload as EvidenceReviewTask,source));
  return {...h,source,documents,saved,store,invoke,vectors,track,runtime,run,execute};
}

describe("queued document canonicalization",()=>{
  it("restores saved batch membership without regrouping completed or pending pairs",async()=>{
    const f=fixture();
    await expect(f.run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    const ids=[...f.records.keys()];
    const saved=[...f.saved.values()].find(value=>(value as any).stage==="canonicalization-plan-v2") as any;
    const plan=validateCanonicalizationPlan(saved.value,f.documents.length);
    expect(plan.batches.map(batch=>batch.map(index=>plan.pairs[index].id))).toEqual(
      [...f.records.values()].map(task=>((task.definition.payload as EvidenceReviewTask).candidates[0] as any).pairs.map((pair:any)=>pair.id)));
    await f.execute(ids.at(-1)!);
    const grouping=vi.spyOn(canonicalization,"canonicalizationReviewBatchesAsync")
      .mockRejectedValue(new Error("A saved plan must not regroup pairs"));
    try {
      await expect(f.run()).rejects.toBeInstanceOf(EvidenceReviewPending);
      expect(grouping).not.toHaveBeenCalled();
      expect([...f.records.keys()]).toEqual(ids);
      expect(f.vectors).toHaveBeenCalledOnce();
    } finally {grouping.mockRestore();}
  });

  it.each(["missing", "duplicate", "foreign", "oversize"])("rejects %s pair membership in a saved batch plan",mode=>{
    const f=fixture(), pairs=findCanonicalizationPairs(f.documents,{source:f.source});
    const batches=pairs.map((_,index)=>[index]);
    if(mode==="missing") batches.pop();
    if(mode==="duplicate") batches[1]=batches[0];
    if(mode==="foreign") batches[0]=[pairs.length];
    if(mode==="oversize") batches.splice(0,17,batches.slice(0,17).flat());
    expect(()=>validateCanonicalizationPlan({pairs,batches,embeddingInputCount:0},f.documents.length)).toThrow();
  });

  it.each(["initial", "repair", "restored"])("preserves citation-repair history from %s assessments across the queue boundary",async path=>{
    const sentence="For the index scores and the FSIQ, scores from 90 to 109 are average.";
    const paragraph="The Example Assessment is a clinical instrument. Its subtest scores contribute to the index scores, which cover several cognitive areas. It also produces a Full Scale IQ composite score.";
    const abbreviated="The Example Assessment is a clinical instrument. Its subtest scores contribute to the index scores... It also produces a Full Scale IQ composite score.";
    const source=new EvidenceSource(new Document({pageContent:`${sentence}\n\n${paragraph}`,metadata:{sourceId:"source",pages:[1]}}));
    const documents=["Example Assessment score system","Example Assessment"].map(subject=>new Document({pageContent:sentence,metadata:{
      accountId:"account",sourceId:"source",sourceContentHash:source.contentHash,what:sentence,who:[subject],subject:[subject],
      factType:"recordedValue",reportedBy:[],tags:["fact"],where:"Unknown",why:"Unknown",sourceQuote:sentence,sourceOffset:0,pages:[1],
      sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:sentence},
        {pageNumber:1,sourceOffset:sentence.length+2,sourceQuote:paragraph}]}}));
    const pair=findCanonicalizationPairs(documents,{source})[0];
    const original={side:"left",citationIndex:99,sourceQuote:abbreviated};
    const assessment={pairId:pair.id,relation:"same_assertion",reason:"The same scoring rule and instrument.",
      leftOnlyDetails:[],rightOnlyDetails:[],semanticAssessment:{relationship:"equivalent",contextualDetails:[]},
      metadataResolutions:pair.metadataReview!.fields.map(field=>({field,explanation:"Both labels identify this instrument's scoring system.",
        citations:[{side:"left",citationIndex:0,sourceQuote:sentence},{side:"right",citationIndex:0,sourceQuote:sentence},original]}))};
    const f=fixture(2), inline=fixture(2);
    f.invoke.mockResolvedValue({decisions:[assessment]});
    inline.invoke.mockResolvedValue({decisions:[assessment]});
    const expected=await canonicalizeEvidenceDocuments(inline.runtime,documents,source.document);
    expect(expected.documents).toHaveLength(1);
    const audit=expected.documents[0].metadata.metadataResolutions[0].resolutions[0].citationRepairs;
    expect(audit).toEqual([{original,corrected:{side:"left",citationIndex:1,sourceQuote:paragraph}}]);
    if(path==="restored") {
      await canonicalizeEvidenceDocuments(f.runtime,documents,source.document);
      f.invoke.mockClear();
    }
    if(path==="repair") f.invoke.mockResolvedValueOnce({decisions:[{...assessment,reason:""}]});
    const run=()=>withEvidenceReviewDispatcher(f.queue.dispatcher({accountId:"account",sourceId:"source",jobId:"job"}),
      ()=>canonicalizeEvidenceDocuments(f.runtime,documents,source.document));
    await expect(run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    const id=[...f.records.keys()][0];
    await f.queue.process(id,"review",task=>executeCanonicalizationReviewTask(f.runtime,task.definition.payload as EvidenceReviewTask,source));
    expect(f.records.get(id)?.status).toBe("completed");
    expect((f.records.get(id)!.result as any).decisions[0].metadataResolutions[0].citations.at(-1)).toEqual(original);
    expect(await run()).toEqual(expected);
    expect(f.invoke).toHaveBeenCalledTimes(path==="restored" ? 0 : path==="repair" ? 2 : 1);
  });

  it("completes when source offsets order a pair differently from its document indexes",async()=>{
    const f=fixture(2,true);
    await expect(f.run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    const [id,task]=[...f.records.entries()][0];
    expect((task.definition.payload as EvidenceReviewTask).candidates[0]).toMatchObject({
      pairs:[{id:"0:1",leftIndex:1,rightIndex:0}],
    });
    await f.execute(id);
    expect(f.records.get(id)?.status).toBe("completed");
    const queued=await f.run();
    const inline=fixture(2,true);
    expect(queued).toEqual(await canonicalizeEvidenceDocuments(inline.runtime,inline.documents,inline.source.document));
    expect(queued.documents).toHaveLength(1);
    expect(queued.documents[0].metadata.sourceSpans).toHaveLength(2);
  });
  it("completes indexing and cleanup after delayed reviews, a lost notification, and indexing/cleanup retries",async()=>{
    const f=fixture();
    const request={accountId:"account",sourceId:"source",jobId:"job",containerName:"results",containerPath:"source.md",
      documentName:"source.md",sourceUrl:"https://example.test/source",identifier:"source.md",filepath:"/source.md",
      progressPartition:"progress",progressRow:"1:1",eventOrder:{enqueuedTicks:"100",partitionId:"0",sequenceNumber:"1"},
      cleanupBlobs:[{containerName:"results",containerPath:"source.md"}]};
    let record:EvidenceWorkRecord|null=null;
    let documents:Document[]=[];
    let receipt:{indexes:string[]}|null=null;
    const work:EvidenceJobStore={
      enqueue:async value=>{record??={request:value,status:"queued",attempts:0};}, get:async()=>record,
      documents:async()=>documents, saveDocuments:vi.fn(async(_id,value)=>{documents=value;}),
      indexResult:async()=>receipt, saveIndexResult:async(_id,value)=>{receipt=value;},
      removeDocuments:vi.fn(async()=>{documents=[];}),
      withLease:async(_id,apply)=>{
        if(!record || record.status==="completed") return false;
        await apply(structuredClone(record),async value=>{record=structuredClone(value);},()=>{});
        return true;
      },
    };
    const upload=vi.fn(async()=>{
      expect(documents).toHaveLength(1);
      expect(documents[0].metadata.extractedBy).toHaveLength(13);
      await work.saveIndexResult(request.jobId,{indexes:["evidence-index"]});
    }).mockRejectedValueOnce(new Error("index temporarily unavailable"));
    const operations:EvidenceJobOperations={resolveMode:async()=>"thorough",
      extract:vi.fn(async()=>(await canonicalizeEvidenceDocuments(f.runtime,f.documents,f.source.document)).documents),
      index:vi.fn(async()=>{if(!receipt) await upload(); return "SUCCESS" as const;}),
      publishCleanup:vi.fn(async()=>{expect(receipt).toEqual({indexes:["evidence-index"]});})
        .mockRejectedValueOnce(new Error("cleanup temporarily unavailable")),
    };
    const coordinator=await f.queue.submit({lane:"finalize",payload:request,correlation:request,maxAttempts:3,allowFailover:false});
    const finish=()=>f.queue.process(coordinator,"finalize",async()=>{
      try {
        await withEvidenceReviewDispatcher(f.queue.dispatcher(request),()=>processEvidenceJob(request,work,operations));
      } catch(error) {
        if(error instanceof EvidenceJobAttemptError) throw new EvidenceTaskRetry(error.exhausted,error);
        throw error;
      }
      return {jobId:request.jobId};
    });
    f.transport.send.mockRejectedValueOnce(new Error("queue send unavailable"));
    await finish();
    const reviewIds=[...f.records.values()].filter(task=>task.lane==="review").map(task=>task.id);
    expect(reviewIds).toHaveLength(5);
    expect(f.observe.mock.calls.some(([name])=>name==="EvidenceTaskDispatchDeferred")).toBe(true);
    f.advance(30_000);
    await f.queue.recover("review");
    expect(reviewIds.every(id=>f.records.get(id)!.dispatchedAt>0)).toBe(true);
    for(const id of reviewIds.slice(1).reverse()) await f.execute(id);
    await finish();
    expect(f.records.get(coordinator)).toMatchObject({status:"pending",attempts:0});
    expect(await work.get(request.jobId)).toMatchObject({status:"queued",attempts:0});
    expect(operations.index).not.toHaveBeenCalled();
    expect(operations.publishCleanup).not.toHaveBeenCalled();
    await f.execute(reviewIds[0]);
    f.advance(30_000);
    await finish(); // Reviews done; first indexing attempt fails.
    expect(await work.get(request.jobId)).toMatchObject({status:"extracted"});
    expect(operations.publishCleanup).not.toHaveBeenCalled();
    const extractionCalls=vi.mocked(operations.extract).mock.calls.length;
    f.advance(30_000);
    await finish(); // Index receipt saved; cleanup notification fails.
    expect(await work.get(request.jobId)).toMatchObject({status:"extracted"});
    expect(documents).toHaveLength(1);
    f.advance(30_000);
    await finish(); // Receipt reused; notification and completion succeed.
    expect(await work.get(request.jobId)).toMatchObject({status:"completed"});
    expect(f.records.get(coordinator)).toMatchObject({status:"completed",result:{jobId:"job"}});
    expect(documents).toEqual([]);
    expect(operations.publishCleanup).toHaveBeenLastCalledWith(request,"SUCCESS",false);
    expect(operations.publishCleanup).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(operations.extract).toHaveBeenCalledTimes(extractionCalls);
    expect(f.vectors).toHaveBeenCalledOnce();
    expect(f.invoke).toHaveBeenCalledTimes(5);
    await finish(); // Duplicate delivery does not repeat any side effect.
    expect(operations.publishCleanup).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("fans out the complete stable plan, resumes out of order, and matches inline merges and provenance",async()=>{
    const f=fixture();
    await expect(f.run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    const ids=[...f.records.keys()];
    expect(ids).toHaveLength(5); // 78 pairs; fan out beyond the former four active batches.
    expect([...f.records.values()].every(record=>record.lane==="review" && !record.definition.allowFailover)).toBe(true);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.vectors).toHaveBeenCalledOnce();
    expect(f.artifacts.size).toBe(1); // Shared source; only relevant records travel in each task.
    await f.execute(ids[4]);
    await expect(f.run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    expect([...f.records.keys()]).toEqual(ids);
    expect(f.invoke).toHaveBeenCalledOnce();
    expect(f.vectors).toHaveBeenCalledOnce();
    for(const id of ids.slice(0,4).reverse()) await f.execute(id);
    expect([...f.records.values()].map(record=>record.status)).toEqual(Array(5).fill("completed"));
    const result=await f.run();
    const inline=fixture();
    const expected=await canonicalizeEvidenceDocuments(inline.runtime,inline.documents,inline.source.document);
    expect(result).toEqual(expected);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.extractedBy).toHaveLength(13);
    expect(f.invoke).toHaveBeenCalledTimes(5);
    expect(await f.run()).toEqual(result);
    expect(f.invoke).toHaveBeenCalledTimes(5);
    expect(f.track.mock.calls.filter(([name])=>name==="canonicalizationPlanStarted")).toHaveLength(1);
  });

  it("reuses saved pair assessments after a worker's checkpoint upload fails",async()=>{
    const f=fixture(4);
    await expect(f.run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    const id=[...f.records.keys()][0];
    const put=f.store.putStage!;
    f.store.putStage=vi.fn().mockRejectedValueOnce(new Error("storage unavailable")).mockImplementation(put);
    await f.execute(id);
    expect(f.records.get(id)).toMatchObject({status:"pending",attempts:1,lane:"review"});
    f.advance(60_000);
    await f.execute(id);
    expect(f.invoke.mock.calls.map(([pairs])=>pairs.length)).toEqual([6,1]);
    expect(f.records.get(id)).toMatchObject({status:"completed"});
    expect((await f.run()).documents).toHaveLength(1);
  });

  it("retains distinct and unresolved pairs with the same behavior as inline review",async()=>{
    const f=fixture(4);
    f.invoke.mockImplementation(async pairs=>({decisions:pairs.map(pair=>decision(pair,
      pair.pairId==="0:1" ? "invalid" : "independent_assertions"))}));
    await expect(f.run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    await f.execute([...f.records.keys()][0]);
    const result=await f.run();
    expect(result.failedPairIds).toEqual(["0:1"]);
    expect(result.documents).toEqual(f.documents);
    const count=f.invoke.mock.calls.length;
    expect(await f.run()).toEqual(result);
    expect(f.invoke).toHaveBeenCalledTimes(count);
  });

  it.each(["embedding", "document", "identity", "compaction"])("invalidates the saved plan when %s changes",async change=>{
    const f=fixture(3);
    await expect(f.run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    if(change==="embedding") f.runtime.duplicateEmbeddings={fingerprint:"embedding-v2",vectors:f.vectors};
    if(change==="document") f.documents[0].metadata.extractedBy.push("new-reviewer");
    if(change==="identity") f.runtime.checkpointIdentity=async()=>({accountId:"account",sourceId:"source",runFingerprint:"changed"});
    if(change==="compaction") f.runtime.promptCompaction="off";
    await expect(f.run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    expect(f.vectors).toHaveBeenCalledTimes(2);
  });

  it.each(["accountId", "sourceId", "sourceContentHash", "survivors"])("rejects a changed %s in the queued input before model work",async field=>{
    const f=fixture(3);
    await expect(f.run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    const task=structuredClone([...f.records.values()][0].definition.payload) as EvidenceReviewTask;
    const batch=task.candidates[0] as any;
    if(field==="survivors") batch.pairs[0].allowedSurvivors=["right"];
    else batch.documents[0].metadata[field]="other";
    await expect(executeCanonicalizationReviewTask(f.runtime,task,f.source)).rejects.toThrow(/another source|source eligibility/);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it.each(["missing", "duplicate", "foreign", "invalid"])("rejects %s decisions from a completed queue task",async mode=>{
    const f=fixture(3);
    const run=()=>withEvidenceReviewDispatcher({result:async task=>{
      const pairs=(task.candidates[0] as any).pairs as {id:string}[];
      const decisions=pairs.map(pair=>decision({pairId:pair.id}));
      if(mode==="missing") decisions.pop();
      if(mode==="duplicate") decisions[1]=decisions[0];
      if(mode==="foreign") decisions[0].pairId="foreign";
      if(mode==="invalid") decisions[0].reason="";
      return {decisions,failedPairIds:[]};
    }},()=>canonicalizeEvidenceDocuments(f.runtime,f.documents,f.source.document));
    await expect(run()).rejects.toThrow(/cover their batch|Invalid queued canonicalization/);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("propagates worker budget stops without producing a finalized document",async()=>{
    const f=fixture(3);
    await expect(f.run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    f.invoke.mockRejectedValue(new EvidenceBudgetError("evidence_budget_exhausted","budget stopped"));
    await f.execute([...f.records.keys()][0]);
    await expect(f.run()).rejects.toBeInstanceOf(EvidenceBudgetError);
    expect(f.invoke).toHaveBeenCalledOnce();
    expect(f.track.mock.calls.some(([name])=>name==="canonicalizationCompleted")).toBe(false);
  });

  it.each(["rejects", "resolves"])("does not retry or save a cancelled model response when invocation %s",async outcome=>{
    const f=fixture(3);
    await expect(f.run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    const controller=new AbortController();
    const failure=new Error("job stopped");
    f.invoke.mockImplementation(async pairs=>{
      controller.abort(failure);
      if(outcome==="rejects") throw failure;
      return {decisions:pairs.map(pair=>decision(pair))};
    });
    const task=[...f.records.values()][0].definition.payload as EvidenceReviewTask;
    await expect(withEvidenceTaskCancellation({signal:controller.signal,assertOpen:async()=>controller.signal.throwIfAborted()},
      ()=>executeCanonicalizationReviewTask(f.runtime,task,f.source))).rejects.toBe(failure);
    expect(f.invoke).toHaveBeenCalledOnce();
    expect(f.saved.size).toBe(1); // The plan only; no decision from the stopped task.
  });
});
