import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {Document} from "@langchain/core/documents";
import {EvidenceExtractor} from "../src/processors/evidence/evidenceExtractor.js";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.js";
import {EvidenceReconciliationTimeoutError,assertReconciliationActive,reconciliationSignal,
  withReconciliationDeadline,reconciliationCheckpointGuard} from "../src/processors/evidence/evidenceReconciliationDeadline.js";
import {telemetryClient} from "../src/processors/appInsights.js";

const mocks=vi.hoisted(()=>({agent:vi.fn()}));
vi.mock("langchain",async original=>({...await original<typeof import("langchain")>(),createAgent:mocks.agent}));
vi.mock("@langchain/openai",()=>({ChatOpenAI:class {}}));
vi.mock("../src/processors/appInsights.js",()=>({telemetryClient:{trackEvent:vi.fn(),trackException:vi.fn()}}));

const source=new EvidenceSource(new Document({pageContent:"Alex signed the agreement.",metadata:{pages:[1]}}));
const candidate={id:"one",kind:"event",extractedBy:["primary"],item:{
  what:"Alex signed the agreement.",sourceQuote:"Alex signed the agreement.",supportingQuotes:[],
  who:["Alex"],where:"Unknown",why:"Unknown",eventType:"other",facets:[],
  whenStartedYear:null,whenStartedMonth:null,whenStartedDay:null,whenStartedSeason:null,whenStartedQuarter:null,
  whenEndedYear:null,whenEndedMonth:null,whenEndedDay:null,whenEndedSeason:null,whenEndedQuarter:null,
}};
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

beforeEach(()=>{
  vi.useFakeTimers();vi.clearAllMocks();
  vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT","https://test.services.ai.azure.com");
  vi.stubEnv("AZURE_OPENAI_LLM_API_KEY","test");
  vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME","review-test");
  vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK","independent");
  vi.stubEnv("EVIDENCE_RECONCILIATION_TIMEOUT_MS","300000");
  vi.stubEnv("EVIDENCE_SPECIALIST_MODE","off");
  vi.stubEnv("EVIDENCE_EVENT_STRUCTURE_MODE","off");
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});

