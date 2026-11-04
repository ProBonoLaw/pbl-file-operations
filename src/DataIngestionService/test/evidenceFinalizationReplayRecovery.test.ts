import {afterEach, describe, expect, it, vi} from "vitest";
import {Document} from "@langchain/core/documents";
import {EvidenceExtractor} from "../src/processors/evidence/evidenceExtractor.js";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.js";
import {processEvidenceJob, type EvidenceJobOperations} from "../src/processors/evidence/evidenceWorker.js";
import type {EvidenceJobStore, EvidenceWorkRecord} from "../src/processors/evidence/evidenceWorkStore.js";
// @ts-expect-error Operational JavaScript module intentionally has no declarations.
import {createReplayExtractor, resumeReplayIndexing} from "../scripts/evidence-finalization-replay-core.mjs";

vi.mock("../src/processors/appInsights.js",()=>({telemetryClient:{trackEvent:vi.fn(),trackException:vi.fn()}}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});

describe("replay source lookup",()=>{
  it.each([true,false])("preserves the ingestion lookup policy for CurrentOrder=%s",async isCurrentOrder=>{
    vi.stubEnv("EVIDENCE_SOURCE_LOOKUP_MODE","hybrid");
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT","https://example.test");
    vi.stubEnv("AZURE_OPENAI_LLM_API_KEY","test-key");
    const fetch=vi.fn(()=>{throw new Error("Unexpected network call");});
    vi.stubGlobal("fetch",fetch);
    const checkpoints={getStage:vi.fn(async()=>null)};
    const source=new EvidenceSource(new Document({pageContent:"Casey completed the assessment.",metadata:{sourceId:"6",pages:[1]}}));
    const extractor=createReplayExtractor(EvidenceExtractor,{accountId:"account",sourceId:"6",isCurrentOrder},checkpoints);
    if(isCurrentOrder) {
      await expect(extractor.sourceLookup(source)).resolves.toBeUndefined();
      expect(checkpoints.getStage).not.toHaveBeenCalled();
    } else {
      await expect(extractor.sourceLookup(source)).rejects.toThrow("complete readiness checkpoint");
      expect(checkpoints.getStage).toHaveBeenCalledOnce();
    }
    await expect(extractor.generateDocuments(source.document)).rejects.toThrow("Extraction is forbidden");
    expect(fetch).not.toHaveBeenCalled();
  });
});

function recovery(attempts=4) {
  const request={accountId:"account",sourceId:"6",jobId:"replay",containerName:"results",containerPath:"source.md",
    documentName:"source.md",sourceUrl:"https://example.test/source",identifier:"source.md",filepath:"source.md",
    progressPartition:"progress",progressRow:"1:1",cleanupBlobs:[{containerName:"results",containerPath:"source.md"}],
    eventOrder:{enqueuedTicks:"100",partitionId:"0",sequenceNumber:"1"}};
  let record:EvidenceWorkRecord={request,status:"extracted",attempts,extractionMode:"thorough",
    retryBudget:{pagesPerGroup:20,retriesPerGroup:3,pageCount:1,maxAttempts:4}};
  let receipt:{indexes:string[]}|null=null;
  const work:EvidenceJobStore={
    get:vi.fn(async()=>structuredClone(record)),enqueue:vi.fn(async()=>{}),
    indexResult:vi.fn(async()=>receipt),saveIndexResult:vi.fn(async(_id,value)=>{receipt=value;}),
    documents:vi.fn(async()=>[]),saveDocuments:vi.fn(async()=>{}),removeDocuments:vi.fn(async()=>{}),
    withLease:vi.fn(async(_id,apply)=>{
      if(record.status==="completed")return false;
      await apply(structuredClone(record),async value=>{record=structuredClone(value);},()=>{});
      return true;
    }),
  };
  const operations:EvidenceJobOperations={resolveMode:vi.fn(async()=>"thorough"),
    extract:vi.fn(async()=>{throw new Error("Unexpected extraction");}),
    index:vi.fn(async()=>"SUCCESS"),publishCleanup:vi.fn(async()=>{})};
  const savedReceipt=vi.fn(async(receipt:unknown)=>receipt);
  const complete=vi.fn(async(indexed:unknown)=>{await savedReceipt(indexed);await processEvidenceJob(request,work,operations);});
  const checkOpen=vi.fn(async()=>{}),controller=new AbortController();
  return {request,work,operations,savedReceipt,complete,checkOpen,controller,
    options:{work,jobId:request.jobId,checkOpen,signal:controller.signal,complete}};
}

describe("receipt recovery before processing attempts",()=>{
  it.each([3,4])("waits for the accepted upload at attempt %s, then completes without spending an attempt",async attempts=>{
    const f=recovery(attempts);
    const receipt={indexes:["test-index"]};
    const pause=vi.fn(async()=>{
      expect(await f.work.get(f.request.jobId)).toMatchObject({status:"extracted",attempts});
      expect(f.work.enqueue).not.toHaveBeenCalled();
      expect(f.work.withLease).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
      await f.work.saveIndexResult(f.request.jobId,receipt);
    });
    await resumeReplayIndexing({...f.options,pause});
    expect(pause).toHaveBeenCalledOnce();
    expect(f.savedReceipt).toHaveBeenCalledWith(receipt);
    expect(f.operations.extract).not.toHaveBeenCalled();
    expect(f.operations.publishCleanup).toHaveBeenCalledOnce();
    expect(await f.work.get(f.request.jobId)).toMatchObject({status:"completed",attempts});
  });

  it("times out without processing the job, consuming attempts, or recording completion",async()=>{
    const f=recovery();let now=0;
    await expect(resumeReplayIndexing({...f.options,timeoutMs:20,pollMs:10,now:()=>now,
      pause:async(ms:number)=>{now+=ms;}})).rejects.toThrow("recovery deadline");
    expect(await f.work.get(f.request.jobId)).toMatchObject({status:"extracted",attempts:4});
    expect(f.work.enqueue).not.toHaveBeenCalled();
    expect(f.work.withLease).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("leaves attempts untouched when cancelled during polling",async()=>{
    const f=recovery();
    await expect(resumeReplayIndexing({...f.options,
      pause:async()=>{f.controller.abort(new Error("cancelled"));}})).rejects.toThrow("cancelled");
    expect(await f.work.get(f.request.jobId)).toMatchObject({status:"extracted",attempts:4});
    expect(f.work.withLease).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });

  it.each(["source replaced","account purged","job stopped"])("does not publish a receipt if %s during its read",async reason=>{
    const f=recovery();
    vi.mocked(f.work.indexResult).mockImplementation(async()=>{
      f.checkOpen.mockRejectedValue(new Error(reason));
      return {indexes:["test-index"]};
    });
    await expect(resumeReplayIndexing(f.options)).rejects.toThrow(reason);
    expect(await f.work.get(f.request.jobId)).toMatchObject({status:"extracted",attempts:4});
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.work.withLease).not.toHaveBeenCalled();
  });

  it.each(["missing","queued"])("rejects a %s job without starting extraction or indexing",async state=>{
    const f=recovery();
    vi.mocked(f.work.get).mockResolvedValue(state==="missing" ? null : {request:f.request,status:"queued",attempts:0});
    await expect(resumeReplayIndexing(f.options)).rejects.toThrow("requires an extracted or completed");
    expect(f.work.indexResult).not.toHaveBeenCalled();
    expect(f.work.enqueue).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });
});
