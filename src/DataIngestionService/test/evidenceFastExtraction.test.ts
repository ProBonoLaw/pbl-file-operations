import { Document } from "@langchain/core/documents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceExtractor, EvidenceStructuredResponseError, type EventExtractionResponse } from "../src/processors/evidence/evidenceExtractor.js";
import { StructuredOutputParsingError } from "langchain";
import { EvidenceReviewPending, withEvidenceReviewDispatcher, type EvidenceReviewTask } from "../src/processors/evidence/evidenceAsync.js";
import { evidenceTaskHarness } from "./helpers/evidenceTaskHarness.js";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.js";
import { telemetryClient } from "../src/processors/appInsights.js";
import type { EvidenceCheckpointStore } from "../src/processors/evidence/evidenceCheckpoint.js";
import { FastReviewSchema } from "../src/processors/evidence/evidenceFastReview.js";
import { toJsonSchema } from "@langchain/core/utils/json_schema";

const mocks=vi.hoisted(()=>({agent:vi.fn(),model:vi.fn(),anthropic:vi.fn()}));
vi.mock("langchain",async original=>({...await original<typeof import("langchain")>(),createAgent:mocks.agent}));
vi.mock("@langchain/openai",()=>({ChatOpenAI:class {model:string;constructor(options:any){this.model=options.model;mocks.model(options);}}}));
vi.mock("@langchain/anthropic",()=>({ChatAnthropic:class {model:string;constructor(options:any){this.model=options.model;mocks.anthropic(options);}}}));
vi.mock("../src/processors/appInsights.js",()=>({telemetryClient:{trackEvent:vi.fn(),trackException:vi.fn()}}));
const text="Alex signed the agreement.";
const item=(quote=text):EventExtractionResponse=>({
  what:quote,who:["Alex"],where:"Unknown",why:"Unknown",eventType:"other",facets:[],sourceQuote:quote,supportingQuotes:[],
  whenStartedYear:null,whenStartedMonth:null,whenStartedDay:null,whenStartedSeason:null,whenStartedQuarter:null,
  whenEndedYear:null,whenEndedMonth:null,whenEndedDay:null,whenEndedSeason:null,whenEndedQuarter:null,
});
const document=()=>new Document({pageContent:text,metadata:{pages:[1],sourceId:"source",title:"Test source"}});
function extractor(store?:EvidenceCheckpointStore) {
  return new EvidenceExtractor("account","source",undefined,store,undefined,"fast");
}
async function sonnetFallback() {
  vi.stubEnv("EVIDENCE_FAST_FALLBACK","independent");
  vi.stubEnv("EVIDENCE_FAST_FALLBACK_DEPLOYMENT_NAME","research-claude-sonnet-5-5");
  vi.stubEnv("EVIDENCE_FAST_FALLBACK_PROVIDER","anthropic");
  const store={get:vi.fn(async()=>null),put:vi.fn(async()=>{})} as unknown as EvidenceCheckpointStore;
  const fast=extractor(store),doc=document();
  const identity=await fast.checkpointIdentity(new EvidenceSource(doc));
  const task:EvidenceReviewTask={version:1,component:"fast-window",context:{identity:identity!,windowIndex:0},
    batchId:"sonnet-repair",candidates:[],initialReviewer:"reconciliation",allowFailover:true};
  return {run:()=>fast.executeReviewTask(task,doc,true),store};
}
const supported=(candidateId:string,overrides:Record<string,unknown>={})=>({candidateId,verdict:"supported",reason:"",
  clearFields:[],useSourceWording:false,citationIds:[],...overrides});
