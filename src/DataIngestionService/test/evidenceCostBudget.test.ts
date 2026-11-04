import {BlobServiceClient} from "@azure/storage-blob";
import * as storage from "../src/storage.js";
import {afterEach, describe, expect, it, vi} from "vitest";
import {EvidenceCostBudget, evidenceBudgetConfig, selectedEvidenceBudget, tokenCostMicros,
  budgetErrorCode, BlobBudgetLedgerStore, type BudgetLedger, type BudgetLedgerStore} from "../src/processors/evidence/evidenceCostBudget.js";
import {budgetedEvidenceFetch} from "../src/processors/evidence/evidenceBudgetFetch.js";
import {withEvidenceTaskCancellation} from "../src/processors/evidence/evidenceAsync.js";
import {withRequestContext} from "../src/requestContext.js";
import {ChatOpenAI} from "@langchain/openai";
import {ChatAnthropic} from "@langchain/anthropic";
import {randomUUID} from "node:crypto";
import {AzureOpenAIEmbeddingsWithTelemetry} from "../src/processors/azureOpenAIEmbeddingsWithTelemetry.js";
import type {TelemetryClient} from "applicationinsights";

class MemoryLedger implements BudgetLedgerStore {
  values=new Map<string,{ledger:BudgetLedger;etag:string}>();
  version=0;
  async read(key:string){return structuredClone(this.values.get(key)??null);}
  async write(key:string,ledger:BudgetLedger,etag:string|null){
    if((this.values.get(key)?.etag??null)!==etag)return false;
    this.values.set(key,{ledger:structuredClone(ledger),etag:String(++this.version)});
    return true;
  }
  total(){return [...this.values.values()].reduce((n,{ledger})=>n+Object.values(ledger.entries).reduce((s,e)=>s+(e.chargedMicros??e.reservedMicros),0),0);}
  committed(){return [...this.values.values()].reduce((n,{ledger})=>n+Object.values(ledger.entries).reduce((s,e)=>s+(e.chargedMicros??0),0),0);}
}
const context={accountId:"account",sourceId:"391",jobId:"restart-1"};
const configuration=(limitUsd="1")=>({version:1,currency:"USD",validUntil:"2099-01-01T00:00:00Z",
  pricingSource:"https://prices.azure.com/api/retail/prices",
  limits:[{accountId:"account",sourceId:"391",budgetId:"restart-budget-1",limitUsd}],
  prices:[{origin:"https://models.test",deployment:"research",kind:"responses",inputUsdPerMillion:"1",outputUsdPerMillion:"4",maxInputTokens:1000,maxOutputTokens:1000},
    {origin:"https://models.test",deployment:"embedding",kind:"embeddings",inputUsdPerMillion:"1",outputUsdPerMillion:"0",maxInputTokens:1000,maxOutputTokens:0}]});
const selection=(limit="1")=>selectedEvidenceBudget(context,evidenceBudgetConfig(JSON.stringify(configuration(limit))))!;
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});

