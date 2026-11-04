import { Document } from "@langchain/core/documents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EvidenceExtractor, EvidenceModelRateLimitError } from "../src/processors/evidence/evidenceExtractor.js";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.js";
import { GatheringAttempt, gatheringTimeoutMs, planGatheringWindows, splitGatheringWindow,
  EvidenceGatheringOutputLimitError, EvidenceGatheringPartitionScheduledError } from "../src/processors/evidence/evidenceGathering.js";
import { EvidenceGatheringTimeoutError } from "../src/processors/evidence/evidenceReconciliationDeadline.js";
import { withEvidenceReviewDispatcher } from "../src/processors/evidence/evidenceAsync.js";
import { decode } from "@toon-format/toon";

const mocks = vi.hoisted(() => ({agent: vi.fn(), model: vi.fn()}));
vi.mock("langchain", async original => ({...await original<typeof import("langchain")>(), createAgent: mocks.agent}));
vi.mock("@langchain/openai", () => ({ChatOpenAI: class {
  constructor(options: unknown) { mocks.model(options); }
}}));
vi.mock("../src/processors/appInsights.js", () => ({telemetryClient: {trackEvent: vi.fn(), trackException: vi.fn()}}));

const source = new EvidenceSource(new Document({pageContent: "Alex described a distinct occurrence.\n".repeat(85), metadata: {pages: [24]}}));
const window = source.windows()[0];
const context = {identity: {accountId: "account", sourceId: "source", runFingerprint: "test"}, windowIndex: 0};
const fact = (text: string) => ({what: text, subject: ["Alex"], reportedBy: [], where: "Unknown",
  asOfYear: null, asOfMonth: null, asOfDay: null, factType: "other", facets: [], sourceQuote: text, supportingQuotes: []});