function agents(extract=(source:any)=>({events:[item(source.target.text)],facts:[],claims:[]}),
  review=(input:any)=>({decisions:input.candidates.map((c:any)=>supported(c.id))})) {
  const invoke=vi.fn(async (systemPrompt:string,input:any)=>({structuredResponse:systemPrompt.includes("FAST EXTRACTOR:")
    ? extract(input):review(input)}));
  mocks.agent.mockImplementation(({systemPrompt,tools}:any)=>{
    expect(tools).toEqual([]);
    return {invoke:async({messages}:any,options:any)=>{
      expect(options.recursionLimit).toBe(4);expect(options.signal).toBeInstanceOf(AbortSignal);
      return invoke(systemPrompt,JSON.parse(messages[0].content));
    }};
  });
  return invoke;
}
function delayedAgents(durationMs:number) {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal,"timeout").mockImplementation(timeoutMs=>{
    const controller=new AbortController();
    setTimeout(()=>controller.abort(new DOMException("Fast invocation timed out","TimeoutError")),timeoutMs);
    return controller.signal;
  });
  mocks.agent.mockImplementation(({systemPrompt}:any)=>({
    invoke:({messages}:any,{signal}:any)=>new Promise((resolve,reject)=>{
      const input=JSON.parse(messages[0].content);
      const timer=setTimeout(()=>{
        signal.removeEventListener("abort",abort);
        resolve({structuredResponse:systemPrompt.includes("FAST EXTRACTOR:")
          ? {events:[item(input.target.text)],facts:[],claims:[]}
          : {decisions:input.candidates.map((c:any)=>supported(c.id))}});
      },durationMs);
      function abort(){clearTimeout(timer);reject(signal.reason);}
      signal.addEventListener("abort",abort,{once:true});
    }),
  }));
}
beforeEach(()=>{
  vi.clearAllMocks();
  vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT","https://test.services.ai.azure.com");
  vi.stubEnv("AZURE_OPENAI_LLM_API_KEY","test");
  vi.stubEnv("EVIDENCE_FAST_DEPLOYMENT_NAME","fast-test");
  vi.stubEnv("EVIDENCE_FAST_TIMEOUT_MS","");
  vi.stubEnv("EVIDENCE_FAST_FALLBACK","off");
  vi.stubEnv("EVIDENCE_FAST_WINDOW_MAX_ATTEMPTS","3");
  vi.stubEnv("EVIDENCE_PRIMARY_DEPLOYMENT_NAME","primary-test");
  vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME","independent-test");
  vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK","off");
  vi.stubEnv("EVIDENCE_SPECIALIST_MODE","off");
  vi.stubEnv("EVIDENCE_EVENT_STRUCTURE_MODE","off");
  vi.stubEnv("AZURE_OPENAI_REASONING","high");
});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();vi.useRealTimers();});