describe("durable evidence dollar budget",()=>{
  it("aborts an uncapped provider request when its queued job is stopped",async()=>{
    const controller=new AbortController();
    let started!:()=>void;
    const sent=new Promise<void>(resolve=>{started=resolve;});
    const transport=vi.fn<typeof fetch>(async(_input,init)=>{
      started();
      await new Promise<void>((_resolve,reject)=>init?.signal?.addEventListener("abort",()=>reject(init.signal?.reason),{once:true}));
      throw new Error("unreachable");
    });
    const send=budgetedEvidenceFetch({deployment:"research",provider:"openai"},transport);
    const call=withEvidenceTaskCancellation({signal:controller.signal,assertOpen:async()=>{
      controller.signal.throwIfAborted();
    }},()=>send("https://models.test/openai/v1/responses",{method:"POST"}));
    await sent;
    controller.abort(new Error("terminal sibling"));
    await expect(call).rejects.toThrow("terminal sibling");
    expect(transport).toHaveBeenCalledOnce();
  });
  it("admits concurrent workers atomically and never spends the same balance twice",async()=>{
    const store=new MemoryLedger();
    const results=await Promise.allSettled(Array.from({length:20},()=>new EvidenceCostBudget(store).reserve(selection(),250_000)));
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(4);
    expect(store.total()).toBe(1_000_000);
    expect(results.filter(r=>r.status==="rejected").every(r=>budgetErrorCode((r as PromiseRejectedResult).reason)==="evidence_budget_busy")).toBe(true);
  });
  it("retains reservations across process restarts and settles exactly once",async()=>{
    const store=new MemoryLedger();const first=new EvidenceCostBudget(store);
    const id=await first.reserve(selection(),800_000);
    const restarted=new EvidenceCostBudget(store);
    await expect(restarted.reserve(selection(),800_000)).rejects.toMatchObject({code:"evidence_budget_busy"});
    await restarted.settle(selection(),id,100_000);
    await restarted.settle(selection(),id,100_000);
    expect(store.total()).toBe(100_000);
    await expect(restarted.settle(selection(),id,0)).rejects.toMatchObject({code:"evidence_budget_configuration"});
    await expect(restarted.reserve(selection(),800_000)).resolves.toEqual(expect.any(String));
    expect(store.total()).toBe(900_000);
  });
  it("stops before a request exceeds $70 and keeps the stop durable",async()=>{
    const store=new MemoryLedger();const budget=new EvidenceCostBudget(store),scope=selection("70");
    const id=await budget.reserve(scope,65_000_000);await budget.settle(scope,id,65_000_000);
    await expect(budget.reserve(scope,6_000_000)).rejects.toMatchObject({code:"evidence_budget_exhausted"});
    await expect(new EvidenceCostBudget(store).reserve(scope,1)).rejects.toMatchObject({code:"evidence_budget_exhausted"});
    expect(store.total()).toBe(65_000_000);
  });
  it("isolates accounts and extraction sessions, preserving each ledger",async()=>{
    const store=new MemoryLedger(),budget=new EvidenceCostBudget(store),scope=selection();
    await budget.reserve(scope,900_000);
    await budget.reserve({...scope,scope:{...scope.scope,accountId:"other"}},900_000);
    await budget.reserve({...scope,scope:{...scope.scope,budgetId:"restart-budget-2"}},900_000);
    await budget.reserve({...scope,scope:{...scope.scope,sessionId:"restart-2"}},900_000);
    expect(store.values.size).toBe(4);
  });
  it("refuses configuration changes that would reset or raise an existing run's budget",async()=>{
    const store=new MemoryLedger(),budget=new EvidenceCostBudget(store);
    await budget.reserve(selection(),100_000);
    await expect(budget.reserve(selection("70"),100_000)).rejects.toMatchObject({code:"evidence_budget_configuration"});
  });
  it("fails closed on unavailable storage and a write whose acknowledgement was lost",async()=>{
    const store=new MemoryLedger();const write=store.write.bind(store);
    store.write=async(...args)=>{await write(...args);throw Error("Lost storage response");};
    await expect(new EvidenceCostBudget(store).reserve(selection(),500_000)).rejects.toMatchObject({code:"evidence_budget_unavailable"});
    expect(store.total()).toBe(500_000);
  });
  it("shares spending across retries of one session and resets for a new ingestion session",async()=>{
    const config=evidenceBudgetConfig(JSON.stringify(configuration()));
    const store=new MemoryLedger(),budget=new EvidenceCostBudget(store);
    await budget.reserve(selectedEvidenceBudget(context,config)!,600_000);
    await expect(budget.reserve(selectedEvidenceBudget({...context},config)!,600_000))
      .rejects.toMatchObject({code:"evidence_budget_busy"});
    await budget.reserve(selectedEvidenceBudget({...context,jobId:"new-event"},config)!,600_000);
    expect(store.values.size).toBe(2);
    expect(()=>selectedEvidenceBudget({accountId:"account",sourceId:"391"},config))
      .toThrow("session ID");
  });
  it("honors an explicit unbounded request override and a stopped-session fence",()=>{
    const config=evidenceBudgetConfig(JSON.stringify(configuration()));
    expect(selectedEvidenceBudget({...context,evidenceBudgetOverride:true},config)).toBeNull();
    vi.stubEnv("EVIDENCE_STOPPED_SESSION_IDS",JSON.stringify([context.jobId]));
    expect(()=>selectedEvidenceBudget({...context,evidenceBudgetOverride:true},config))
      .toThrow("stopped by an operator");
  });
  it("charges abandoned reservations in full instead of renewing a crashed worker's balance",async()=>{
    const store=new MemoryLedger();let now=0;
    const budget=new EvidenceCostBudget(store,()=>now),scope=selection();
    const id=await budget.reserve(scope,800_000);
    now=scope.config.reservationMaxAgeMs;
    await expect(budget.reserve(scope,800_000)).rejects.toMatchObject({code:"evidence_budget_exhausted"});
    await budget.settle(scope,id,1); // A late result does not undo the conservative stop.
    expect(store.total()).toBe(800_000);expect(store.committed()).toBe(800_000);
  });
  it("persists a stop before reporting usage beyond the reservation",async()=>{
    const store=new MemoryLedger(),budget=new EvidenceCostBudget(store),scope=selection();
    const id=await budget.reserve(scope,100_000);
    await expect(budget.settle(scope,id,100_001)).rejects.toMatchObject({code:"evidence_budget_configuration"});
    await expect(new EvidenceCostBudget(store).reserve(scope,1)).rejects.toMatchObject({code:"evidence_budget_exhausted"});
  });
  it("refuses a corrupt ledger balance",async()=>{
    const store=new MemoryLedger(),budget=new EvidenceCostBudget(store);
    const id=await budget.reserve(selection(),100_000);
    [...store.values.values()][0].ledger.entries[id].chargedMicros=200_000;
    await expect(budget.reserve(selection(),1)).rejects.toMatchObject({code:"evidence_budget_configuration"});
  });
  it("rounds fractional token costs upward without floating-point accumulation",()=>{
    expect(tokenCostMicros(1,"0.1")).toBe(1);
    expect(tokenCostMicros(10,"0.1")).toBe(1);
    expect(tokenCostMicros(1_000_000,"0.000001")).toBe(1);
    expect(tokenCostMicros(1_000_000,"15")).toBe(15_000_000);
  });
  it("rejects expired prices, duplicate scopes, and missing account/source identity",()=>{
    const config=configuration();config.validUntil="2000-01-01T00:00:00Z";
    expect(()=>selectedEvidenceBudget(context,evidenceBudgetConfig(JSON.stringify(config)))).toThrow("expired");
    const duplicate=configuration();duplicate.limits.push(duplicate.limits[0]);
    expect(()=>evidenceBudgetConfig(JSON.stringify(duplicate))).toThrow("configuration");
    expect(()=>selectedEvidenceBudget({sourceId:"391"},evidenceBudgetConfig(JSON.stringify(configuration())))).toThrow("account/source identity");
  });
  it("rejects category prices above the per-token reservation ceiling",()=>{
    const config=configuration();
    config.prices[0]={...config.prices[0],cacheReadUsdPerMillion:"2"} as typeof config.prices[0];
    expect(()=>evidenceBudgetConfig(JSON.stringify(config))).toThrow("configuration");
  });
});

