import {describe, expect, it, vi} from "vitest";
import {Document} from "@langchain/core/documents";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.js";
import {applyCanonicalizationDecisions} from "../src/processors/evidence/evidenceCanonicalization.js";
import {parseExtractionPackage} from "../src/processors/extractionPackage.js";
// The operational runner is mounted beside the deployed build in its isolated job.
// @ts-expect-error Operational JavaScript module intentionally has no declarations.
import {digest, jsonDigest, validateReplayInput, ReplayCheckpoints, replayReviewDispatcher, attachReplayLocations} from "../scripts/evidence-finalization-replay-core.mjs";

function storage() {
  const rows = new Map<string,unknown>();
  return {rows, read:vi.fn(async (key:string) => structuredClone(rows.get(key) ?? null)),
    write:vi.fn(async (key:string,value:unknown) => {rows.set(key,structuredClone(value));})};
}
function fixture() {
  const source = new EvidenceSource(new Document({pageContent:"Casey completed the assessment.",metadata:{sourceId:"6",pages:[1]}}));
  const input = {version:1,accountId:"account",sourceId:"6",sourceJobId:"stopped-job",sourceContentHash:source.contentHash,
    source:source.document,documents:[new Document({pageContent:source.document.pageContent,metadata:{accountId:"account",sourceId:"6",
      sourceContentHash:source.contentHash,sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:source.document.pageContent}]}})]};
  const bytes = Buffer.from(JSON.stringify(input));
  const expected = {...input,inputHash:digest(bytes),jobId:"replay-job",documentCount:1};
  return {source,input,bytes,expected};
}

function locationPackage(source:EvidenceSource,mediaType:"document"|"audio") {
  const text=source.document.pageContent;
  const location={pages:mediaType==="document"?[1]:[],regions:[],
    startTimeMs:mediaType==="document"?null:1000,endTimeMs:mediaType==="document"?null:4000,speaker:null};
  return parseExtractionPackage({version:1,accountId:"account",sourceId:"6",mediaType,provider:"content-understanding",
    analyzerId:"test",apiVersion:"2025-11-01",analysisId:"one",configurationHash:"a".repeat(64),
    sourceSha256:"b".repeat(64),stringEncoding:"utf16",literalMarkdown:text,
    literalPages:[{pageNumber:1,text,locationKind:mediaType==="document"?"physical-page":"media"}],
    blocks:[{id:"literal",kind:mediaType==="document"?"paragraph":"transcript",origin:"extracted",text,...location,serviceSpans:[]}],
    evidenceLocations:[{pageNumber:1,offset:0,length:text.length,blockId:"literal",...location}],
    rawResponse:{},usage:null,warnings:[]});
}