describe("bounded fast evidence extraction",()=>{
  it("visits every nonempty page with one discovery and one review and preserves exact citations",async()=>{
    const invoke=agents();
    const source=new Document({pageContent:`${text}<!-- PageBreak -->\n<!-- PageBreak -->Alex sent the notice.`,metadata:{pages:[1,2,3],sourceId:"source"}});
    const results=await extractor().generateDocuments(source);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(results).toHaveLength(2);
    expect(results.map(d=>d.metadata.pages[0])).toEqual([1,3]);
    expect(results.every(d=>d.metadata.evidenceExtractionMode==="fast")).toBe(true);
    expect(results.every(d=>d.metadata.factType==="undatedOccurrence" && !d.metadata.tags.includes("event"))).toBe(true);
    for(const result of results)expect(source.pageContent).toContain(result.metadata.sourceQuote);
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(mocks.model).toHaveBeenCalledWith(expect.objectContaining({model:"fast-test",reasoning:{effort:"low"},maxRetries:0,timeout:120_000,maxTokens:8192}));
  });
  it("keeps a source-dated fast occurrence as an event",async()=>{
    const quote="Alex signed the agreement on 4 March 2025.";
    agents(()=>({events:[{...item(quote),whenStartedYear:"2025",whenStartedMonth:"3",whenStartedDay:"4"}],facts:[],claims:[]}));
    const [result]=await extractor().generateDocuments(new Document({pageContent:quote,metadata:{pages:[1],sourceId:"source"}}));
    expect(result.metadata.tags).toContain("event");
    expect(result.metadata.factType).toBeUndefined();
    expect(result.metadata.whenStarted).toMatchObject({year:"2025",month:"3",day:"4"});
  });
  it("allows discovery and review to each run past 60 seconds with independent two-minute deadlines",async()=>{
    delayedAgents(90_000);
    const result=expect(extractor().generateDocuments(document())).resolves.toHaveLength(1);
    await vi.advanceTimersByTimeAsync(180_000);
    await result;
    expect(AbortSignal.timeout).toHaveBeenCalledTimes(2);
    expect(AbortSignal.timeout).toHaveBeenNthCalledWith(1,120_000);
    expect(AbortSignal.timeout).toHaveBeenNthCalledWith(2,120_000);
  });
  it("uses a configured shorter timeout for the client and cancels an invocation that exceeds it",async()=>{
    vi.stubEnv("EVIDENCE_FAST_TIMEOUT_MS","30000");
    delayedAgents(90_000);
    const result=expect(extractor().generateDocuments(document())).rejects.toThrow("Fast invocation timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(mocks.model).toHaveBeenCalledWith(expect.objectContaining({timeout:30_000,maxRetries:0}));
    expect(AbortSignal.timeout).toHaveBeenCalledOnce();
    expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000);
  });
  it.each(["0","-1","1.5","invalid","2147483648"])("rejects invalid fast timeout %s before model work",value=>{
    vi.stubEnv("EVIDENCE_FAST_TIMEOUT_MS",value);
    expect(()=>extractor()).toThrow("EVIDENCE_FAST_TIMEOUT_MS");
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.agent).not.toHaveBeenCalled();
  });
  it("keeps the missing-output retry within its original invocation deadline",async()=>{
    delayedAgents(90_000);
    const valid=mocks.agent.getMockImplementation()!;let first=true;
    mocks.agent.mockImplementation((options:any)=>{
      const agent=valid(options) as any;
      return {invoke:async(input:any,config:any)=>{
        const response=await agent.invoke(input,config);
        if(first){first=false;return {structuredResponse:undefined};}return response;
      }};
    });
    const result=expect(extractor().generateDocuments(document())).rejects.toThrow("Fast invocation timed out");
    await vi.advanceTimersByTimeAsync(120_000);await result;
    expect(AbortSignal.timeout).toHaveBeenCalledOnce();
  });
  it.each(["fast-extraction","fast-review"])("retries missing Sonnet %s output once and preserves citations",async(stage)=>{
    const fallback=await sonnetFallback();
    agents();const valid=mocks.agent.getMockImplementation()!;
    const signals:AbortSignal[]=[];
    mocks.agent.mockImplementation((options:any)=>{
      const agent=valid(options) as any;
      const extraction=options.systemPrompt.includes("FAST EXTRACTOR:");
      return {invoke:async(input:any,config:any)=>{
        if(extraction===(stage==="fast-extraction")) {
          signals.push(config.signal);
          if(signals.length===1)return {structuredResponse:undefined};
        }
        const result=await agent.invoke(input,config);
        return extraction ? {structuredResponse:{payload:JSON.stringify(result.structuredResponse)}} : result;
      }};
    });
    await expect(fallback.run()).resolves.toMatchObject({events:[{sourceQuote:text}],facts:[],claims:[]});
    expect(signals).toHaveLength(2);expect(signals[0]).toBe(signals[1]);
    expect(fallback.store.put).toHaveBeenCalledOnce();
    expect(vi.mocked(telemetryClient.trackEvent).mock.calls.filter(([e])=>e.name==="evidenceExtractor.missingStructuredResponseRetry"))
      .toEqual([[expect.objectContaining({properties:expect.objectContaining({model:"research-claude-sonnet-5-5",stage})})]]);
  });
  it.each(["null","parsing-error","raw-text"])("classifies exhausted missing Sonnet output (%s) without committing a checkpoint",async(outcome)=>{
    const fallback=await sonnetFallback();
    const cause=new StructuredOutputParsingError("providerStrategy",["Missing terminal response"]);
    const invoke=vi.fn(async(_input:any,options:any)=>{
      if(outcome==="parsing-error")throw cause;
      if(outcome==="raw-text")for(const cb of options.callbacks??[])await cb.handleLLMEnd?.({generations:[[{message:{
        content:"Completed without a structured object",response_metadata:{stop_reason:"end_turn"},
      }}]]},"run");
      return {structuredResponse:null};
    });
    mocks.agent.mockReturnValue({invoke});
    await expect(fallback.run()).rejects.toMatchObject({name:"EvidenceStructuredResponseError",reason:"missing",
      ...(outcome==="parsing-error"?{cause}:{})});
    expect(invoke).toHaveBeenCalledTimes(2);expect(fallback.store.put).not.toHaveBeenCalled();
    expect(vi.mocked(telemetryClient.trackEvent).mock.calls.find(([e])=>e.name==="evidenceExtractor.modelResponseFailed")![0].properties)
      .toMatchObject({reason:"missing",model:"research-claude-sonnet-5-5",page:"1"});
  });
  it("keeps the missing Sonnet fallback retry inside the original 120-second deadline",async()=>{
    const fallback=await sonnetFallback();
    delayedAgents(90_000);const valid=mocks.agent.getMockImplementation()!;
    const signals:AbortSignal[]=[];
    mocks.agent.mockImplementation((options:any)=>{
      const agent=valid(options) as any;
      return {invoke:async(input:any,config:any)=>{
        signals.push(config.signal);
        await agent.invoke(input,config);
        return {structuredResponse:undefined};
      }};
    });
    const result=expect(fallback.run()).rejects.toThrow("Fast invocation timed out");
    await vi.advanceTimersByTimeAsync(120_000);await result;
    expect(signals).toHaveLength(2);expect(signals[0]).toBe(signals[1]);
    expect(AbortSignal.timeout).toHaveBeenCalledOnce();expect(fallback.store.put).not.toHaveBeenCalled();
  });
  it.each(["refused","incomplete","truncated"])("does not retry %s Sonnet terminal output",async(outcome)=>{
    const fallback=await sonnetFallback();
    const invoke=vi.fn(async(_input:any,options:any)=>{
      for(const cb of options.callbacks??[])await cb.handleLLMEnd?.({generations:[[{message:{
        content:"",additional_kwargs:outcome==="refused"?{refusal:"Refused"}:{},
        response_metadata:{status:outcome==="incomplete"?"incomplete":"completed",
          stop_reason:outcome==="truncated"?"max_tokens":"end_turn"},
      }}]]},"run");
      return {structuredResponse:undefined};
    });
    mocks.agent.mockReturnValue({invoke});
    if(outcome==="truncated")await expect(fallback.run()).rejects.toThrow("output token limit");
    else await expect(fallback.run()).rejects.toMatchObject({name:"EvidenceStructuredResponseError",reason:outcome});
    expect(invoke).toHaveBeenCalledOnce();expect(fallback.store.put).not.toHaveBeenCalled();
  });
  describe.each(["openai","anthropic"])("%s content-filter responses",provider=>{
    it.each([
      ["finish_reason","captured"], ["stop_reason","captured"],
      ["finish_reason","parsing-error"], ["stop_reason","parsing-error"],
      ["finish_reason","returned"], ["stop_reason","returned"],
      ["incomplete_details","captured"], ["incomplete_details","parsing-error"],
    ])("classifies %s from %s without missing-output retries",async(field,transport)=>{
      const fallback=provider==="anthropic"?await sonnetFallback():null;
      const cause=new StructuredOutputParsingError("providerStrategy",["Missing filtered response"]);
      const metadata=field==="incomplete_details"
        ? {status:"incomplete",incomplete_details:{reason:"content_filter"}}
        : {[field]:"content_filter"};
      const message={content:"",response_metadata:metadata};
      const invoke=vi.fn(async(_input:any,options:any)=>{
        if(transport!=="returned")for(const cb of options.callbacks??[])
          await cb.handleLLMEnd?.({generations:[[{message}]]},"run");
        if(transport==="parsing-error")throw cause;
        return {structuredResponse:undefined,messages:[message]};
      });
      mocks.agent.mockReturnValue({invoke});
      await expect(fallback?fallback.run():extractor().generateDocuments(document())).rejects.toMatchObject({
        name:"EvidenceStructuredResponseError",reason:"content_filter",
        ...(transport==="parsing-error"?{cause}:{}),
      });
      expect(invoke).toHaveBeenCalledOnce();
      if(fallback)expect(fallback.store.put).not.toHaveBeenCalled();
      const events=vi.mocked(telemetryClient.trackEvent).mock.calls.map(([event])=>event);
      expect(events.some(event=>event.name==="evidenceExtractor.missingStructuredResponseRetry")).toBe(false);
      expect(events.find(event=>event.name==="evidenceExtractor.modelResponseFailed")?.properties)
        .toMatchObject({reason:"content_filter",page:"1",
          ...(field!=="incomplete_details"?{finishReason:"content_filter"}:{incompleteReason:"content_filter"})});
    });
    it("classifies a filtered missing-output retry without invoking the model again",async()=>{
      const fallback=provider==="anthropic"?await sonnetFallback():null;
      const invoke=vi.fn().mockResolvedValueOnce({structuredResponse:undefined})
        .mockResolvedValueOnce({structuredResponse:undefined,messages:[{response_metadata:{stop_reason:"content_filter"}}]});
      mocks.agent.mockReturnValue({invoke});
      await expect(fallback?fallback.run():extractor().generateDocuments(document())).rejects.toMatchObject({
        name:"EvidenceStructuredResponseError",reason:"content_filter",
      });
      expect(invoke).toHaveBeenCalledTimes(2);
      if(fallback)expect(fallback.store.put).not.toHaveBeenCalled();
    });
  });
  it("omits mismatched citations before review and uncertain candidates without repairing or failing the source",async()=>{
    const invoke=agents(()=>({events:[item(),item("A fabricated passage.")],facts:[],claims:[]}),
      input=>({decisions:input.candidates.map((c:any)=>supported(c.id,{verdict:"uncertain",reason:"Attribution unclear"}))}));
    expect(await extractor().generateDocuments(document())).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1].candidates).toHaveLength(1);
    const omissions=vi.mocked(telemetryClient.trackEvent).mock.calls.filter(([e])=>e.name==="evidenceExtractor.fastCandidateOmitted");
    expect(omissions.map(([e])=>e.properties?.reason)).toEqual(["citation-or-date","review-not-supported"]);
  });
  it("never accepts duplicate, missing, or foreign review decisions as support",async()=>{
    agents(undefined,input=>({decisions:[supported(input.candidates[0].id),
      supported(input.candidates[0].id,{verdict:"unsupported",reason:"Wrong participant"}),supported("foreign")]}));
    expect(await extractor().generateDocuments(document())).toEqual([]);
  });
  it("caps review candidates instead of cascading into additional review batches",async()=>{
    const invoke=agents(()=>({events:Array.from({length:25},()=>item()),facts:[],claims:[]}));
    await extractor().generateDocuments(document());
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1].candidates).toHaveLength(20);
  });
  it("retries a missing response once but never retries truncated output inside a fast pass",async()=>{
    const invoke=vi.fn(async()=>({structuredResponse:null,messages:[]}));
    mocks.agent.mockReturnValue({invoke});
    await expect(extractor().generateDocuments(document())).rejects.toMatchObject({name:"EvidenceStructuredResponseError",reason:"missing"});
    expect(invoke).toHaveBeenCalledTimes(2);
    invoke.mockResolvedValue({structuredResponse:null,messages:[{response_metadata:{finish_reason:"length"}}]} as any);
    await expect(extractor().generateDocuments(document())).rejects.toThrow("output token limit");
    expect(invoke).toHaveBeenCalledTimes(3);
  });
  it("recovers from a provider parsing failure without converting absent output into a ZodError",async()=>{
    const invoke=agents();
    const valid=mocks.agent.getMockImplementation()!;
    let missing=true;
    mocks.agent.mockImplementation((options:any)=>{
      const agent=valid(options) as any;
      return {invoke:async(input:any,config:any)=>{
        if(missing){missing=false;throw new StructuredOutputParsingError("providerStrategy",["Missing response"]);}
        return agent.invoke(input,config);
      }};
    });
    expect(await extractor().generateDocuments(document())).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(vi.mocked(telemetryClient.trackEvent).mock.calls.some(([e])=>e.name==="evidenceExtractor.missingStructuredResponseRetry")).toBe(true);
  });
  it.each(["refused","incomplete","invalid"])("reports %s provider output without retrying or logging its text",async(reason)=>{
    const invoke=vi.fn(async(_input:any,options:any)=>{
      for(const cb of options.callbacks??[])await cb.handleLLMEnd?.({generations:[[{message:{
        content:reason==="invalid"?"source secret text that is not JSON":"",
        additional_kwargs:reason==="refused"?{refusal:"source secret text"}:{},
        response_metadata:{id:"response-123",status:reason==="incomplete"?"incomplete":"completed",
          incomplete_details:reason==="incomplete"?{reason:"max_output_tokens"}:null},
      }}]]},"run");
      throw new StructuredOutputParsingError("providerStrategy",["Could not parse"]);
    });
    mocks.agent.mockReturnValue({invoke});
    await expect(extractor().generateDocuments(document())).rejects.toMatchObject({name:"EvidenceStructuredResponseError",reason});
    expect(invoke).toHaveBeenCalledOnce();
    const event=vi.mocked(telemetryClient.trackEvent).mock.calls.find(([e])=>e.name==="evidenceExtractor.modelResponseFailed")![0];
    expect(event.properties).toMatchObject({reason,page:"1",providerResponseId:"response-123"});
    expect(JSON.stringify(event)).not.toContain("source secret text");
  });
  it("reports HTTP 429 and propagates Retry-After for durable window backoff",async()=>{
    const error=Object.assign(new Error("Too Many Requests"),{status:429,headers:{"retry-after":"90"}});
    mocks.agent.mockReturnValue({invoke:vi.fn(async()=>{throw error;})});
    await expect(extractor().generateDocuments(document())).rejects.toMatchObject({name:"EvidenceModelRateLimitError",retryAfterMs:90_000,status:429,cause:error});
    expect(vi.mocked(telemetryClient.trackEvent).mock.calls.find(([e])=>e.name==="evidenceExtractor.modelResponseFailed")![0].properties)
      .toMatchObject({httpStatus:"429",page:"1"});
  });
  it.each([
    ["independent-test","openai"],
    ["research-claude-sonnet-5-5","anthropic"],
  ])("queues all windows and repairs only an exhausted window with %s",async(deployment,provider)=>{
    vi.stubEnv("EVIDENCE_FAST_FALLBACK","independent");
    vi.stubEnv("EVIDENCE_FAST_FALLBACK_DEPLOYMENT_NAME",deployment);
    vi.stubEnv("EVIDENCE_FAST_FALLBACK_PROVIDER",provider);
    vi.stubEnv("EVIDENCE_FAST_WINDOW_MAX_ATTEMPTS","2");
    const h=evidenceTaskHarness();
    const windows=new Map<string,unknown>(),stages=new Map<string,unknown>();
    const key=(identity:any,index:number,stage="")=>`${identity.runFingerprint}:${index}:${stage}`;
    const store={get:async(identity:any,index:number)=>windows.get(key(identity,index))??null,
      put:async(identity:any,index:number,value:unknown)=>{windows.set(key(identity,index),value);},
      getStage:async(identity:any,index:number,stage:string)=>stages.get(key(identity,index,stage))??null,
      putStage:async(identity:any,index:number,stage:string,value:unknown)=>{stages.set(key(identity,index,stage),value);},
    } as unknown as EvidenceCheckpointStore;
    const source=new Document({pageContent:Array.from({length:8},(_,i)=>`Alex signed agreement ${i+1}.`).join("<!-- PageBreak -->"),metadata:{sourceId:"source"}});
    const dispatch=h.queue.dispatcher({accountId:"account",sourceId:"source",jobId:"job"});
    const coordinator=()=>withEvidenceReviewDispatcher(dispatch,()=>extractor(store).generateDocuments(source));
    const invocation=agents();const valid=mocks.agent.getMockImplementation()!;
    mocks.agent.mockImplementation((options:any)=>{
      const agent=valid(options) as any;
      return {invoke:async(input:any,config:any)=>{
        const payload=JSON.parse(input.messages[0].content);
        if(options.model.model==="fast-test"&&payload.target?.text==="Alex signed agreement 2.")
          throw new EvidenceStructuredResponseError("missing");
        const result=await agent.invoke(input,config);
        return provider==="anthropic" && options.model.model===deployment && options.systemPrompt.includes("FAST EXTRACTOR:")
          ? {structuredResponse:{payload:JSON.stringify(result.structuredResponse)}} : result;
      }};
    });
    await expect(coordinator()).rejects.toBeInstanceOf(EvidenceReviewPending);
    expect(h.records.size).toBe(8);expect(invocation).not.toHaveBeenCalled();
    const execute=async(record:any)=>extractor(store).executeReviewTask(record.definition.payload as EvidenceReviewTask,source,record.lane==="repair");
    for(const r of [...h.records.values()])await h.queue.process(r.id,"gather",execute);
    const failed=[...h.records.values()].find(r=>r.status==="pending")!;
    expect(failed.lane).toBe("gather");expect(failed.attempts).toBe(1);
    expect(windows.size).toBe(7);
    await expect(coordinator()).rejects.toBeInstanceOf(EvidenceReviewPending);
    h.advance(10_000);await h.queue.process(failed.id,"gather",execute);
    expect(h.records.get(failed.id)).toMatchObject({lane:"repair",attempts:0,status:"pending"});
    await h.queue.process(failed.id,"repair",execute);
    const docs=await coordinator();
    expect(docs).toHaveLength(8);expect(windows.size).toBe(8);
    expect(docs.find(d=>d.metadata.pages[0]===2)!.metadata.extractedBy).toContain(`fast-extraction:${deployment}`);
    if(provider==="anthropic")expect(mocks.anthropic).toHaveBeenCalledWith(expect.objectContaining({
      model:deployment,maxTokens:8192,maxRetries:0,
      clientOptions:{baseURL:"https://test.services.ai.azure.com/anthropic",timeout:120_000, fetch:expect.any(Function)},
    }));
    expect(docs.every(d=>source.pageContent.includes(d.metadata.sourceQuote))).toBe(true);
    expect(invocation).toHaveBeenCalledTimes(16); // Seven primary windows and one fallback, each discovery + review.
    expect([...h.records.values()].every(r=>r.status==="completed")).toBe(true);
  });
  it("keeps fast and thorough checkpoints separate and restores a completed fast window",async()=>{
    const saved=new Map<string,unknown>();
    const store={get:vi.fn(async(identity:any,index:number)=>saved.get(`${identity.runFingerprint}:${index}`)??null),
      put:vi.fn(async(identity:any,index:number,value:unknown)=>{saved.set(`${identity.runFingerprint}:${index}`,value);})} as unknown as EvidenceCheckpointStore;
    const invoke=agents();
    const fast=extractor(store);
    const source=new EvidenceSource(document());
    const fastKey=await (fast as any).checkpointIdentity(source);
    const thoroughKey=await (new EvidenceExtractor("account","source",undefined,store) as any).checkpointIdentity(source);
    expect(fastKey.runFingerprint).not.toBe(thoroughKey.runFingerprint);
    const first=await fast.generateDocuments(document());
    expect(await extractor(store).generateDocuments(document())).toEqual(first);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("resumes a failed review from its discovery checkpoint instead of treating a provider failure as empty evidence",async()=>{
    const stages=new Map<string,unknown>();
    const store={get:vi.fn(async()=>null),put:vi.fn(async()=>{}),
      getStage:vi.fn(async(_identity:unknown,index:number,stage:string)=>stages.get(`${index}:${stage}`)??null),
      putStage:vi.fn(async(_identity:unknown,index:number,stage:string,value:unknown)=>{stages.set(`${index}:${stage}`,value);}),
    } as unknown as EvidenceCheckpointStore;
    let failed=false;
    const invoke=agents(undefined,input=>{
      if(!failed){failed=true;throw new Error("provider unavailable");}
      return {decisions:input.candidates.map((c:any)=>supported(c.id))};
    });
    await expect(extractor(store).generateDocuments(document())).rejects.toThrow("provider unavailable");
    expect(store.put).not.toHaveBeenCalled();
    expect(await extractor(store).generateDocuments(document())).toHaveLength(1);
    expect(invoke.mock.calls.filter(([prompt])=>prompt.includes("FAST EXTRACTOR:"))).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("clears unsupported metadata in the existing review while preserving the assertion and citations",async()=>{
    const quote="Time constraints should be removed from tests.";
    const original={statement:quote,claimant:"Unknown",claimType:"opinion",polarity:"asserts",facets:[],
      who:["invented teacher"],where:"invented school",sourceQuote:quote,supportingQuotes:[],
      whenStartedYear:"2025",whenStartedMonth:"2",whenStartedDay:"31",
      whenEndedYear:null,whenEndedMonth:null,whenEndedDay:null};
    const invoke=agents(()=>({events:[],facts:[],claims:[original]} as any),input=>({decisions:[
      supported(input.candidates[0].id,{clearFields:["who","where","whenStarted"],reason:"The recommendation names no actor, place or date."})]}));
    const source=new Document({pageContent:quote,metadata:{pages:[1],sourceId:"source"}});
    const results=await extractor().generateDocuments(source);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1].candidates[0].dateValidationErrors.length).toBeGreaterThan(0);
    expect(results).toHaveLength(1);
    expect(results[0].metadata).toMatchObject({what:quote,claimant:"Unknown",who:[],where:"Unknown",
      whenStarted:{year:null,month:null,day:null},sourceQuote:quote});
    expect(original.who).toEqual(["invented teacher"]);
    expect(vi.mocked(telemetryClient.trackEvent).mock.calls.some(([e])=>e.name==="evidenceExtractor.fastCandidateAdjusted")).toBe(true);
  });

  it("restores exact source wording and clears a neighboring event's date without accepting a rewritten quote",async()=>{
    const quote="Legal action followed.";
    const original={...item(quote),what:"Legal action followed in March 2025.",whenStartedYear:"2025",whenStartedMonth:"3",whenStartedDay:"4",who:[],why:"Unstated cause"};
    const invoke=agents(()=>({events:[original],facts:[],claims:[]}),input=>({decisions:[
      supported(input.candidates[0].id,{clearFields:["whenStarted","why"],useSourceWording:true,reason:"Only the incident is dated; the action's date and cause are unstated."})]}));
    const source=new Document({pageContent:`An incident occurred on March 4, 2025. ${quote}`,metadata:{pages:[1],sourceId:"source"}});
    const results=await extractor().generateDocuments(source);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(results[0].metadata).toMatchObject({what:quote,sourceQuote:quote,why:"Unknown",whenStarted:{year:null,month:null,day:null}});
    expect(results[0].metadata.factType).toBe("undatedOccurrence");
    expect(results[0].metadata.tags).not.toContain("event");
    expect(results[0].pageContent).not.toContain("2025");
  });

  it("preserves a supported recommendation by clearing incorrect optional taxonomy facets",async()=>{
    const quote="Written expression should be addressed explicitly.";
    const original={statement:quote,claimant:"Unknown",claimType:"opinion",polarity:"asserts",
      facets:[{namespace:"education",value:"readingInstruction"}],who:[],where:"Unknown",sourceQuote:quote,supportingQuotes:[],
      whenStartedYear:null,whenStartedMonth:null,whenStartedDay:null,whenEndedYear:null,whenEndedMonth:null,whenEndedDay:null};
    const invoke=agents(()=>({events:[],facts:[],claims:[original]} as any),input=>({decisions:[
      supported(input.candidates[0].id,{clearFields:["facets"],reason:"The assertion concerns writing, so remove the incorrect reading taxonomy tag."})]}));
    const result=await extractor().generateDocuments(new Document({pageContent:quote,metadata:{pages:[1],sourceId:"source"}}));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0].metadata.what).toBe(quote);
    expect(result[0].metadata.tags).toContain("claim");
    expect(result[0].metadata.tags).not.toContain("facet:education:readingInstruction");
    expect(original.facets).toHaveLength(1);
  });

  it.each([
    {clearFields:["sourceQuote"]},
    {clearFields:["claimant"]},
    {clearFields:["claimType"]},
    {clearFields:["asOf"]},
    {clearFields:["who","who"]},
    {clearFields:["who"],reason:""},
    {what:"New unsupported assertion"},
    {sourceQuote:"New fabricated quote"},
    {verdict:"uncertain",clearFields:["who"],useSourceWording:true},
  ])("rejects invalid or unsupported fast adjustments instead of accepting the original: %j",async overrides=>{
    agents(undefined,input=>({decisions:[supported(input.candidates[0].id,{reason:"Test adjustment",...overrides})]}));
    expect(await extractor().generateDocuments(document())).toEqual([]);
  });

  it("rejects an invalid date that review leaves unchanged",async()=>{
    const invoke=agents(()=>({events:[{...item(),whenStartedYear:"2025",whenStartedMonth:"2",whenStartedDay:"31"}],facts:[],claims:[]}));
    expect(await extractor().generateDocuments(document())).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("removes unmentioned optional participants even when the model approves them",async()=>{
    const invoke=agents(()=>({events:[{...item(),who:["Alex","invented implementer"]}],facts:[],claims:[]}));
    const result=await extractor().generateDocuments(document());
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0].metadata.who).toEqual(["Alex"]);
    expect(result[0].metadata.what).toBe(text);
  });

  it("rejects an unmentioned participant that remains in the assertion itself",async()=>{
    agents(()=>({events:[{...item(),what:"Invented Person signed the agreement.",who:["Invented Person"]}],facts:[],claims:[]}));
    expect(await extractor().generateDocuments(document())).toEqual([]);
  });

  it("resolves a repeated quotation in the same review using only the offered exact occurrence",async()=>{
    const quote="Extra time is recommended.";
    const source=new Document({pageContent:`# Discussed\n${quote}\n# Agreed\n${quote}`,metadata:{pages:[1],sourceId:"source"}});
    const invoke=agents(()=>({events:[item(quote)],facts:[],claims:[]}),input=>({decisions:[
      supported(input.candidates[0].id,{citationIds:["cite:primary:1"],reason:"The second occurrence is in the Agreed section."})]}));
    const result=await extractor().generateDocuments(source);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1].candidates[0].citationChoices).toHaveLength(2);
    expect(result).toHaveLength(1);
    expect(result[0].metadata.sourceQuote).toContain("# Agreed");
    expect(result[0].metadata.sourceQuote).not.toContain("# Discussed");
    expect(source.pageContent.slice(result[0].metadata.sourceOffset)).toContain(result[0].metadata.sourceQuote);
  });

  it.each([{citationIds:[]},{citationIds:["invented"]},{citationIds:["cite:primary:0","cite:primary:1"]}])("never guesses an unresolved or invalid citation selection: %j",async ({citationIds})=>{
    const quote="Alex signed.";
    const source=new Document({pageContent:`# First\n${quote}\n# Second\n${quote}`,metadata:{pages:[1],sourceId:"source"}});
    const invoke=agents(()=>({events:[item(quote)],facts:[],claims:[]}),input=>({decisions:[
      supported(input.candidates[0].id,{citationIds,reason:"Test selection"})]}));
    expect(await extractor().generateDocuments(source)).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("uses an explicitly cited heading to resolve a repeated quote and retains short source wording",async()=>{
    const quote="Alex signed.";
    const source=new Document({pageContent:`# First\n${quote}\n# Second\n${quote}`,metadata:{pages:[1],sourceId:"source"}});
    const invoke=agents(()=>({events:[{...item(quote),supportingQuotes:[{pageNumber:1,quote:"# Second"}]}],facts:[],claims:[]}),input=>({decisions:[
      supported(input.candidates[0].id,{useSourceWording:true,reason:"Use the original source statement."})]}));
    const result=await extractor().generateDocuments(source);
    expect(invoke.mock.calls[1][1].candidates[0].citationChoices).toEqual([]);
    expect(result[0].metadata.what).toBe(quote);
    expect(result[0].metadata.sourceQuote).toContain("# Second");
    expect(result[0].metadata.sourceQuote).not.toContain("# First");
  });

  it("keeps the bounded review schema reference-free and forbids free-text replacements",()=>{
    const schema=toJsonSchema(FastReviewSchema);
    expect(JSON.stringify(schema)).not.toContain('"$ref"');
    expect(Object.keys((schema.properties as any).decisions.items.properties)).toEqual([
      "candidateId","verdict","reason","clearFields","useSourceWording","citationIds"]);
  });
});