function stages() {
  const saved = new Map<string, any>();
  return {saved, store: {get: vi.fn(async () => null), put: vi.fn(), clearSource: vi.fn(), clearAccount: vi.fn(),
    getStage: vi.fn(async (_identity: unknown, _index: number, stage: string) => structuredClone(saved.get(stage) ?? null)),
    putStage: vi.fn(async (_identity: unknown, _index: number, stage: string, value: unknown) => {
      saved.set(stage, structuredClone(value));
    })}};
}
function semaphore() { return {acquire: vi.fn(async () => true), release: vi.fn()}; }
function agents(independent: (target: any, signal: AbortSignal) => Promise<unknown>) {
  const calls: Array<{stage: string; target: any; signal: AbortSignal}> = [];
  mocks.agent.mockImplementation((options: any) => ({invoke: async (request: any, config: any) => {
    const stage = options.systemPrompt.includes("INDEPENDENT EXTRACTOR:") ? "independent"
      : options.systemPrompt.includes("EVENT WORKER:") ? "events"
      : options.systemPrompt.includes("FACT WORKER:") ? "facts" : "claims";
    const prompt = JSON.parse(request.messages[0].content);
    calls.push({stage, target: prompt.target, signal: config.signal});
    expect(options.tools.length).toBeGreaterThan(0);
    return {structuredResponse: stage === "independent" ? await independent(prompt.target, config.signal)
      : {[stage]: []}};
  }}));
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://test.services.ai.azure.com");
  vi.stubEnv("AZURE_OPENAI_LLM_API_KEY", "test");
  vi.stubEnv("EVIDENCE_GATHER_TIMEOUT_MS", "100");
  vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "off");
  vi.stubEnv("EVIDENCE_SPECIALIST_MODE", "off");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("gathering source partitions", () => {
  it("saves an output-limit split and gathers every source character on retry", async () => {
    const {saved,store} = stages();
    const extractor = new EvidenceExtractor("account", "source", semaphore(), store) as any;
    const calls: string[] = [];
    vi.spyOn(extractor,"invokeStructured").mockImplementation(async (_schema: unknown, _instructions: string, content: string) => {
      const target = JSON.parse(content).target;
      calls.push(target.text);
      if (target.text.length === window.text.length)
        throw new EvidenceGatheringOutputLimitError("output token limit");
      return {facts:[target.text]};
    });
    const run = () => extractor.extractionPass(z.object({facts:z.array(z.string())}), "Test",
      source.gatheringPrompt(window), extractor.independentModel, "independent", source, window,
      context, 0, new GatheringAttempt());
    await expect(run()).rejects.toBeInstanceOf(EvidenceGatheringPartitionScheduledError);
    expect(saved.has(`independent:segment:${window.startOffset}:${window.text.length}:0:partition`)).toBe(true);
    const result = await run();
    expect(result.facts.join("")).toBe(window.text);
    expect(calls).toHaveLength(3);
  });
  it("runs a filtered primary gathering unit with the configured Claude rescue", async () => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_RESCUE_DEPLOYMENT_NAME", "research-claude-sonnet-5-5");
    vi.stubEnv("EVIDENCE_RECONCILIATION_RESCUE_PROVIDER", "anthropic");
    const {store} = stages();
    const extractor = new EvidenceExtractor("account", "source", semaphore(), store) as any;
    const identity = await extractor.checkpointIdentity(source);
    const invoke = vi.spyOn(extractor,"invokeStructured").mockResolvedValue({facts:[]});
    const segment = planGatheringWindows(window,source.pages[0].text,extractor.gatherLimits.primary,
      source.gatheringStructure(window.pageNumber))[0];
    const task = {version:1,component:"gathering-unit",context:{identity,windowIndex:0},
      batchId:"page-24-facts",candidates:[],sourceArtifact:"unused",initialReviewer:"reconciliation",allowFailover:true,
      gathering:{stage:"primary-facts",startOffset:segment.startOffset,characterCount:segment.text.length,depth:0}} as const;
    await expect(withEvidenceReviewDispatcher({result:vi.fn()},
      () => extractor.executeReviewTask(task,source,true))).resolves.toEqual({facts:[]});
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[3]).toMatchObject({deployment:"research-claude-sonnet-5-5",provider:"anthropic"});
  });
  it("marks queued gathering units eligible for a distinct Claude filter rescue", async () => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_RESCUE_DEPLOYMENT_NAME", "research-claude-sonnet-5-5");
    vi.stubEnv("EVIDENCE_RECONCILIATION_RESCUE_PROVIDER", "anthropic");
    const extractor = new EvidenceExtractor("account", "source", semaphore(), stages().store) as any;
    const identity = await extractor.checkpointIdentity(source);
    const result = vi.fn(async () => ({facts:[]}));
    await withEvidenceReviewDispatcher({result}, () => extractor.dispatchGatheringUnit(
      z.object({facts:z.array(z.string())}), "Test", extractor.primaryModel, "primary-facts", source, window,
      {identity,windowIndex:0}, 0, new GatheringAttempt()));
    expect(result.mock.calls[0]?.[0]).toMatchObject({component:"gathering-unit",allowFailover:true});
  });
  it.each([undefined, "json", "toon"])("sends the selected input format (%s) to the model and tools while retaining the structured output schema", async format => {
    vi.stubEnv("EVIDENCE_PROMPT_FORMAT", format);
    const read = (text: string) => format === "toon"
      ? decode(text.slice("```toon\n".length, -"\n```".length)) : JSON.parse(text);
    const invoke = vi.fn(async (request: any) => {
      const text = request.messages[0].content;
      expect(read(text)).toEqual({target:{text:"Exact\nquotation 😀",pageNumber:24}});
      return {structuredResponse:{facts:["supported"]}};
    });
    mocks.agent.mockReturnValue({invoke});
    const extractor = new EvidenceExtractor("account", "source", semaphore()) as any;
    await expect(extractor.invokeStructured(z.object({facts:z.array(z.string())}), "Test",
      JSON.stringify({target:{text:"Exact\nquotation 😀",pageNumber:24}}), extractor.primaryModel, "primary-facts", source))
      .resolves.toEqual({facts:["supported"]});
    const options = mocks.agent.mock.calls[0][0];
    if (format === "toon") expect(options.systemPrompt).toContain("Input data and source-tool results use TOON");
    else expect(options.systemPrompt).not.toContain("Input data and source-tool results use TOON");
    expect(options.responseFormat).toBeDefined();
    const result = await options.tools[0].invoke({pageNumber:24,startOffset:0});
    expect(read(result)).toMatchObject({pageNumber:24,text:source.pages[0].text});
  });

  it("versions work limits and account/source identity while preserving checkpoints on timeout changes", async () => {
    const {store} = stages();
    const identity = async (account = "account") => (new EvidenceExtractor(account, "source", semaphore(), store) as any).checkpointIdentity(source);
    const initial = await identity();
    vi.stubEnv("EVIDENCE_GATHER_TIMEOUT_MS", "300000");
    expect(await identity()).toEqual(initial);
    expect((await identity("another-account")).runFingerprint).not.toBe(initial.runFingerprint);
    vi.stubEnv("EVIDENCE_PROMPT_FORMAT", "toon");
    expect((await identity()).runFingerprint).not.toBe(initial.runFingerprint);
    vi.stubEnv("EVIDENCE_PROMPT_FORMAT", "json");
    vi.stubEnv("EVIDENCE_GATHER_INDEPENDENT_MAX_CHARS", "1000");
    expect((await identity()).runFingerprint).not.toBe(initial.runFingerprint);
    const extractor = new EvidenceExtractor("account", "source", semaphore(), store);
    await expect(extractor.executeReviewTask({version:1, component:"gathering-unit", context:{identity:initial, windowIndex:0},
      batchId:"old-unit", candidates:[], sourceArtifact:"unused", initialReviewer:"reconciliation", allowFailover:false,
      gathering:{stage:"independent", startOffset:0, characterCount:1500, depth:0}}, source.document, false))
      .rejects.toThrow("source/configuration/implementation");
    expect(mocks.agent).not.toHaveBeenCalled();
  });

  it("stops paid work after a checkpoint error and drains active saves before returning", async () => {
    const {store} = stages();
    const failure = new Error("checkpoint storage unavailable");
    let rejectFirst!: (error: Error) => void, finishSecond!: () => void;
    let writes = 0;
    store.putStage.mockImplementation(async () => {
      if (++writes === 1) await new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
      else if (writes === 2) await new Promise<void>(resolve => { finishSecond = resolve; });
    });
    const admissions: Array<(value: boolean) => void> = [];
    const permits = {acquire:vi.fn(() => new Promise<boolean>(resolve => admissions.push(resolve))), release:vi.fn()};
    const calls = agents(async () => ({events:[], facts:[], claims:[]}));
    let returned = false;
    const extractor = new EvidenceExtractor("account", "source", permits, store) as any;
    const running = extractor.gatherWindowCandidates(source, window, context).then(
      () => { returned = true; return null; }, (error: unknown) => { returned = true; return error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(admissions.length).toBeGreaterThan(2);
    admissions[0](true); admissions[1](true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    rejectFirst(failure);
    await vi.advanceTimersByTimeAsync(0);
    for (const admit of admissions.slice(2)) admit(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    expect(returned).toBe(false); // The second upload still owns the operation.
    finishSecond();
    expect(await running).toBe(failure);
    expect(writes).toBe(2);
    expect(permits.release).toHaveBeenCalledTimes(admissions.length);
  });

  it("preserves every character, physical page, offset, and neighboring context", () => {
    const original = {...window, startOffset: 700, before: "Earlier source.", after: "Later source."};
    const pageText = "x".repeat(700) + original.text;
    const [left, right] = splitGatheringWindow(original, 0, pageText)!;
    expect(left.text + right.text).toBe(original.text);
    expect(left.pageNumber).toBe(24);
    expect(right.pageNumber).toBe(24);
    expect(right.startOffset).toBe(left.startOffset + left.text.length);
    expect(left.before).toBe(original.before);
    expect(right.after).toBe(original.after);
    expect(left.after).toBe((right.text + original.after).slice(0, 700));
    expect(right.before).toBe((original.before + left.text).slice(-700));
    expect(left.text.endsWith("\n")).toBe(true);
    expect(splitGatheringWindow(original, 0, pageText)).toEqual([left, right]);
  });

  it("keeps context from other physical pages out of internal segment boundaries", () => {
    const original = {...window, text: "x".repeat(1000), before: "Previous physical page.", after: "Next physical page."};
    const [left, right] = splitGatheringWindow(original, 0, original.text)!;
    expect(left.after).toBe(right.text);
    expect(right.before).toBe(left.text);
    expect(left.before).toBe(original.before);
    expect(right.after).toBe(original.after);
  });

  it("bounds subdivision and preserves Unicode at a fallback boundary", () => {
    expect(splitGatheringWindow({...window, text: "x".repeat(999)}, 0, "x".repeat(999))).toBeNull();
    expect(splitGatheringWindow(window, 2, window.text)).toBeNull();
    const original = {...window, text: "x".repeat(999) + "😀" + "x".repeat(1000)};
    const split = splitGatheringWindow(original, 0, original.text)!;
    expect(split.map(segment => segment.text).join("")).toBe(original.text);
    expect(split.every(segment => segment.text.isWellFormed())).toBe(true);
  });

  it.each(["0", "-1", "1.5", "2147483648"])("rejects invalid timeout %s", value => {
    vi.stubEnv("EVIDENCE_GATHER_TIMEOUT_MS", value);
    expect(gatheringTimeoutMs).toThrow();
  });
});

describe("bounded gathering recovery", () => {
  beforeEach(() => {
    // Exercise recovery independently of proactive workload planning.
    vi.stubEnv("EVIDENCE_GATHER_PRIMARY_MAX_CHARS", "5000");
    vi.stubEnv("EVIDENCE_GATHER_INDEPENDENT_MAX_CHARS", "5000");
    vi.stubEnv("EVIDENCE_GATHER_PRIMARY_MAX_UNITS", "100");
    vi.stubEnv("EVIDENCE_GATHER_INDEPENDENT_MAX_UNITS", "100");
  });
  it("uses the appsettings timeout for both primary and independent gathering clients", async () => {
    vi.stubEnv("EVIDENCE_GATHER_TIMEOUT_MS", "300000");
    agents(async()=>({events:[],facts:[],claims:[]}));
    const extractor = new EvidenceExtractor("account", "source", semaphore()) as any;
    mocks.model.mockClear();
    await extractor.gatherWindowCandidates(source,window);
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.model.mock.calls.every(([options])=>options.timeout===300_000 && options.maxRetries===0)).toBe(true);
  });

  it("allows gathering to finish after three minutes under a five-minute appsettings deadline", async () => {
    vi.stubEnv("EVIDENCE_GATHER_TIMEOUT_MS", "300000");
    let finish!: (value: unknown) => void;
    const calls = agents(()=>new Promise(resolve=>{finish=resolve;}));
    const extractor = new EvidenceExtractor("account", "source", semaphore()) as any;
    const running = extractor.gatherWindowCandidates(source,window);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(calls.find(call=>call.stage==="independent")!.signal.aborted).toBe(false);
    finish({events:[],facts:[],claims:[]});
    await expect(running).resolves.toEqual([]);
  });

  it("checkpoints a timeout split, ignores late output, and restores successful passes after restart", async () => {
    const {saved, store} = stages();
    const permits = semaphore();
    let finishLate!: (value: unknown) => void;
    const calls = agents(() => new Promise(resolve => { finishLate = resolve; }));
    const first = new EvidenceExtractor("account", "source", permits, store) as any;
    const failed = expect(first.gatherWindowCandidates(source, window, context)).rejects.toBeInstanceOf(EvidenceGatheringTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    expect(saved.has(`independent:segment:${window.startOffset}:${window.text.length}:0:partition`)).toBe(true);
    expect(saved.has("independent")).toBe(false);
    expect(calls.find(call => call.stage === "independent")!.signal.aborted).toBe(true);
    expect(permits.release).toHaveBeenCalledTimes(4);
    const beforeLate = structuredClone([...saved]);
    finishLate({events: [], facts: [fact("Late result")], claims: []});
    await vi.advanceTimersByTimeAsync(0);
    expect([...saved]).toEqual(beforeLate);
    expect(permits.release).toHaveBeenCalledTimes(4);

    const resumedCalls = agents(async target => ({events: [], facts: [fact(target.text.trim())], claims: []}));
    const restarted = new EvidenceExtractor("account", "source", permits, store) as any;
    const candidates = await restarted.gatherWindowCandidates(source, window, context);
    expect(resumedCalls).toHaveLength(2);
    expect(resumedCalls.every(call => call.stage === "independent")).toBe(true);
    expect(resumedCalls.map(call => call.target.text).join("")).toBe(window.text);
    expect(candidates).toHaveLength(2);
    expect(saved.has("independent")).toBe(true);
    // Every gathering invocation uses the client without SDK retries; initial
    // reconciliation clients retain their existing retry policy.
    expect(mocks.model.mock.calls.filter(([options]) => options.maxRetries === 0)).toHaveLength(3);
  });

  it("retains successful child segments and retries only the subdivided sibling", async () => {
    const {saved, store} = stages();
    let attempt = 0;
    const calls = agents(async target => {
      if (attempt === 0 || attempt === 1 && target.startOffset > 0) return new Promise(() => {});
      return {events: [], facts: [fact(target.text.trim())], claims: []};
    });
    const run = () => (new EvidenceExtractor("account", "source", semaphore(), store) as any)
      .gatherWindowCandidates(source, window, context);
    for (attempt = 0; attempt < 2; attempt++) {
      const failed = expect(run()).rejects.toBeInstanceOf(EvidenceGatheringTimeoutError);
      await vi.advanceTimersByTimeAsync(100);
      await failed;
      expect(saved.has("independent")).toBe(false);
    }
    const result = await run();
    const independent = calls.filter(call => call.stage === "independent");
    expect(independent).toHaveLength(5); // Whole page, two halves, then the failed half's two children.
    expect(calls.filter(call => call.stage !== "independent")).toHaveLength(3);
    expect(result).toHaveLength(3);
    expect(result.map((candidate: any) => candidate.item.sourceQuote)).toEqual([
      independent[1].target.text.trim(), independent[3].target.text.trim(), independent[4].target.text.trim(),
    ]);
  });

  it("stops splitting at four segments and never returns a partial candidate snapshot", async () => {
    const {saved, store} = stages();
    const calls = agents(() => new Promise(() => {}));
    for (let attempt = 0; attempt < 3; attempt++) {
      const failed = expect((new EvidenceExtractor("account", "source", semaphore(), store) as any)
        .gatherWindowCandidates(source, window, context)).rejects.toBeInstanceOf(EvidenceGatheringTimeoutError);
      await vi.advanceTimersByTimeAsync(100);
      await failed;
      expect(saved.has("independent")).toBe(false);
    }
    expect(calls.filter(call => call.stage === "independent")).toHaveLength(7);
    expect([...saved.keys()].filter(key => key.endsWith(":partition"))).toHaveLength(3);
  });

  it("leaves rate limits to durable backoff instead of splitting the source", async () => {
    const {saved, store} = stages();
    agents(async () => { throw new EvidenceModelRateLimitError(60_000, new Error("Rate limited")); });
    await expect((new EvidenceExtractor("account", "source", semaphore(), store) as any)
      .gatherWindowCandidates(source, window, context)).rejects.toBeInstanceOf(EvidenceModelRateLimitError);
    expect([...saved.keys()].some(key => key.endsWith(":partition"))).toBe(false);
  });

  it("starts the deadline after model admission and shares it across missing-response retries", async () => {
    let admit!: (value: boolean) => void;
    const permits = {acquire: vi.fn(() => new Promise<boolean>(resolve => { admit = resolve; })), release: vi.fn()};
    const invoke = vi.fn().mockResolvedValueOnce({structuredResponse: null})
      .mockImplementation(() => new Promise(() => {}));
    mocks.agent.mockReturnValue({invoke});
    const extractor = new EvidenceExtractor("account", "source", permits) as any;
    const failed = expect(extractor.invokeStructured(z.object({facts: z.array(z.string())}), "Test", "{}",
      extractor.primaryModel, "primary-facts", source, {gatheringTimeoutMs: 100})).rejects.toBeInstanceOf(EvidenceGatheringTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoke).not.toHaveBeenCalled();
    admit(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(permits.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(permits.release).toHaveBeenCalledTimes(1);
  });
});