describe("budgeted provider transport",()=>{
  function setup(transport:typeof fetch,limit="1") {
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(configuration(limit)));
    const store=new MemoryLedger();
    return {store,send:budgetedEvidenceFetch({deployment:"research",provider:"openai"},transport,new EvidenceCostBudget(store))};
  }
  const request=(extra:Record<string,unknown>={})=>({method:"POST",body:JSON.stringify({model:"research",input:"source text",...extra})});
  const response=(input=100,output=200)=>new Response(JSON.stringify({usage:{input_tokens:input,output_tokens:output,output_tokens_details:{reasoning_tokens:150}}}),{headers:{"content-type":"application/json"}});
  it("reserves before HTTP, imposes an output limit, and counts reasoning only once",async()=>{
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      expect(store.total()).toBe(5000);
      expect(JSON.parse(init!.body as string).max_output_tokens).toBe(1000);
      return response();
    });
    const {send,store}=setup(transport);
    const result=await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request()));
    expect(result.ok).toBe(true);expect(store.total()).toBe(900);expect(store.committed()).toBe(900);
    expect((await result.json()).usage.output_tokens).toBe(200);
  });
  it("never increases a caller's smaller output limit",async()=>{
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{expect(JSON.parse(init!.body as string).max_output_tokens).toBe(20);return response(10,10);});
    const {send}=setup(transport);
    await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request({max_output_tokens:20})));
  });
  it.each(["timeout","500","missing-usage","broken-json"])("charges the maximum after %s instead of releasing unproven spending",async failure=>{
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>{
      if(failure==="timeout")throw Error("Lost HTTP response");
      if(failure==="500")return new Response("failed",{status:500});
      if(failure==="broken-json")return new Response("{");
      return new Response("{}");
    });
    const {send,store}=setup(transport);
    await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request())).catch(()=>undefined);
    expect(store.total()).toBe(5000);expect(store.committed()).toBe(5000);
    expect(Object.values([...store.values.values()][0].ledger.entries)[0].settlementKind).toBe("maximum");
  });
  it("reserves for the submitted text instead of the model's full context and charges filtered input only",async()=>{
    const config=configuration("2");
    config.prices=[{origin:"https://models.test",deployment:"utility-model-router",kind:"router",
      inputUsdPerMillion:"10",outputUsdPerMillion:"30",routerFeeUsdPerMillion:"0.14",
      allowedModels:["gpt-5.6-sol"],maxInputTokens:1_050_000,maxOutputTokens:16_384}] as typeof config.prices;
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(config));
    const store=new MemoryLedger();
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(JSON.stringify({
      error:{code:"content_filter",message:"Prompt rejected"}}),{status:400}));
    const send=budgetedEvidenceFetch({deployment:"utility-model-router",provider:"openai"},transport,new EvidenceCostBudget(store));
    const request={method:"POST",body:JSON.stringify({model:"utility-model-router",input:"short text"})};
    const body={model:"utility-model-router",input:"short text",max_output_tokens:16_384};
    const inputBound=Buffer.byteLength(JSON.stringify(body),"utf8")*2+65_536;
    const inputCost=tokenCostMicros(inputBound,"10")+tokenCostMicros(inputBound,"0.14");
    for(let attempt=0;attempt<2;attempt++) {
      const response=await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request));
      expect(response.status).toBe(400);
    }
    expect(transport).toHaveBeenCalledTimes(2);
    expect(store.total()).toBe(inputCost*2);
    expect(Object.values([...store.values.values()][0].ledger.entries).every(entry=>
      entry.settlementKind==="rejected-input" && entry.reservedMicros<2_000_000)).toBe(true);
  });
  it("keeps the bounded output exposure for an unclassified HTTP 400",async()=>{
    const config=configuration("2");
    config.prices[0]={...config.prices[0],maxInputTokens:1_050_000,maxOutputTokens:16_384} as typeof config.prices[0];
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(config));
    const store=new MemoryLedger();
    const send=budgetedEvidenceFetch({deployment:"research",provider:"openai"},async()=>
      new Response(JSON.stringify({error:{code:"invalid_request_error"}}),{status:400}),new EvidenceCostBudget(store));
    await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request()));
    const entry=Object.values([...store.values.values()][0].ledger.entries)[0];
    expect(entry.settlementKind).toBe("maximum");
    expect(entry.chargedMicros).toBeGreaterThan(130_000);
    expect(entry.chargedMicros).toBeLessThan(150_000);
  });
  it("retains the full context bound when a request references server-side conversation state",async()=>{
    const config=configuration("1");
    config.prices[0]={...config.prices[0],maxInputTokens:1_050_000,maxOutputTokens:16_384} as typeof config.prices[0];
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(config));
    const transport=vi.fn<typeof fetch>();
    const send=budgetedEvidenceFetch({deployment:"research",provider:"openai"},transport,new EvidenceCostBudget(new MemoryLedger()));
    const response=await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",
      request({previous_response_id:"resp_earlier"})));
    expect(response.status).toBe(402);
    expect(transport).not.toHaveBeenCalled();
  });
  it("prices reported cache reads and writes separately while keeping a full-price reservation",async()=>{
    const config=configuration();
    config.prices[0]={...config.prices[0],inputUsdPerMillion:"4",outputUsdPerMillion:"10",
      uncachedInputUsdPerMillion:"2",cacheReadUsdPerMillion:"0.1",cacheWriteUsdPerMillion:"4"} as typeof config.prices[0];
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(config));
    const store=new MemoryLedger();
    const send=budgetedEvidenceFetch({deployment:"research",provider:"openai"},async()=>{
      expect(store.total()).toBe(14_000);
      return new Response(JSON.stringify({usage:{input_tokens:100,output_tokens:20,
        input_tokens_details:{cached_tokens:30,cache_write_tokens:40}}}));
    },new EvidenceCostBudget(store));
    await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request()));
    expect(store.total()).toBe(423);
    expect(Object.values([...store.values.values()][0].ledger.entries)[0].settlementKind).toBe("usage");
  });
  it("charges unclassified input at the ceiling when cache details are missing",async()=>{
    const config=configuration();
    config.prices[0]={...config.prices[0],uncachedInputUsdPerMillion:"0.5",
      cacheReadUsdPerMillion:"0.1"} as typeof config.prices[0];
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(config));
    const store=new MemoryLedger();
    const send=budgetedEvidenceFetch({deployment:"research",provider:"openai"},async()=>response(100,20),new EvidenceCostBudget(store));
    await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request()));
    expect(store.total()).toBe(180);
  });
  it("cannot send an SDK retry after its previous ambiguous request exhausted the budget",async()=>{
    const transport=vi.fn<typeof fetch>().mockRejectedValue(Error("Timeout"));
    const {send,store}=setup(transport,"0.005");
    await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request())).catch(()=>undefined);
    const next=await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request()));
    expect(next.status).toBe(402);expect((await next.json()).error.code).toBe("evidence_budget_exhausted");
    expect(transport).toHaveBeenCalledTimes(1);expect(store.total()).toBe(5000);
  });
  it("blocks before HTTP when a reservation cannot be durably acknowledged",async()=>{
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(configuration()));
    const store=new MemoryLedger();store.write=async()=>{throw Error("Storage down");};
    const transport=vi.fn<typeof fetch>();const send=budgetedEvidenceFetch({deployment:"research",provider:"openai"},transport,new EvidenceCostBudget(store));
    const result=await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request()));
    expect(result.status).toBe(402);expect(transport).not.toHaveBeenCalled();
  });
  it.each([{stream:true},{background:true},{n:2},{service_tier:"priority"},{tools:[{type:"web_search"}]},{input:[{type:"input_image",image_url:"https://example.test/image"}]}])("rejects unsupported billable requests %j before HTTP",async extra=>{
    const transport=vi.fn<typeof fetch>();const {send,store}=setup(transport);
    expect((await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request(extra)))).status).toBe(402);
    expect(transport).not.toHaveBeenCalled();expect(store.total()).toBe(0);
  });
  it("requires verified pricing for the exact endpoint/deployment",async()=>{
    const transport=vi.fn<typeof fetch>();const {send}=setup(transport);
    expect((await withRequestContext(context,()=>send("https://unpriced.test/openai/v1/responses",request()))).status).toBe(402);
    expect(transport).not.toHaveBeenCalled();
  });
  it("makes the real LangChain/OpenAI SDK preserve budget errors without provider retries",async()=>{
    const transport=vi.fn<typeof fetch>();const {send}=setup(transport,"0.001");
    const client=new ChatOpenAI({model:"research",apiKey:"unused",useResponsesApi:true,maxRetries:2,
      configuration:{baseURL:"https://models.test/openai/v1",fetch:send}});
    const error=await withRequestContext(context,()=>client.invoke("source text")).catch(error=>error);
    expect(budgetErrorCode(error)).toBe("evidence_budget_exhausted");
    expect(transport).not.toHaveBeenCalled();
  });
  it("blocks subsequent requests when a provider reports tokens beyond its advertised bound",async()=>{
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>response(1001,10));const {send,store}=setup(transport);
    const first=await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request()));
    expect((await first.json()).error.code).toBe("evidence_budget_configuration");
    const next=await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request()));
    expect((await next.json()).error.code).toBe("evidence_budget_exhausted");
    expect(transport).toHaveBeenCalledTimes(1);expect(store.total()).toBe(5000);
  });
  it("handles Request objects without bypassing the reservation",async()=>{
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_input,init)=>{
      expect(JSON.parse(init!.body as string).max_output_tokens).toBe(1000);return response();
    });
    const {send,store}=setup(transport);
    await withRequestContext(context,()=>send(new Request("https://models.test/openai/v1/responses",request())));
    expect(transport).toHaveBeenCalledOnce();expect(store.total()).toBe(900);
  });
  it("keeps the reservation if usage settlement storage is unavailable",async()=>{
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(configuration()));
    const store=new MemoryLedger();const write=store.write.bind(store);
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>{store.write=async()=>{throw Error("storage down");};return response();});
    const send=budgetedEvidenceFetch({deployment:"research",provider:"openai"},transport,new EvidenceCostBudget(store));
    const result=await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request()));
    expect((await result.json()).error.code).toBe("evidence_budget_unavailable");
    expect(store.total()).toBe(5000);store.write=write;
  });
  it("does not constrain a different account with the same source ID",async()=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(response());const {send,store}=setup(transport);
    await withRequestContext({...context,accountId:"other"},()=>send("https://models.test/openai/v1/responses",request()));
    expect(transport).toHaveBeenCalledTimes(1);expect(store.values.size).toBe(0);
    expect(JSON.parse(transport.mock.calls[0][1]!.body as string).max_output_tokens).toBeUndefined();
  });
  it("shares the job budget with embedding requests and reserves for every input",async()=>{
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(configuration()));
    const store=new MemoryLedger(),budget=new EvidenceCostBudget(store);
    const llm=budgetedEvidenceFetch({deployment:"research",provider:"openai"},async()=>response(),budget);
    await withRequestContext(context,()=>llm("https://models.test/openai/v1/responses",request()));
    const embeddings=budgetedEvidenceFetch({deployment:"embedding",provider:"openai"},async()=>{
      expect(store.total()).toBe(2900);return new Response(JSON.stringify({usage:{prompt_tokens:500},data:[]}));
    },budget);
    await withRequestContext(context,()=>embeddings("https://models.test/openai/deployments/embedding/embeddings",{method:"POST",body:JSON.stringify({input:["one","two"]})}));
    expect(store.values.size).toBe(1);expect(store.total()).toBe(1400);
  });
});