describe("thorough reconciliation deadlines",()=>{
  it("shares five minutes across repair and fallback invocations",async()=>{
    const signals:AbortSignal[]=[];
    let calls=0;
    mocks.agent.mockImplementation(()=>({invoke:async(_input:unknown,options:{signal:AbortSignal})=>{
      signals.push(options.signal);
      if(++calls<=2){
        await sleep(90_000);
        return {structuredResponse:{decisions:[{candidateId:"one",verdict:"supported",keepOriginal:false,
          reason:"Proposed replacement with an invalid quotation.",events:[{...candidate.item,sourceQuote:"A missing quote."}],
          facts:[],claims:[],corrections:[]}]}};
      }
      return new Promise(()=>{}); // Provider deliberately ignores cancellation.
    }}));
    const extractor=new EvidenceExtractor("account","source");
    const run=(extractor as any).reviewer.reconcile([candidate],source,source.windows()[0],"batch-1");
    const failure=run.catch((error:unknown)=>error);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(calls).toBe(3);
    expect(signals.every(signal=>signal===signals[0])).toBe(true);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await failure).toBeInstanceOf(EvidenceReconciliationTimeoutError);
    expect(signals[0].aborted).toBe(true);
    expect(calls).toBe(3);
    expect(telemetryClient.trackEvent).toHaveBeenCalledWith(expect.objectContaining({name:"evidenceExtractor.reconciliationTimedOut",
      properties:expect.objectContaining({batchId:"batch-1",timeoutMs:"300000",page:"1"})}));
  });

  it("does not save a late provider result after timeout",async()=>{
    let finish:(value:unknown)=>void=()=>{};
    mocks.agent.mockReturnValue({invoke:()=>new Promise(resolve=>{finish=resolve;})});
    const store={getStage:vi.fn(async()=>null),putStage:vi.fn()};
    const extractor=new EvidenceExtractor("account","source",undefined,store as any);
    const context={identity:{accountId:"account",sourceId:"source",runFingerprint:"frozen"},windowIndex:0};
    const run=(extractor as any).reviewer.reconcile([candidate],source,source.windows()[0],"batch-1",undefined,true,context);
    const failure=run.catch((error:unknown)=>error);
    await vi.advanceTimersByTimeAsync(300_000);expect(await failure).toBeInstanceOf(EvidenceReconciliationTimeoutError);
    finish({structuredResponse:{decisions:[{candidateId:"one",verdict:"supported",keepOriginal:true,
      reason:"",events:[],facts:[],claims:[],corrections:[]}]}});
    await vi.advanceTimersByTimeAsync(1);
    expect(store.putStage).not.toHaveBeenCalled();
    expect(mocks.agent).toHaveBeenCalledOnce();
  });

  it("passes the deadline guard to persistence and emits no saved event for a late upload",async()=>{
    let finish!:()=>void;
    const store={getStage:vi.fn(async()=>null),putStage:vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}))};
    const extractor=new EvidenceExtractor("account","source",undefined,store as any) as any;
    const context={identity:{accountId:"account",sourceId:"source",runFingerprint:"frozen"},windowIndex:0};
    const failed=withReconciliationDeadline(100,()=>extractor.stages.save(context,source,source.windows()[0],"test",{},{}),vi.fn()).catch(error=>error);
    await vi.advanceTimersByTimeAsync(0);
    const guard=(store.putStage.mock.calls[0] as unknown[])[4] as {abortSignal:AbortSignal};
    expect(guard.abortSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(await failed).toBeInstanceOf(EvidenceReconciliationTimeoutError);
    expect(guard.abortSignal.aborted).toBe(true);
    finish();await vi.advanceTimersByTimeAsync(0);
    expect(telemetryClient.trackEvent).not.toHaveBeenCalledWith(expect.objectContaining({name:"evidenceExtractor.stageSaved"}));
  });

  it("rejects publication from a scope that already failed before its deadline",async()=>{
    let guard:ReturnType<typeof reconciliationCheckpointGuard>;
    await expect(withReconciliationDeadline(100,async()=>{
      guard=reconciliationCheckpointGuard();throw new Error("model failed");
    },vi.fn())).rejects.toThrow("model failed");
    expect(guard!.abortSignal.aborted).toBe(false);
    expect(()=>guard!.deferPublication("late",vi.fn())).toThrow("scope has already closed");
  });

  it("returns a permit received after a queued batch has timed out without invoking a model",async()=>{
    let grant:(locked:boolean)=>void=()=>{};
    const semaphore={acquire:()=>new Promise<boolean>(resolve=>{grant=resolve;}),release:vi.fn()};
    const extractor=new EvidenceExtractor("account","source",semaphore);
    const run=(extractor as any).reviewer.reconcile([candidate],source,source.windows()[0]);
    const failure=run.catch((error:unknown)=>error);
    await vi.advanceTimersByTimeAsync(300_000);expect(await failure).toBeInstanceOf(EvidenceReconciliationTimeoutError);
    grant(true);await vi.advanceTimersByTimeAsync(1);
    expect(semaphore.release).toHaveBeenCalledOnce();
    expect(mocks.agent).not.toHaveBeenCalled();
  });

  it("keeps concurrent deadlines independent and blocks late nested work",async()=>{
    let expired:AbortSignal|undefined;
    let other:AbortSignal|undefined;
    const first=withReconciliationDeadline(100,async()=>{
      expired=reconciliationSignal();await sleep(200);assertReconciliationActive();
    },vi.fn());
    const failure=first.catch(error=>error);
    const second=withReconciliationDeadline(300,async()=>{
      other=reconciliationSignal();await sleep(250);assertReconciliationActive();return "done";
    },vi.fn());
    await vi.advanceTimersByTimeAsync(100);expect(await failure).toBeInstanceOf(EvidenceReconciliationTimeoutError);
    expect(expired?.aborted).toBe(true);expect(other?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(150);expect(await second).toBe("done");
    expect(reconciliationSignal()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["0","-1","NaN","1.5","2147483648"])("rejects invalid thorough timeout %s",value=>{
    vi.stubEnv("EVIDENCE_RECONCILIATION_TIMEOUT_MS",value);
    expect(()=>new EvidenceExtractor("account","source")).toThrow("EVIDENCE_RECONCILIATION_TIMEOUT_MS");
    expect(()=>new EvidenceExtractor("account","source",undefined,undefined,undefined,"fast")).not.toThrow();
  });
});
