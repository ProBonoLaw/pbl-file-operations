import { withEvidenceReviewDispatcher, EvidenceReviewPending, type EvidenceReviewTask } from "../src/processors/evidence/evidenceAsync.js";
import { evidenceTaskHarness } from "./helpers/evidenceTaskHarness.js";
import { Document } from "@langchain/core/documents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceExtractor } from "../src/processors/evidence/evidenceExtractor.js";
import { EvidenceBudgetError } from "../src/processors/evidence/evidenceCostBudget.js";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.js";
import { EvidenceReconciliationTimeoutError } from "../src/processors/evidence/evidenceReconciliationDeadline.js";
import { telemetryClient } from "../src/processors/appInsights.js";

const mocks = vi.hoisted(() => ({ agent: vi.fn() }));
vi.mock("langchain", async original => ({ ...await original<typeof import("langchain")>(), createAgent: mocks.agent }));
vi.mock("@langchain/openai", () => ({ ChatOpenAI: class {
  deployment: string;
  constructor(options: { model: string }) { this.deployment = options.model; }
} }));
vi.mock("../src/processors/appInsights.js", () => ({ telemetryClient: { trackEvent: vi.fn(), trackException: vi.fn() } }));

const identity = "Examiner: Dr. North.";
const quotes = {
  repair: "Sam delivered the letter in 2020.",
  classification: "When tasks are challenging, Casey will say, 'I cannot do that.'",
  dates: "Alex signed the agreement.",
  attribution: "Extra time may help Casey.",
};
const source = new EvidenceSource(new Document({ pageContent: [identity, ...Object.values(quotes)].join("\n\n"),
  metadata: { pages: [1], sourceId: "source" } }));
const window = source.windows()[0];
const dateFields = { whenStartedYear: null, whenStartedMonth: null, whenStartedDay: null,
  whenEndedYear: null, whenEndedMonth: null, whenEndedDay: null };
const eventItem = (quote: string) => ({ what: quote, sourceQuote: quote, supportingQuotes: [], who: [],
  where: "Unknown", why: "Unknown", eventType: "other", facets: [], ...dateFields,
  whenStartedSeason: null, whenStartedQuarter: null, whenEndedSeason: null, whenEndedQuarter: null });
const claimItem = (quote: string, claimant = "Document author") => ({ statement: quote, sourceQuote: quote,
  supportingQuotes: [], claimant, claimType: "opinion", polarity: "uncertain", facets: [], who: [],
  where: "Unknown", ...dateFields });
const candidates = [
  { id: "repair", kind: "event", item: { ...eventItem(quotes.repair), whenStartedYear: "2020" }, extractedBy: ["primary"] },
  { id: "classification", kind: "event", item: eventItem(quotes.classification), extractedBy: ["primary"] },
  { id: "dates", kind: "event", item: eventItem(quotes.dates), extractedBy: ["primary"] },
  { id: "attribution", kind: "claim", item: claimItem(quotes.attribution), extractedBy: ["primary"] },
];
type Call = { component: string; model: string; ids: string[]; signal: AbortSignal };
type Response = { structuredResponse: { decisions: unknown[] } };
const keep = (id: string) => ({ candidateId: id, verdict: "supported", keepOriginal: true,
  reason: "", corrections: [], events: [], facts: [], claims: [] });
const emptyDate = () => ({ year: "", month: "", day: "", season: "", quarter: "" });