describe("pinned router and Anthropic budget transport",()=>{
  function setup(kind:"router"|"messages",transport:typeof fetch,limitUsd="1") {
    const price=kind==="router" ? {origin:"https://models.test",deployment:"utility-model-router",kind,
      inputUsdPerMillion:"10",outputUsdPerMillion:"30",routerFeeUsdPerMillion:"0.14",
      allowedModels:["gpt-5.6-sol-2026-07-09","gpt-5.6-terra-2026-07-09"],maxInputTokens:1000,maxOutputTokens:100}
      :{origin:"https://models.test",deployment:"research-claude-sonnet-5-5",kind,
        inputUsdPerMillion:"4",outputUsdPerMillion:"10",maxInputTokens:1000,maxOutputTokens:100};
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify({...configuration(limitUsd),prices:[price]}));
    const store=new MemoryLedger();
    const budget=new EvidenceCostBudget(store);
    const send=budgetedEvidenceFetch({deployment:price.deployment,provider:kind==="router"?"openai":"anthropic"},transport,budget);
    return {store,send};
  }
  it("charges a pinned router's worst-model price plus its per-input router fee",async()=>{
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      expect(JSON.parse(init!.body as string).max_output_tokens).toBe(100);
      expect(store.total()).toBe(13_140);
      return new Response(JSON.stringify({model:"gpt-5.6-terra-2026-07-09",usage:{input_tokens:100,output_tokens:20}}));
    });
    const {send,store}=setup("router",transport);
    const response=await withRequestContext(context,()=>send("https://models.test/api/projects/p/openai/v1/responses",
      {method:"POST",body:JSON.stringify({model:"utility-model-router",input:"source text"})}));
    expect(response.ok).toBe(true);
    expect(store.total()).toBe(1614);
  });
  it("applies the router fee to cached tokens while discounting their model input price",async()=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      model:"gpt-5.6-sol-2026-07-09",usage:{input_tokens:100,output_tokens:20,
        input_tokens_details:{cached_tokens:60,cache_write_tokens:20}}})));
    const {send,store}=setup("router",transport);
    const config=JSON.parse(process.env.EVIDENCE_COST_BUDGET_CONFIG!);
    Object.assign(config.prices[0],{uncachedInputUsdPerMillion:"8",cacheReadUsdPerMillion:"0.8",
      cacheWriteUsdPerMillion:"10"});
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(config));
    const result=await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",{
      method:"POST",body:JSON.stringify({model:"utility-model-router",input:"source text"})}));
    expect(result.ok).toBe(true);
    expect(store.total()).toBe(1022);
  });
  it("charges the ceiling for a router alias and blocks an unpinned model",async()=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({model:"utility-model-router",usage:{input_tokens:10,output_tokens:10}})))
      .mockResolvedValueOnce(new Response(JSON.stringify({model:"gpt-6-astra",usage:{input_tokens:10,output_tokens:10}})));
    const {send,store}=setup("router",transport);
    const request={method:"POST",body:JSON.stringify({model:"utility-model-router",input:"source text"})};
    expect((await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request))).ok).toBe(true);
    expect(store.total()).toBe(402);
    const second=await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request));
    expect((await second.json()).error.code).toBe("evidence_budget_configuration");
    expect(store.total()).toBe(13_542);
    const third=await withRequestContext(context,()=>send("https://models.test/openai/v1/responses",request));
    expect((await third.json()).error.code).toBe("evidence_budget_exhausted");
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("counts Anthropic cache writes and reads in the billed input bound",async()=>{
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      expect(JSON.parse(init!.body as string).max_tokens).toBe(100);
      expect(store.total()).toBe(5000);
      return new Response(JSON.stringify({usage:{input_tokens:20,cache_creation_input_tokens:30,
        cache_read_input_tokens:40,output_tokens:10}}));
    });
    const {send,store}=setup("messages",transport);
    const result=await withRequestContext(context,()=>send("https://models.test/anthropic/v1/messages",{method:"POST",
      body:JSON.stringify({model:"research-claude-sonnet-5-5",max_tokens:200,messages:[{role:"user",content:"source text"}]})}));
    expect(result.ok).toBe(true);expect(store.total()).toBe(460);
  });
  it("prices Anthropic input, cache creation, cache reads and output at their configured rates",async()=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({usage:{
      input_tokens:20,cache_creation_input_tokens:30,cache_read_input_tokens:40,output_tokens:10}})));
    const {send,store}=setup("messages",transport);
    const config=JSON.parse(process.env.EVIDENCE_COST_BUDGET_CONFIG!);
    Object.assign(config.prices[0],{uncachedInputUsdPerMillion:"2",cacheReadUsdPerMillion:"0.1",
      cacheWriteUsdPerMillion:"4"});
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(config));
    await withRequestContext(context,()=>send("https://models.test/anthropic/v1/messages",{method:"POST",
      body:JSON.stringify({model:"research-claude-sonnet-5-5",messages:[{role:"user",content:"text"}]})}));
    expect(store.total()).toBe(264);
  });
  it("keeps the full Anthropic reservation when cache usage is incomplete",async()=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({usage:{input_tokens:20,output_tokens:10}})));
    const {send,store}=setup("messages",transport);
    const result=await withRequestContext(context,()=>send("https://models.test/anthropic/v1/messages",{method:"POST",
      body:JSON.stringify({model:"research-claude-sonnet-5-5",messages:[{role:"user",content:"text"}]})}));
    expect(result.ok).toBe(true);expect(store.total()).toBe(5000);
  });
  it("blocks server-side Anthropic tools and media before HTTP",async()=>{
    const transport=vi.fn<typeof fetch>();const {send,store}=setup("messages",transport);
    for(const extra of [{tools:[{type:"web_search_20250305",name:"web_search"}]},
      {messages:[{role:"user",content:[{type:"image",source:{type:"url",url:"https://example.test"}}]}]}]) {
      const result=await withRequestContext(context,()=>send("https://models.test/anthropic/v1/messages",{method:"POST",
        body:JSON.stringify({model:"research-claude-sonnet-5-5",max_tokens:100,messages:[{role:"user",content:"text"}],...extra})}));
      expect(result.status).toBe(402);
    }
    expect(transport).not.toHaveBeenCalled();expect(store.total()).toBe(0);
  });
  it("intercepts the real Anthropic SDK before it can retry an unbudgeted request",async()=>{
    const transport=vi.fn<typeof fetch>();const {send}=setup("messages",transport,"0.001");
    const client=new ChatAnthropic({model:"research-claude-sonnet-5-5",apiKey:"unused",maxRetries:2,
      clientOptions:{baseURL:"https://models.test/anthropic",fetch:send}});
    const error=await withRequestContext(context,()=>client.invoke("source text")).catch(error=>error);
    expect(budgetErrorCode(error)).toBe("evidence_budget_exhausted");
    expect(transport).not.toHaveBeenCalled();
  });
  it("settles a real Anthropic SDK invocation through the Messages endpoint",async()=>{
    const transport=vi.fn<typeof fetch>().mockImplementation(async(input,init)=>{
      expect(new URL(input instanceof Request?input.url:String(input)).pathname).toBe("/anthropic/v1/messages");
      expect(JSON.parse(init!.body as string).max_tokens).toBe(100);
      expect(store.total()).toBe(5000);
      return new Response(JSON.stringify({id:"msg_1",type:"message",role:"assistant",
        model:"research-claude-sonnet-5-5",content:[{type:"text",text:"done"}],
        stop_reason:"end_turn",stop_sequence:null,usage:{input_tokens:10,cache_creation_input_tokens:5,
          cache_read_input_tokens:5,output_tokens:5}}),{headers:{"content-type":"application/json"}});
    });
    const {send,store}=setup("messages",transport);
    const client=new ChatAnthropic({model:"research-claude-sonnet-5-5",apiKey:"unused",maxTokens:200,
      maxRetries:0,clientOptions:{baseURL:"https://models.test/anthropic",fetch:send}});
    const result=await withRequestContext(context,()=>client.invoke("source text"));
    expect(result.content).toBe("done");
    expect(store.total()).toBe(130);
  });
});