describe("finalization replay safeguards",()=>{
  it.each(["document","audio"] as const)("reuses completed reviews after a %s location-output save fails",async mediaType=>{
    const f=fixture(), saved=storage(), documents=f.input.documents;
    documents[0].pageContent+="\nSource page: 1";
    documents[0].metadata.tags=["fact"];
    const original=jsonDigest(documents), pkg=locationPackage(f.source,mediaType);
    const execute=vi.fn(async()=>({decisions:[],failedPairIds:[]}));
    let saves=0;
    const save=vi.fn(async(finalized:Document[])=>{
      if(saves++===0)throw new Error("Finalized output save failed");
      return finalized;
    });
    const run=async()=>{
      const dispatcher=replayReviewDispatcher({storage:saved,source:f.source,execute,checkOpen:async()=>{}});
      await dispatcher.result({component:"canonicalization",batchId:"1",candidates:documents},f.source.document);
      const unmerged=applyCanonicalizationDecisions(documents,[],[]).documents;
      expect(unmerged[0]).toBe(documents[0]);
      return save(attachReplayLocations(unmerged,pkg));
    };
    await expect(run()).rejects.toThrow("Finalized output save failed");
    expect(jsonDigest(documents)).toBe(original);
    const finalized=await run();
    expect(execute).toHaveBeenCalledOnce();
    expect(jsonDigest(documents)).toBe(original);
    expect(finalized[0]).toBeInstanceOf(Document);
    expect(finalized[0].metadata.sourceSpans).not.toBe(documents[0].metadata.sourceSpans);
    expect(finalized[0].metadata.citations[0]).toMatchObject({canonicalPage:1,sourceQuote:f.source.document.pageContent});
    if(mediaType==="audio") {
      expect(finalized[0].pageContent).toContain("Source time (milliseconds): 1000–4000");
      expect(finalized[0].metadata.pages).toEqual([]);
    } else expect(finalized[0].metadata.pages).toEqual([1]);
  });

  it("leaves all review inputs unchanged when mapping fails after an earlier document was mapped",()=>{
    const f=fixture(), documents=f.input.documents;
    documents.push(new Document({pageContent:"Another fact.",metadata:{sourceSpans:[{pageNumber:2,sourceOffset:0,sourceQuote:"Missing location."}]}}));
    const original=jsonDigest(documents);
    expect(()=>attachReplayLocations(documents,locationPackage(f.source,"document")))
      .toThrow("Evidence quote has no original source location");
    expect(jsonDigest(documents)).toBe(original);
  });

  it("accepts the pinned saved input without an extraction callback",()=>{
    const f=fixture();
    expect(validateReplayInput(f.bytes,f.expected).documents).toEqual(f.input.documents);
  });
  it.each(["checksum","source","account","count","stopped-job"])("blocks %s input changes before model work",change=>{
    const f=fixture(), expected={...f.expected};
    if(change==="checksum") expected.inputHash="0".repeat(64);
    if(change==="source") expected.sourceContentHash="0".repeat(64);
    if(change==="account") expected.accountId="other";
    if(change==="count") expected.documentCount=2;
    if(change==="stopped-job") expected.jobId=expected.sourceJobId;
    expect(()=>validateReplayInput(f.bytes,expected)).toThrow();
  });
  it("resumes a completed review after process restart without calling the model again",async()=>{
    const f=fixture(), saved=storage();
    const execute=vi.fn(async()=>({decisions:[{pairId:"0:1"}],failedPairIds:[]}));
    const dependencies={storage:saved,source:f.source,execute,checkOpen:async()=>{}};
    const task={component:"canonicalization",batchId:"canonicalization:1"};
    const expected=await replayReviewDispatcher(dependencies).result(task,f.source.document);
    expect(await replayReviewDispatcher(dependencies).result(task,f.source.document)).toEqual(expected);
    expect(execute).toHaveBeenCalledOnce();
  });
  it("preserves unresolved comparisons so ingestion can retain both records without repeating paid reviews",async()=>{
    const f=fixture(), saved=storage();
    const execute=vi.fn(async()=>({decisions:[],failedPairIds:["0:1"]}));
    const dependencies={storage:saved,source:f.source,execute,checkOpen:async()=>{}};
    const task={component:"canonicalization",batchId:"canonicalization:1"};
    await replayReviewDispatcher(dependencies).result(task,f.source.document);
    expect(await replayReviewDispatcher(dependencies).result(task,f.source.document)).toEqual({decisions:[],failedPairIds:["0:1"]});
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each(["gathering","source-support","dates"])("cannot dispatch %s during replay",async component=>{
    const f=fixture(), execute=vi.fn();
    const dispatcher=replayReviewDispatcher({storage:storage(),source:f.source,execute,checkOpen:async()=>{}});
    await expect(dispatcher.result({component},f.source.document)).rejects.toThrow("cannot dispatch extraction");
    expect(execute).not.toHaveBeenCalled();
  });
  it("retains completed siblings when a later review fails and resumes only the unfinished batch",async()=>{
    const f=fixture(), saved=storage();
    const execute=vi.fn(async(task:{batchId:string})=>{
      if(task.batchId==="2" && execute.mock.calls.length===2) throw new Error("model unavailable");
      return {decisions:[{pairId:task.batchId}],failedPairIds:[]};
    });
    const dependencies={storage:saved,source:f.source,execute,checkOpen:async()=>{}};
    const first=replayReviewDispatcher(dependencies);
    await first.result({component:"canonicalization",batchId:"1"},f.source.document);
    await expect(first.result({component:"canonicalization",batchId:"2"},f.source.document)).rejects.toThrow();
    const resumed=replayReviewDispatcher(dependencies);
    await resumed.result({component:"canonicalization",batchId:"1"},f.source.document);
    await resumed.result({component:"canonicalization",batchId:"2"},f.source.document);
    expect(execute.mock.calls.map(([task])=>task.batchId)).toEqual(["1","2","2"]);
  });
  it("refuses a corrupted completed review instead of paying to replace it",async()=>{
    const f=fixture(), saved=storage(), execute=vi.fn(async()=>({decisions:[],failedPairIds:[]}));
    const deps={storage:saved,source:f.source,execute,checkOpen:async()=>{}};
    const task={component:"canonicalization",batchId:"1"};
    await replayReviewDispatcher(deps).result(task,f.source.document);
    const key=[...saved.rows.keys()][0];
    saved.rows.set(key,{result:{decisions:["changed"]},resultHash:"wrong"});
    await expect(replayReviewDispatcher(deps).result(task,f.source.document)).rejects.toThrow("changed");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("does not save a late response when the source was superseded during review",async()=>{
    const f=fixture(), saved=storage(), checkOpen=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("superseded"));
    const dispatcher=replayReviewDispatcher({storage:saved,source:f.source,checkOpen,
      execute:async()=>({decisions:[],failedPairIds:[]})});
    await expect(dispatcher.result({component:"canonicalization"},f.source.document)).rejects.toThrow("superseded");
    expect(saved.write).not.toHaveBeenCalled();
  });
  it("keeps a checkpoint private until its deadline scope publishes it",async()=>{
    const saved=storage(), controller=new AbortController();
    const checkpoints=new ReplayCheckpoints(saved,{accountId:"account",sourceId:"6"},()=>{});
    const identity={accountId:"account",sourceId:"6",runFingerprint:"implementation"};
    let publish:()=>Promise<void>;
    const guard={abortSignal:controller.signal,assertActive:()=>controller.signal.throwIfAborted(),
      deferPublication:(_key:string,callback:()=>Promise<void>)=>{publish=callback;}};
    await checkpoints.putStage(identity,0,"pair",{valid:true},guard);
    expect(await checkpoints.getStage(identity,0,"pair")).toBeNull();
    expect(await checkpoints.getStage(identity,0,"pair",controller.signal)).toEqual({valid:true});
    await publish!();
    expect(await new ReplayCheckpoints(saved,{accountId:"account",sourceId:"6"},()=>{}).getStage(identity,0,"pair")).toEqual({valid:true});
    await expect(checkpoints.clearSource()).rejects.toThrow("retained");
  });
  it("never publishes a late checkpoint upload after cancellation",async()=>{
    const saved=storage(), controller=new AbortController(), deferPublication=vi.fn();
    const original=saved.write;
    saved.write=vi.fn(async(key:string,value:unknown)=>{await original(key,value);controller.abort(new Error("cancelled"));});
    const checkpoints=new ReplayCheckpoints(saved,{accountId:"account",sourceId:"6"},()=>{});
    const identity={accountId:"account",sourceId:"6",runFingerprint:"implementation"};
    await expect(checkpoints.putStage(identity,0,"pair",{valid:true},{abortSignal:controller.signal,
      assertActive:()=>controller.signal.throwIfAborted(),deferPublication})).rejects.toThrow("cancelled");
    expect(deferPublication).not.toHaveBeenCalled();
    expect(await checkpoints.getStage(identity,0,"pair")).toBeNull();
  });
});