function fixture(options: { handle?: (call: Call, response: Response) => Promise<Response>; keepClassifiedEvent?: boolean } = {}) {
  const calls: Call[] = [];
  let active = 0, maximumActive = 0;
  mocks.agent.mockImplementation(({ systemPrompt, model }) => ({ invoke: async ({ messages }: any, config: any) => {
    const support = systemPrompt.includes("SOURCE SUPPORT REVIEWER:");
    const request = support ? JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1])
      : JSON.parse(messages[0].content).candidates;
    const component = support ? request[0].feedback?.startsWith("Independently") ? request[0].candidateId : "source-support"
      : systemPrompt.includes("EVENT DATE RESOLVER:")
        ? request[0].candidateId.includes("classified-event") ? "classified-dates" : "dates" : "attribution";
    const call = { component, model: model.deployment, ids: request.map((item: any) => item.candidateId), signal: config.signal };
    calls.push(call);
    active++; maximumActive = Math.max(maximumActive, active);
    try {
      const decisions = request.map((item: any) => {
        if (component === "source-support" && item.candidateId === "repair") return { ...keep(item.candidateId),
          verdict: "unsupported", keepOriginal: false, reason: "An independent source opinion is required." };
        if (component === "classification" && !options.keepClassifiedEvent) return { ...keep(item.candidateId),
          keepOriginal: false, reason: "A habitual assertion does not establish a particular occurrence.",
          claims: [claimItem(quotes.classification, "Dr. North")] };
        if (component.endsWith("dates")) return { candidateId: item.candidateId, status: "unknown", relation: "unknown",
          start: emptyDate(), end: emptyDate(), qualifier: "", explanation: "No occurrence date in the inspected source.",
          supportingQuotes: [] };
        if (component === "attribution") return { candidateId: item.candidateId, status: "resolved", claimant: "Dr. North",
          explanation: "The examiner's recommendation.", supportingQuotes: [{ pageNumber: 1, quote: identity }] };
        return keep(item.candidateId);
      });
      const response = { structuredResponse: { decisions } };
      return options.handle ? await options.handle(call, response) : response;
    } finally { active--; }
  } }));
  return { calls, maximumActive: () => maximumActive };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function checkpoints() {
  const saved = new Map<string, unknown>();
  const store = { getStage: vi.fn(async (_identity: unknown, _window: number, stage: string) => structuredClone(saved.get(stage) ?? null)),
    putStage: vi.fn(async (_identity: unknown, _window: number, stage: string, value: unknown) => { saved.set(stage, structuredClone(value)); }) };
  const context = { identity: { accountId: "account", sourceId: "source", runFingerprint: "test" }, windowIndex: 0 };
  return { saved, store, context };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://test.services.ai.azure.com");
  vi.stubEnv("AZURE_OPENAI_LLM_API_KEY", "test");
  vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "review-test");
  vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "failover-test");
  vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "independent");
  vi.stubEnv("EVIDENCE_RECONCILIATION_TIMEOUT_MS", "300000");
  vi.stubEnv("EVIDENCE_SPECIALIST_MODE", "off");
  vi.stubEnv("EVIDENCE_EVENT_STRUCTURE_MODE", "off");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("concurrent thorough reconciliation components", () => {
  it("queues independent components, resumes their saved source plan, and waits for dependent dates", async () => {
    const {calls} = fixture({keepClassifiedEvent: true});
    const h = evidenceTaskHarness();
    const {store} = checkpoints();
    const extractor = new EvidenceExtractor("account", "source", undefined, store as any) as any;
    const context = {identity: await extractor.checkpointIdentity(source), windowIndex: 0};
    const run = () => withEvidenceReviewDispatcher(h.queue.dispatcher({jobId: "job", accountId: "account", sourceId: "source"}),
      () => extractor.reviewer.reconcile(candidates, source, window, "batch-1", undefined, true, context));
    await expect(run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    expect(h.records.size).toBe(1);
    expect([...h.records.values()][0].lane).toBe("reconcile");
    expect([...h.records.values()][0].definition.maxAttempts).toBe(4);
    expect(calls).toHaveLength(0); // The gathering process does not call a reviewer.
    const worker = new EvidenceExtractor("account", "source", undefined, store as any);
    const processAll = async () => {
      for (const record of [...h.records.values()]) if (record.status === "pending") {
        await h.queue.process(record.id, record.lane, async task => {
          const payload = task.definition.payload as EvidenceReviewTask;
          const saved = await h.store.artifact(payload.sourceArtifact) as any;
          const execute = () => worker.executeReviewTask(payload, new Document(saved), task.lane === "repair");
          return task.lane === "reconcile"
            ? withEvidenceReviewDispatcher(h.queue.dispatcher(task.definition.correlation), execute) : execute();
        });
      }
    };
    await processAll();
    expect(h.records.size).toBe(5); // Source worker schedules review before the coordinator resumes.
    expect(calls.map(call => call.component)).toEqual(["source-support"]);
    await processAll();
    await expect(run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    expect(h.records.size).toBe(6); // Date task exists only after classification has completed.
    expect([...h.records.values()].filter(record => record.status === "completed")).toHaveLength(5);
    await processAll();
    const result = await run();
    expect(result.events).toHaveLength(3);
    expect(result.claims).toHaveLength(1);
    expect(calls.filter(call => call.component === "source-support")).toHaveLength(1);
    expect(calls.filter(call => call.component === "attribution")).toHaveLength(1);
    expect(calls.some(call => call.component === "classified-dates")).toBe(true);
  });

  it("continues all later batches and windows while reviews are pending", async () => {
    const extractor = new EvidenceExtractor("account", "source") as any;
    const reconcile = vi.spyOn(extractor.reviewer, "reconcile").mockRejectedValue(new EvidenceReviewPending());
    await expect(extractor.reviewer.reviewBatches(Array.from({length: 100}, (_, i) => ({...candidates[0], id: String(i)})),
      source, window)).rejects.toBeInstanceOf(EvidenceReviewPending);
    expect(reconcile).toHaveBeenCalledTimes(7);
    const extractWindow = vi.spyOn(extractor, "extractWindow").mockRejectedValue(new EvidenceReviewPending());
    await expect(extractor.generateDocuments(new Document({pageContent: Array(8).fill("Some source.").join("<!-- PageBreak -->"), metadata: {}})))
      .rejects.toBeInstanceOf(EvidenceReviewPending);
    expect(extractWindow).toHaveBeenCalledTimes(8);
  });

  it("assembles a completed page in the coordinator while later model units remain queued", async () => {
    const h = evidenceTaskHarness();
    const stages = new Map<string, unknown>();
    const store = {get:vi.fn(async () => null),put:vi.fn(),
      getStage:vi.fn(async (_identity:unknown,index:number,stage:string) => structuredClone(stages.get(index+":"+stage) ?? null)),
      putStage:vi.fn(async (_identity:unknown,index:number,stage:string,value:unknown) => {stages.set(index+":"+stage,structuredClone(value));}),
    };
    const extractor = new EvidenceExtractor("account","source",undefined,store as any) as any;
    const worker = new EvidenceExtractor("account","source",undefined,store as any) as any;
    const coordinatorInvoke = vi.spyOn(extractor,"invokeStructured").mockRejectedValue(new Error("Coordinator must not gather"));
    let failFacts = true;
    const invoke = vi.spyOn(worker,"invokeStructured").mockImplementation(async (...args: any[]) => {
      const content = JSON.parse(args[2]), stage = args[4];
      if (stage === "primary-events") return {events:[eventItem(content.target.text)]};
      if (stage === "primary-facts") {
        if (content.target.pageNumber === 1 && failFacts) { failFacts = false; throw new Error("Temporary gathering failure"); }
        return {facts:[]};
      }
      if (stage === "primary-claims") return {claims:[]};
      if (stage === "independent") return {events:[],facts:[],claims:[]};
      throw new Error("Gathering must not call a source reviewer");
    });
    const document = new Document({pageContent:Array.from({length:8},(_,i)=>"Action "+(i+1)+" occurred.").join("<!-- PageBreak -->"),metadata:{}});
    const run = () => withEvidenceReviewDispatcher(h.queue.dispatcher({accountId:"account",sourceId:"source",jobId:"job"}),
      () => extractor.generateDocuments(document));
    await expect(run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    expect(invoke).not.toHaveBeenCalled();
    expect(h.records.size).toBe(32); // Four model units per window; no queued assembly parents.
    const units = [...h.records.values()];
    expect(units.every(r=>r.lane==="gather" && r.definition.maxAttempts===4 &&
      (r.definition.payload as EvidenceReviewTask).component==="gathering-unit")).toBe(true);
    const processGather = async (id:string) => h.queue.process(id,"gather",async task => {
      const payload = task.definition.payload as EvidenceReviewTask;
      return withEvidenceReviewDispatcher(h.queue.dispatcher(task.definition.correlation), () =>
        worker.executeReviewTask(payload,document,false));
    });
    for (const record of units.filter(r=>(r.definition.payload as EvidenceReviewTask).context.windowIndex<2))
      await processGather(record.id);
    expect(invoke).toHaveBeenCalledTimes(8);
    await expect(run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    const sourceTasks = [...h.records.values()].filter(r=>r.lane==="reconcile");
    expect(sourceTasks).toHaveLength(1);
    expect((sourceTasks[0].definition.payload as EvidenceReviewTask).context.windowIndex).toBe(1);
    expect(units.filter(r=>(r.definition.payload as EvidenceReviewTask).context.windowIndex>=2)
      .every(r=>h.records.get(r.id)?.status==="pending")).toBe(true);
    expect(store.put).not.toHaveBeenCalled(); // Failed unit and incomplete reviews prevent publication.
    h.advance(15_000);
    for (const record of units) await processGather(record.id);
    expect(invoke).toHaveBeenCalledTimes(33); // Only the failed primary-facts unit runs again.
    await expect(run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    expect(h.records.size).toBe(40);
    expect([...h.records.values()].filter(r=>r.lane==="reconcile" && r.status==="pending")).toHaveLength(8);
    await expect(run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    expect(invoke).toHaveBeenCalledTimes(33);
    expect(coordinatorInvoke).not.toHaveBeenCalled();
    expect(h.records.size).toBe(40); // Repeated planning preserves model and source task IDs.
    expect(store.put).not.toHaveBeenCalled();
  });

  it("queues recovery children without holding a model slot or consuming attempts while they run", async () => {
    vi.stubEnv("EVIDENCE_GATHER_PRIMARY_MAX_UNITS", "100");
    vi.stubEnv("EVIDENCE_GATHER_INDEPENDENT_MAX_UNITS", "100");
    vi.stubEnv("EVIDENCE_GATHER_INDEPENDENT_MAX_CHARS", "2000");
    const h = evidenceTaskHarness();
    const {store} = checkpoints();
    const worker = new EvidenceExtractor("account", "source", undefined, store as any) as any;
    const document = new Document({pageContent:"word ".repeat(800), metadata:{}});
    const evidenceSource = new EvidenceSource(document);
    const context = {identity:await worker.checkpointIdentity(evidenceSource), windowIndex:0};
    const parent = {version:1 as const, component:"gathering" as const, context, batchId:"window", candidates:[],
      initialReviewer:"reconciliation" as const, allowFailover:false};
    const dispatcher = h.queue.dispatcher({accountId:"account", sourceId:"source", jobId:"job"});
    await expect(dispatcher.result(parent, document)).rejects.toBeInstanceOf(EvidenceReviewPending);
    const parentId = [...h.records.keys()][0];
    const invoke = vi.spyOn(worker, "invokeStructured").mockImplementation(async (...args:any[]) => {
      const stage = args[4], target = JSON.parse(args[2]).target;
      if (stage === "independent" && target.startOffset === 0 && target.text.length > 1000)
        throw Object.assign(new Error("request timed out"), {name:"TimeoutError"});
      return stage === "independent" ? {events:[],facts:[],claims:[]} : stage === "primary-events" ? {events:[]}
        : stage === "primary-facts" ? {facts:[]} : {claims:[]};
    });
    for (let round = 0; round < 7; round++) {
      for (const record of [...h.records.values()]) if (record.lane === "gather" && record.status === "pending") {
        await h.queue.process(record.id, "gather", task => withEvidenceReviewDispatcher(dispatcher,
          () => worker.executeReviewTask(task.definition.payload as EvidenceReviewTask, document, false)));
      }
      h.advance(60_000);
    }
    expect(h.records.get(parentId)).toMatchObject({status:"completed", attempts:1});
    const units = [...h.records.values()].filter(record => (record.definition.payload as EvidenceReviewTask).component === "gathering-unit");
    expect(units.every(record => record.status === "completed")).toBe(true);
    expect(units.filter(record => (record.definition.payload as EvidenceReviewTask).gathering?.depth === 1)).toHaveLength(2);
    expect(invoke.mock.calls.filter(args => args[4] === "independent")).toHaveLength(5);
    expect(invoke.mock.calls.filter(args => args[4] !== "independent")).toHaveLength(3);
  });

  it("consolidates queued gathering and reconciliation only after every dependency completes", async () => {
    fixture();
    const h = evidenceTaskHarness();
    const {store:stages} = checkpoints();
    const windows = new Map<number,unknown>();
    const store = {...stages, get:async (_identity:unknown,index:number) => windows.get(index) ?? null,
      put:async (_identity:unknown,index:number,value:unknown) => {windows.set(index,value);}};
    const extractor = new EvidenceExtractor("account","source",undefined,store as any) as any;
    const worker = new EvidenceExtractor("account","source",undefined,store as any) as any;
    const original = worker.invokeStructured.bind(worker);
    const invoke = vi.spyOn(worker,"invokeStructured").mockImplementation(async (...args:any[]) => {
      if (args[4] === "primary-events") return {events:[eventItem(quotes.dates)]};
      if (args[4] === "primary-facts") return {facts:[]};
      if (args[4] === "primary-claims") return {claims:[]};
      if (args[4] === "independent") return {events:[],facts:[],claims:[]};
      return original(...args);
    });
    const run = () => withEvidenceReviewDispatcher(h.queue.dispatcher({accountId:"account",sourceId:"source",jobId:"job"}),
      () => extractor.generateEvidence(source.document));
    await expect(run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    for (const lane of ["gather","reconcile","review"] as const) {
      h.advance(15_000);
      const records = [...h.records.values()].filter(r=>r.lane===lane && r.status==="pending");
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) await h.queue.process(record.id,lane,async task => {
        const payload = task.definition.payload as EvidenceReviewTask;
        const execute = () => worker.executeReviewTask(payload,source.document,false);
        return lane === "review" ? execute() : withEvidenceReviewDispatcher(h.queue.dispatcher(task.definition.correlation),execute);
      });
      if (lane !== "review") {
        await expect(run()).rejects.toBeInstanceOf(EvidenceReviewPending);
        expect(windows.size).toBe(0);
      }
    }
    const result = await run();
    expect(result.events).toHaveLength(1);
    expect(result.events[0].sourceSpans[0].sourceQuote).toBe(quotes.dates);
    expect(windows.size).toBe(1);
    expect([...h.records.values()].every(r=>r.status==="completed")).toBe(true);
    const count = invoke.mock.calls.length;
    expect(await run()).toEqual(result);
    expect(invoke).toHaveBeenCalledTimes(count);
  });

  it("rejects queued work for a different source or configuration before any model calls", async () => {
    const {calls} = fixture();
    const {store, context} = checkpoints();
    const worker = new EvidenceExtractor("account", "source", undefined, store as any);
    await expect(worker.executeReviewTask({version: 1, component: "dates", candidates, context,
      sourceArtifact: "unused", batchId: "batch", initialReviewer: "reconciliation", allowFailover: true}, source.document, false))
      .rejects.toThrow("does not match");
    expect(calls).toHaveLength(0);
  });

  it("shares two parent slots across extractor instances without consuming model slots while queued", async () => {
    const blocked = deferred();
    const { calls } = fixture({ handle: async (call, response) => {
      if (call.component === "source-support") await blocked.promise;
      return response;
    } });
    const runs = [1, 2, 3].map(index =>
      (new EvidenceExtractor("account", `source-${index}`) as any).reviewer.reconcile(candidates, source, window, `batch-${index}`));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(telemetryClient.trackEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      name: "evidenceExtractor.reconciliationBatchAdmission",
      properties: expect.objectContaining({ batchId: "batch-3", state: "admitted" }) }));
    blocked.resolve();
    await Promise.all(runs);
    expect(telemetryClient.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "evidenceExtractor.reconciliationBatchAdmission",
      properties: expect.objectContaining({ batchId: "batch-3", state: "admitted", maxActiveBatches: "2" }) }));
  });

  it("starts independent reviews together and consolidates only after all have completed", async () => {
    const gates = new Map(Object.keys(quotes).map(key => [key, deferred()]));
    const { calls, maximumActive } = fixture({ handle: async (call, response) => {
      if (call.component !== "source-support") await gates.get(call.component)!.promise;
      return response;
    } });
    const extractor = new EvidenceExtractor("account", "source");
    const run = (extractor as any).reviewer.reconcile(candidates, source, window, "batch-1");
    let completed = false;
    void run.then(() => { completed = true; });
    await vi.waitFor(() => expect(calls.filter(call => call.component !== "source-support")).toHaveLength(4));
    expect(new Set(calls.slice(1).map(call => call.component))).toEqual(new Set(Object.keys(quotes)));
    expect(maximumActive()).toBe(4);
    expect(calls.every(call => call.signal === calls[0].signal)).toBe(true);
    for (const component of ["attribution", "dates", "classification"]) gates.get(component)!.resolve();
    await vi.waitFor(() => expect(telemetryClient.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "evidenceExtractor.reconciliationComponentCompleted", properties: expect.objectContaining({ component: "attribution" }) })));
    expect(completed).toBe(false);
    gates.get("repair")!.resolve();
    const result = await run;
    expect(result.events.map((event: any) => event.item.what)).toEqual([quotes.repair, quotes.dates]);
    expect(result.claims.map((claim: any) => claim.item.statement)).toEqual([quotes.classification, quotes.attribution]);
    expect(result.claims[1].item.claimant).toBe("Dr. North");
    expect(telemetryClient.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "evidenceExtractor.reconciliationConsolidated", properties: expect.objectContaining({ batchId: "batch-1", componentCount: "4" }) }));
  });

  it("runs existing event dates while classification is pending and dates revised events afterward", async () => {
    const classification = deferred();
    const { calls } = fixture({ keepClassifiedEvent: true, handle: async (call, response) => {
      if (call.component === "classification") await classification.promise;
      return response;
    } });
    const run = (new EvidenceExtractor("account", "source") as any).reviewer.reconcile(candidates, source, window, "batch-1");
    await vi.waitFor(() => expect(calls.some(call => call.component === "dates")).toBe(true));
    expect(calls.some(call => call.component === "classified-dates")).toBe(false);
    classification.resolve();
    const result = await run;
    expect(calls.filter(call => call.component === "classified-dates")).toHaveLength(1);
    expect(result.events).toHaveLength(3);
    expect(result.claims).toHaveLength(1);
  });

  it("keeps the four-request limit across components from different batches", async () => {
    const gate = deferred();
    const { calls, maximumActive } = fixture({ handle: async (call, response) => {
      if (call.component !== "source-support") await gate.promise;
      return response;
    } });
    const extractor = new EvidenceExtractor("account", "source");
    const runs = ["batch-1", "batch-2"].map(id => (extractor as any).reviewer.reconcile(candidates, source, window, id));
    await vi.waitFor(() => expect(calls.filter(call => call.component !== "source-support")).toHaveLength(4));
    expect(maximumActive()).toBe(4);
    gate.resolve();
    await expect(Promise.all(runs)).resolves.toHaveLength(2);
    expect(calls.filter(call => call.component !== "source-support")).toHaveLength(8);
    expect(maximumActive()).toBe(4);
  });

  it.each(["source-support", "classification", "dates", "attribution"])("fails over only the failed %s component", async component => {
    const { calls } = fixture({ handle: async (call, response) => {
      if (call.component === component && call.model === "review-test") throw new Error("Primary reviewer unavailable");
      return response;
    } });
    const result = await (new EvidenceExtractor("account", "source") as any).reviewer.reconcile(candidates, source, window, "batch-1");
    expect(result.events).toHaveLength(2);
    expect(result.claims).toHaveLength(2);
    expect(calls.filter(call => call.component === component).map(call => call.model)).toEqual(["review-test", "failover-test"]);
    for (const other of ["source-support", "classification", "dates", "attribution"].filter(name => name !== component)) {
      expect(calls.filter(call => call.component === other)).toHaveLength(1);
    }
    expect(telemetryClient.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "evidenceExtractor.reconciliationComponentFailover", properties: expect.objectContaining({
        parentBatchId: "batch-1", component: component === "source-support" ? "source-support:0" : component,
        model: "review-test", fallbackModel: "failover-test" }) }));
  });
  it.each(["evidence_budget_busy","evidence_budget_exhausted","evidence_budget_configuration"] as const)("never escalates %s to a more expensive model",async code=>{
    const error=new EvidenceBudgetError(code,"budget stop");
    const {calls}=fixture({handle:async(call,response)=>{
      if(call.component==="source-support")throw error;
      return response;
    }});
    await expect((new EvidenceExtractor("account","source") as any).reviewer.reconcile(candidates,source,window,"budget-test")).rejects.toBe(error);
    expect(calls.filter(call=>call.component==="source-support").map(call=>call.model)).toEqual(["review-test"]);
  });

  it.each([false, true])("restores completed components after a sibling fails (source failover: %s)", async sourceFailover => {
    let unavailable = true;
    const { calls } = fixture({ handle: async (call, response) => {
      if (sourceFailover && call.component === "source-support" && call.model === "review-test") throw new Error("Primary source reviewer unavailable");
      if (call.component === "attribution" && unavailable) throw new Error("Attribution unavailable");
      return response;
    } });
    const { saved, store, context } = checkpoints();
    const extractor = new EvidenceExtractor("account", "source", undefined, store as any);
    const reconcile = () => (extractor as any).reviewer.reconcile(candidates, source, window, "batch-1", undefined, true, context);
    await expect(reconcile()).rejects.toThrow("Attribution unavailable");
    for (const name of ["support-repair", "classification", "dates"]) {
      expect(saved.has(`reconciliation-component:batch-1:${name}`)).toBe(true);
    }
    expect(saved.has("reconciliation-component:batch-1:attribution")).toBe(false);
    expect(telemetryClient.trackEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      name: "evidenceExtractor.reconciliationConsolidated", properties: expect.objectContaining({ batchId: "batch-1" }) }));
    const earlierCalls = calls.length;
    unavailable = false;
    const result = await reconcile();
    expect(result.events).toHaveLength(2);
    expect(result.claims).toHaveLength(2);
    expect(calls.slice(earlierCalls).map(call => call.component)).toEqual(["attribution"]);
  });

  it("fails over invalid date citations without accepting them or repeating sibling components", async () => {
    const { calls } = fixture({ handle: async (call, response) => {
      if (call.component === "dates" && call.model === "review-test") return { structuredResponse: {
        decisions: call.ids.map(candidateId => ({ candidateId, status: "dated", relation: "point",
          start: { ...emptyDate(), year: "2025" }, end: emptyDate(), qualifier: "", explanation: "Invalid source citation",
          supportingQuotes: [{ pageNumber: 1, quote: "A fabricated quotation." }] })),
      } };
      return response;
    } });
    const result = await (new EvidenceExtractor("account", "source") as any).reviewer.reconcile(candidates, source, window, "batch-1");
    expect(calls.filter(call => call.component === "dates").map(call => call.model))
      .toEqual(["review-test", "review-test", "failover-test"]);
    for (const component of ["source-support", "repair", "classification", "attribution"]) {
      expect(calls.filter(call => call.component === component)).toHaveLength(1);
    }
    const dated = result.events.find((event: any) => event.item.what === quotes.dates);
    expect(dated.item.whenStartedYear).toBeNull();
    expect(dated.sourceSpans.some((span: any) => span.sourceQuote === "A fabricated quotation.")).toBe(false);
    expect(dated.extractedBy).toContain("event-date-resolution:failover-test");
  });

  it("omits only a malformed decision after final source-review rescue", async () => {
    const {calls}=fixture({handle:async(call,response)=>{
      if(call.component==="source-support") response.structuredResponse.decisions=response.structuredResponse.decisions.map(
        (decision:any)=>decision.candidateId==="bad"?{...decision,verdict:"invalid"}:decision);
      return response;
    }});
    const extractor=new EvidenceExtractor("account","source");
    const items=["good","bad"].map(id=>({id,kind:"claim" as const,
      item:claimItem(quotes.attribution,"Dr. North"),extractedBy:["primary"]}));
    const rescue=(extractor as any).reconciliationRescue;
    const plan=await (extractor as any).reviewer.buildReconciliationPlan(items,source,window,"final-rescue",rescue,
      false,undefined,"defer",true);
    const result=await (extractor as any).reviewer.completeReconciliationPlan(plan,source,window,"final-rescue",rescue,
      false,undefined,"defer",true);
    expect(result.claims).toHaveLength(1);
    expect(calls.filter(call=>call.component==="source-support").map(call=>call.ids)).toEqual([["good","bad"],["bad"]]);
    expect(telemetryClient.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name:"evidenceExtractor.candidateRejected",
      properties:expect.objectContaining({candidateId:"bad",reason:"review-unresolved-after-rescue"}),
    }));
  });

  it("rescues an unresolved inline source review and omits only its bad entry", async () => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_RESCUE_DEPLOYMENT_NAME", "rescue-test");
    const { calls } = fixture({ handle: async (call, response) => {
      if (call.ids.includes("bad")) response.structuredResponse.decisions = response.structuredResponse.decisions.map(
        (decision: any) => decision.candidateId === "bad" ? { ...decision, verdict: "invalid" } : decision);
      return response;
    } });
    const items = ["good", "bad"].map(id => ({ id, kind: "claim" as const,
      item: claimItem(quotes.attribution, "Dr. North"), extractedBy: ["primary"] }));
    const result = await (new EvidenceExtractor("account", "source") as any).reviewer.reconcile(items, source, window, "inline-rescue");
    expect(result.claims).toHaveLength(1);
    expect(calls.filter(call => call.ids.includes("bad")).map(call => call.model))
      .toContain("rescue-test");
    expect(telemetryClient.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "evidenceExtractor.candidateRejected",
      properties: expect.objectContaining({ candidateId: "bad", reason: "review-unresolved-after-rescue" }),
    }));
  });

  it("rescues unresolved inline classification without losing reviewed siblings", async () => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_RESCUE_DEPLOYMENT_NAME", "rescue-test");
    const { calls } = fixture({ handle: async (call, response) => {
      if (call.ids.length === 1 && call.ids[0] === "classification") response.structuredResponse.decisions = response.structuredResponse.decisions.map(
        (decision: any) => ({ ...decision, verdict: "invalid" }));
      return response;
    } });
    const result = await (new EvidenceExtractor("account", "source") as any).reviewer.reconcile(candidates, source, window, "inline-classification");
    expect(result.events.some((event: any) => event.item.what === quotes.repair)).toBe(true);
    expect(result.events.some((event: any) => event.item.what === quotes.dates)).toBe(true);
    expect(result.claims.some((claim: any) => claim.item.statement === quotes.attribution)).toBe(true);
    expect(calls.filter(call => call.component === "classification").map(call => call.model)).toContain("rescue-test");
    expect(telemetryClient.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "evidenceExtractor.candidateRejected",
      properties: expect.objectContaining({ reason: "review-unresolved-after-rescue" }),
    }));
  });

  it("requires an independent opinion before a classification component rejects source-anchored evidence", async () => {
    const { calls } = fixture({ handle: async (call, response) => {
      if (call.component === "classification" && call.model === "review-test") return { structuredResponse: {
        decisions: call.ids.map(id => ({ ...keep(id), verdict: "unsupported", keepOriginal: false,
          reason: "The primary reviewer proposed removing this item." })),
      } };
      return response;
    } });
    const result = await (new EvidenceExtractor("account", "source") as any).reviewer.reconcile(candidates, source, window, "batch-1");
    expect(calls.filter(call => call.component === "classification").map(call => call.model))
      .toEqual(["review-test", "failover-test"]);
    expect(result.claims.some((claim: any) => claim.item.statement === quotes.classification)).toBe(true);
  });

  it("shares the remaining deadline with failover and never saves late results", async () => {
    vi.useFakeTimers();
    const blocked = deferred();
    const { calls } = fixture({ handle: async (call, response) => {
      if (call.component === "attribution") {
        if (call.model === "review-test") {
          await new Promise(resolve => setTimeout(resolve, 240_000));
          throw new Error("Primary failed late");
        }
        await blocked.promise; // Simulate a provider that ignores cancellation.
      }
      return response;
    } });
    const { saved, store, context } = checkpoints();
    const extractor = new EvidenceExtractor("account", "source", undefined, store as any);
    const result = (extractor as any).reviewer.reconcile(candidates, source, window, "batch-1", undefined, true, context)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(calls.filter(call => call.component === "attribution").map(call => call.model)).toEqual(["review-test", "failover-test"]);
    expect(calls.every(call => call.signal === calls[0].signal)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBeInstanceOf(EvidenceReconciliationTimeoutError);
    expect(calls[0].signal.aborted).toBe(true);
    const writes = store.putStage.mock.calls.length;
    blocked.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.putStage).toHaveBeenCalledTimes(writes);
    expect(saved.has("reconciliation-component:batch-1:attribution")).toBe(false);
  });
});