describe.skipIf(process.env.EVIDENCE_QUEUE_AZURITE_TESTS!=="1")("durable budget CAS (local Azurite)",()=>{
  it("intercepts the real Azure embedding SDK and shares its cap across retries",async()=>{
    const key=Buffer.from("local-evidence-queue-test-key-only").toString("base64");
    vi.stubEnv("STORAGE_ACCOUNT_NAME", "evidencetest");
    vi.spyOn(storage, "createBlobServiceClient").mockReturnValue(BlobServiceClient.fromConnectionString(
      `DefaultEndpointsProtocol=http;AccountName=evidencetest;AccountKey=${key};BlobEndpoint=http://127.0.0.1:10070/evidencetest;`));
    const config=configuration("0.001");config.limits[0].budgetId=randomUUID();
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(config));
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(JSON.stringify({data:[{index:0,embedding:[1,2]}],usage:{prompt_tokens:1000}}),{headers:{"content-type":"application/json"}}));
    const telemetry={trackEvent:vi.fn(),trackException:vi.fn()} as unknown as TelemetryClient;
    const embedding=new AzureOpenAIEmbeddingsWithTelemetry(telemetry,"account","391",{
      azureOpenAIBasePath:"https://models.test/openai/deployments",azureOpenAIApiDeploymentName:"embedding",
      azureOpenAIApiKey:"unused",azureOpenAIApiVersion:"2024-12-01-preview",model:"text-embedding-3-small",configuration:{fetch:transport},maxRetries:2,
    });
    await expect(withRequestContext(context,()=>embedding.embedBatch(["source text"]))).resolves.toEqual([[1,2]]);
    const error=await withRequestContext(context,()=>embedding.embedBatch(["another"])).catch(error=>error);
    expect(budgetErrorCode(error)).toBe("evidence_budget_exhausted");
    expect(transport).toHaveBeenCalledOnce();
  });
  it("shares one dollar between independent blob clients and retains it across restart",async()=>{
    const key=Buffer.from("local-evidence-queue-test-key-only").toString("base64");
    const connection=`DefaultEndpointsProtocol=http;AccountName=evidencetest;AccountKey=${key};BlobEndpoint=http://127.0.0.1:10070/evidencetest;`;
    const scope={...selection(),scope:{...selection().scope,budgetId:randomUUID()}};
    const reservations=await Promise.allSettled(Array.from({length:12},()=>
      new EvidenceCostBudget(new BlobBudgetLedgerStore(BlobServiceClient.fromConnectionString(connection))).reserve(scope,250_000)));
    const accepted=reservations.filter(r=>r.status==="fulfilled");
    expect(accepted).toHaveLength(4);
    expect(reservations.filter(r=>r.status==="rejected").every(r=>budgetErrorCode((r as PromiseRejectedResult).reason)==="evidence_budget_busy")).toBe(true);
    const restarted=new EvidenceCostBudget(new BlobBudgetLedgerStore(BlobServiceClient.fromConnectionString(connection)));
    for (const entry of accepted)await restarted.settle(scope,entry.value,250_000);
    await expect(restarted.reserve(scope,1)).rejects.toMatchObject({code:"evidence_budget_exhausted"});
    await expect(new EvidenceCostBudget(new BlobBudgetLedgerStore(BlobServiceClient.fromConnectionString(connection))).reserve(scope,1)).rejects.toMatchObject({code:"evidence_budget_exhausted"});
  },30_000);
});
