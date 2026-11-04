import { afterEach, describe, expect, it, vi } from "vitest";
import { evidenceTaskHarness } from "./helpers/evidenceTaskHarness.js";
import { EvidenceReviewPending, currentEvidenceTaskCancellation } from "../src/processors/evidence/evidenceAsync.js";
import { EvidenceBudgetError } from "../src/processors/evidence/evidenceCostBudget.js";
import { EvidenceTaskRetry, type EvidenceTaskDefinition } from "../src/processors/evidence/evidenceTaskQueue.js";
import { EvidenceUnresolvedError } from "../src/processors/evidence/evidenceUnresolvedError.js";
import { EvidenceGatheringOutputLimitError, EvidenceGatheringPartitionScheduledError } from "../src/processors/evidence/evidenceGathering.js";
const definition: EvidenceTaskDefinition = {lane: "review", payload: {batch: 1},
  correlation: {accountId: "account", sourceId: "source", jobId: "job"}, maxAttempts: 3, allowFailover: true};
afterEach(() => vi.unstubAllEnvs());

describe("durable evidence task queues", () => {
  it("resumes a saved output-limit partition even after earlier attempts", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition,lane:"gather",maxAttempts:16,
      payload:{component:"gathering-unit",batchId:"page-64-independent"}});
    h.records.get(id)!.attempts = 5;
    await h.queue.process(id,"gather",async () => {
      throw new EvidenceGatheringPartitionScheduledError(new EvidenceGatheringOutputLimitError("output token limit"));
    });
    expect(h.records.get(id)).toMatchObject({status:"pending",lane:"gather",attempts:6,
      error:"evidence_output_limit_partitioned"});
    await h.queue.process(id,"gather",async () => ({events:[],facts:[],claims:[]}));
    expect(h.records.get(id)).toMatchObject({status:"completed",lane:"gather",attempts:7});
  });
  it("sends an unsplittable output-limit unit to rescue, then omits only that unit after bounded failures", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition,lane:"gather",maxAttempts:16,
      payload:{component:"gathering-unit",batchId:"page-64-independent"}});
    const failed = vi.fn(async () => {throw new EvidenceGatheringOutputLimitError("output token limit");});
    const terminal = vi.fn(async () => ({result:{events:[],facts:[],claims:[]}}));
    await h.queue.process(id,"gather",failed,terminal);
    expect(h.records.get(id)).toMatchObject({status:"pending",lane:"repair",attempts:0,error:"evidence_output_limit"});
    for (let attempt=1;attempt<=3;attempt++) {
      await h.queue.process(id,"repair",failed,terminal);
      if (attempt<3) h.advance(60_000);
    }
    expect(failed).toHaveBeenCalledTimes(4);
    expect(terminal).toHaveBeenCalledOnce();
    expect(h.records.get(id)).toMatchObject({status:"completed",lane:"repair",attempts:3,
      error:"evidence_output_limit"});
    expect(await h.store.isJobStopped(definition.correlation)).toBe(false);
  });
  it("retires one gathering unit after three malformed schemas without stopping its sibling", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition,lane:"gather",allowFailover:false,maxAttempts:16,
      payload:{component:"gathering-unit",batchId:"page-10-claims"}});
    const sibling = await h.queue.submit({...definition,lane:"gather",allowFailover:false,maxAttempts:16,
      payload:{component:"gathering-unit",batchId:"page-10-facts"}});
    const execute = vi.fn(async () => { throw new Error("Failed to parse structured output for tool 'providerStrategy':\n"
      + "  - Model output did not satisfy the provided response schema.."); });
    const terminal = vi.fn(async () => ({result:{claims:[]}}));
    for (let attempt = 1; attempt <= 3; attempt++) {
      await h.queue.process(id,"gather",execute,terminal);
      if (attempt < 3) {
        expect(h.records.get(id)).toMatchObject({status:"pending",attempts:attempt,error:"evidence_structured_invalid"});
        h.advance(60_000);
      }
    }
    expect(h.records.get(id)).toMatchObject({status:"completed",attempts:3,result:{claims:[]},
      error:"evidence_structured_invalid"});
    expect(terminal).toHaveBeenCalledOnce();
    expect(await h.store.isJobStopped(definition.correlation)).toBe(false);
    await h.queue.process(sibling,"gather",async () => ({facts:[]}));
    expect(h.records.get(sibling)).toMatchObject({status:"completed",result:{facts:[]}});
  });
  it("retries a failed gathering terminal callback without another model request", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition,lane:"gather",allowFailover:false,maxAttempts:16,
      payload:{component:"gathering-unit",batchId:"page-10-claims"}});
    const execute = vi.fn(async () => {throw new Error("Failed to parse structured output for tool 'providerStrategy':\n"
      + "  - Model output did not satisfy the provided response schema..");});
    const terminal = vi.fn().mockRejectedValueOnce(new Error("Storage temporarily unavailable"))
      .mockResolvedValueOnce({result:{claims:[]}});
    for(let attempt=1;attempt<=3;attempt++) {
      if(attempt===3)await expect(h.queue.process(id,"gather",execute,terminal)).rejects.toThrow("Storage temporarily unavailable");
      else {await h.queue.process(id,"gather",execute,terminal);h.advance(60_000);}
    }
    expect(h.records.get(id)).toMatchObject({status:"pending",attempts:3,error:"evidence_structured_invalid"});
    await h.queue.process(id,"gather",execute,terminal);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(terminal).toHaveBeenCalledTimes(2);
    expect(h.records.get(id)).toMatchObject({status:"completed",attempts:3,result:{claims:[]}});
  });
  it("stops a wrapped content-filter refusal without retrying the same review", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition, allowFailover:false});
    const execute = vi.fn(async () => { throw new EvidenceTaskRetry(true,
      new Error("provider rejected", {cause:Object.assign(new Error("filtered"), {status:400, code:"content_filter"})})); });
    const terminal = vi.fn(async () => undefined);
    await h.queue.process(id, "review", execute, terminal);
    expect(h.records.get(id)).toMatchObject({status:"failed", attempts:1, error:"content_filter", poisonSent:true});
    expect(terminal).not.toHaveBeenCalled();
    h.advance(60_000);
    await h.queue.process(id, "review", execute, terminal);
    expect(execute).toHaveBeenCalledOnce();
  });
  it("moves a filtered fast window straight to its configured repair model", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition, lane:"gather", payload:{component:"fast-window"}});
    await h.queue.process(id, "gather", async () => {throw Object.assign(new Error("filtered"), {code:"content_filter"});});
    expect(h.records.get(id)).toMatchObject({status:"pending", lane:"repair", attempts:0});
  });
  it("routes a filtered gathering unit to Claude once and retains its terminal decision", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition,lane:"gather",maxAttempts:16,
      payload:{component:"gathering-unit",batchId:"page-10-claims"}});
    const primary = vi.fn(async () => {throw Object.assign(new Error("filtered"), {status:400,code:"content_filter"});});
    await h.queue.process(id,"gather",primary);
    expect(h.records.get(id)).toMatchObject({status:"pending",lane:"repair",attempts:0,error:"content_filter"});
    const rescue = vi.fn(async () => {throw Object.assign(new Error("filtered"), {status:400,code:"content_filter"});});
    const terminal = vi.fn().mockRejectedValueOnce(new Error("Storage unavailable"))
      .mockResolvedValueOnce({result:{claims:[]}});
    await expect(h.queue.process(id,"repair",rescue,terminal)).rejects.toThrow("Storage unavailable");
    await h.queue.process(id,"repair",rescue,terminal);
    expect(primary).toHaveBeenCalledOnce();
    expect(rescue).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledTimes(2);
    expect(h.records.get(id)).toMatchObject({status:"completed",lane:"repair",result:{claims:[]}});
    expect(await h.store.isJobStopped(definition.correlation)).toBe(false);
  });
  it("escalates an unresolved primary review once, then stops an unresolved repair", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit(definition);
    const execute = vi.fn(async () => {throw new EvidenceTaskRetry(false,new EvidenceUnresolvedError(4));});
    await h.queue.process(id,"review",execute);
    expect(h.records.get(id)).toMatchObject({status:"pending",lane:"repair",attempts:0,error:"evidence_unresolved"});
    await h.queue.process(id,"repair",execute);
    expect(h.records.get(id)).toMatchObject({status:"failed",lane:"repair",attempts:1,error:"evidence_unresolved",poisonSent:true});
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("stops sibling work after terminal repair failure but permits a new job or another account", async () => {
    const h = evidenceTaskHarness();
    const failing = await h.queue.submit({...definition, lane:"repair", allowFailover:false});
    const sibling = await h.queue.submit({...definition, lane:"gather", payload:{batch:2}});
    await h.queue.process(failing,"repair",async()=>{throw new EvidenceUnresolvedError(4);});
    expect(await h.store.isJobStopped(definition.correlation)).toBe(true);
    const execute = vi.fn(async()=>"should not run");
    await h.queue.process(sibling,"gather",execute);
    expect(execute).not.toHaveBeenCalled();
    expect(h.records.get(sibling)).toMatchObject({status:"failed",error:"evidence_job_stopped"});
    const sameJob = await h.queue.submit({...definition,payload:{batch:3}});
    expect(h.records.get(sameJob)).toMatchObject({status:"failed",error:"evidence_job_stopped"});
    const nextJob = await h.queue.submit({...definition,payload:{batch:3},
      correlation:{...definition.correlation,jobId:"next-job"}});
    const otherAccount = await h.queue.submit({...definition,payload:{batch:3},
      correlation:{...definition.correlation,accountId:"another-account"}});
    expect(h.records.get(nextJob)?.status).toBe("pending");
    expect(h.records.get(otherAccount)?.status).toBe("pending");
  });
  it("aborts an active task when its job is stopped before completion", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition,lane:"gather",allowFailover:false});
    let resume!: () => void;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const processing = h.queue.process(id,"gather",async()=>{
      const control = currentEvidenceTaskCancellation();
      expect(control).toBeDefined();
      started();
      await new Promise<void>(resolve => { resume = resolve; });
      await control!.assertOpen();
      return "late result";
    });
    await running;
    await h.store.stopJob(definition.correlation,"terminal sibling");
    resume();
    await processing;
    expect(h.records.get(id)).toMatchObject({status:"failed",error:"evidence_job_stopped"});
  });
  it.each([false, true])("finishes an active finalizer's terminal notification when a sibling stops the job (indexed=%s)", async indexed => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition,lane:"finalize",allowFailover:false});
    const terminal = vi.fn(async () => indexed ? {result:{jobId:"job"}} : undefined);
    await h.queue.process(id,"finalize",async()=>{
      await h.store.stopJob(definition.correlation,"terminal sibling");
      await currentEvidenceTaskCancellation()!.assertOpen();
    },terminal);
    expect(terminal).toHaveBeenCalledOnce();
    expect(h.records.get(id)?.status).toBe(indexed ? "completed" : "failed");
    if(indexed) expect(h.records.get(id)).toMatchObject({result:{jobId:"job"},resultHash:expect.any(String)});
    await h.queue.process(id,"finalize",vi.fn(),terminal);
    expect(terminal).toHaveBeenCalledOnce();
  });
  it("retries a stopped finalizer's failed notification without restarting extraction", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition,lane:"finalize",allowFailover:false});
    const execute = vi.fn(async()=>{
      await h.store.stopJob(definition.correlation,"terminal sibling");
      await currentEvidenceTaskCancellation()!.assertOpen();
    });
    const terminal = vi.fn().mockRejectedValueOnce(new Error("notification unavailable")).mockResolvedValue(undefined);
    await expect(h.queue.process(id,"finalize",execute,terminal)).rejects.toThrow("notification unavailable");
    expect(h.records.get(id)).toMatchObject({status:"pending",attempts:3,error:"evidence_job_stopped"});
    await h.queue.process(id,"finalize",execute,terminal);
    expect(h.records.get(id)?.status).toBe("failed");
    expect(execute).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledTimes(2);
  });
  it.each(["evidence_budget_exhausted","evidence_budget_configuration"] as const)("stops %s without escalation or cleanup",async code=>{
    const h=evidenceTaskHarness();const id=await h.queue.submit({...definition,maxAttempts:1});
    const terminal=vi.fn(async()=>{});
    await h.queue.process(id,"review",async()=>{throw new EvidenceTaskRetry(true,new Error("wrapped",{cause:new EvidenceBudgetError(code,"stop")}));},terminal);
    expect(h.records.get(id)).toMatchObject({status:"failed",lane:"review",error:code});
    expect(terminal).not.toHaveBeenCalled();
    expect(h.transport.send.mock.calls.map(([lane])=>lane)).toEqual(["review","poison"]);
    expect(h.observe.mock.calls.some(([event])=>event==="EvidenceTaskBudgetStopped")).toBe(true);
  });
  it.each(["evidence_budget_busy","evidence_budget_unavailable"] as const)("waits for %s without consuming a task attempt",async code=>{
    const h=evidenceTaskHarness();const id=await h.queue.submit({...definition,maxAttempts:1});
    const terminal=vi.fn(async()=>{});
    for(let i=0;i<5;i++) {
      await h.queue.process(id,"review",async()=>{throw new EvidenceTaskRetry(true,new EvidenceBudgetError(code,"wait"));},terminal);
      expect(h.records.get(id)).toMatchObject({status:"pending",attempts:0,lane:"review",error:code});
      h.advance(15_000);
    }
    expect(terminal).not.toHaveBeenCalled();
    await h.queue.process(id,"review",async()=>"done",terminal);
    expect(h.records.get(id)).toMatchObject({status:"completed",attempts:1});
  });
  it("retains a notification received before its dispatch lease is released", async () => {
    const h = evidenceTaskHarness();
    const execute = vi.fn(async () => "complete");
    let acknowledge: unknown;
    h.transport.send.mockImplementationOnce(async () => {
      // Queue Storage can deliver while dispatch still holds the manifest lease.
      acknowledge = await h.queue.process([...h.records.keys()][0], "review", execute);
    });
    const id = await h.queue.submit(definition);
    expect(acknowledge).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(h.records.get(id)).toMatchObject({status:"pending", attempts:0});
    h.advance(60_000); // Redelivery precedes the 15-minute outbox recovery interval.
    await expect(h.queue.process(id, "review", execute)).resolves.toBe(true);
    await expect(h.queue.process(id, "review", execute)).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(h.transport.send).toHaveBeenCalledOnce();
  });

  it("avoids amplifying queued work while retaining configurable lost-notification recovery", async () => {
    vi.stubEnv("EVIDENCE_TASK_REDISPATCH_MS", "300000");
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition, lane:"gather", allowFailover:false});
    for (let minute = 0; minute < 4; minute++) { h.advance(60_000); await h.queue.recover("gather"); }
    expect(h.transport.send).toHaveBeenCalledTimes(1);
    h.advance(60_000); await h.queue.recover("gather");
    expect(h.transport.send).toHaveBeenCalledTimes(2);
    await h.queue.process(id, "gather", async () => { throw new Error("retry"); });
    h.advance(5000); await h.queue.recover("gather");
    expect(h.transport.send).toHaveBeenCalledTimes(3); // Retry backoff is not delayed by redispatch suppression.
    await h.queue.process(id, "gather", async () => "complete");
    h.advance(300_000); await h.queue.recover("gather");
    expect(h.transport.send).toHaveBeenCalledTimes(3);
  });

  it.each(["0", "59999", "86400001", "1.5"])("rejects invalid redispatch appsettings %s", value => {
    vi.stubEnv("EVIDENCE_TASK_REDISPATCH_MS", value);
    expect(evidenceTaskHarness).toThrow("EVIDENCE_TASK_REDISPATCH_MS");
  });
  it("interleaves lost wake-ups by account, source, and job while preserving backoff and recent sends", async () => {
    const h = evidenceTaskHarness();
    const submit = (accountId: string, sourceId: string, jobId: string, batch: number) => h.queue.submit({
      ...definition, lane:"gather", allowFailover:false, payload:{batch}, correlation:{accountId,sourceId,jobId},
    });
    const large = await Promise.all([1,2,3,4].map(batch => submit("account", "391", "large", batch)));
    const otherAccount = await submit("another-account", "391", "large", 1);
    const otherJob = await submit("account", "391", "retry-job", 1);
    const small = await submit("account", "162", "small", 1);
    const delayed = await submit("account", "delayed", "delayed", 1);
    h.advance(900_000);
    h.records.get(delayed)!.availableAt += 1_800_000;
    const recent = await submit("account", "recent", "recent", 1);
    h.transport.send.mockClear();
    await h.queue.recover("gather");
    expect(h.transport.send.mock.calls.map(([lane,id])=>({lane,id}))).toEqual(
      [otherAccount,otherJob,small,...large].map(id=>({lane:"gather",id})));
    expect(h.transport.send.mock.calls.some(([,id])=>id===delayed||id===recent)).toBe(false);
  });
  it("honors provider Retry-After while retrying only a failed fast window",async()=>{
    const h=evidenceTaskHarness();
    const id=await h.queue.submit({...definition,lane:"gather",payload:{component:"fast-window"},maxAttempts:3});
    const sibling=await h.queue.submit({...definition,lane:"gather",payload:{component:"fast-window",window:2}});
    await h.queue.process(sibling,"gather",async()=>"complete");
    const start=h.records.get(id)!.availableAt;
    await h.queue.process(id,"gather",async()=>{throw Object.assign(new Error("rate limit"),{retryAfterMs:90_000});});
    expect(h.records.get(id)).toMatchObject({lane:"gather",status:"pending",attempts:1,availableAt:start+90_000});
    h.advance(60_000);const execute=vi.fn(async()=>"retry");await h.queue.process(id,"gather",execute);
    expect(execute).not.toHaveBeenCalled();expect(h.records.get(sibling)?.result).toBe("complete");
  });
  it("fails an exhausted fast repair without publishing incomplete evidence or re-running completed siblings",async()=>{
    const h=evidenceTaskHarness();const dispatcher=h.queue.dispatcher(definition.correlation);
    const task={version:1 as const,component:"fast-window" as const,context:{identity:{accountId:"account",sourceId:"source",runFingerprint:"fingerprint"},windowIndex:0},
      batchId:"fast",candidates:[],initialReviewer:"reconciliation" as const,allowFailover:true};
    const source={pageContent:"source",metadata:{}};
    await expect(dispatcher.result(task,source,1)).rejects.toBeInstanceOf(EvidenceReviewPending);
    const id=[...h.records.keys()][0];
    await h.queue.process(id,"gather",async()=>{throw new Error("missing");});
    await h.queue.process(id,"repair",async()=>{throw new Error("still missing");});
    expect(h.records.get(id)).toMatchObject({status:"failed",poisonSent:true});
    await expect(dispatcher.result(task,source,1)).rejects.toThrow("exhausted its retry budget");
  });
  it("persists source batches with their page-based retry limit and restores completed source plans", async () => {
    const h = evidenceTaskHarness();
    const dispatcher = h.queue.dispatcher(definition.correlation,3);
    const task = {version:1 as const,component:"source-support" as const,
      context:{identity:{accountId:"account",sourceId:"source",runFingerprint:"fingerprint"},windowIndex:0},
      batchId:"batch",candidates:[],initialReviewer:"reconciliation" as const,allowFailover:false};
    const source={pageContent:"source",metadata:{}};
    h.transport.send.mockRejectedValueOnce(new Error("Queue unavailable"));
    await expect(dispatcher.result(task,source,19)).rejects.toBeInstanceOf(EvidenceReviewPending);
    const record=[...h.records.values()][0];
    expect(record.lane).toBe("reconcile");
    expect(record.definition.maxAttempts).toBe(19); // 120 pages: initial attempt plus 18 retries.
    await h.queue.recover("reconcile");
    expect(h.transport.send).toHaveBeenLastCalledWith("reconcile",record.id);
    const execute=vi.fn(async()=>({accepted:{events:[],facts:[],claims:[]}}));
    await h.queue.process(record.id,"reconcile",execute);
    await h.queue.process(record.id,"reconcile",execute);
    expect(execute).toHaveBeenCalledOnce();
    await expect(dispatcher.result(task,source,19)).resolves.toEqual({accepted:{events:[],facts:[],claims:[]}});
  });
  it("propagates a stopped child task's budget code to its finalizer",async()=>{
    const h=evidenceTaskHarness(),dispatcher=h.queue.dispatcher(definition.correlation);
    const task={version:1 as const,component:"source-support" as const,
      context:{identity:{accountId:"account",sourceId:"source",runFingerprint:"fingerprint"},windowIndex:0},
      batchId:"batch",candidates:[],initialReviewer:"reconciliation" as const,allowFailover:false};
    const source={pageContent:"source",metadata:{}};
    await expect(dispatcher.result(task,source)).rejects.toBeInstanceOf(EvidenceReviewPending);
    const id=[...h.records.keys()][0];
    await h.queue.process(id,"reconcile",async()=>{throw new EvidenceBudgetError("evidence_budget_exhausted","stop");});
    await expect(dispatcher.result(task,source)).rejects.toMatchObject({code:"evidence_budget_exhausted"});
  });
  it("recovers a persisted task when the initial Queue send fails", async () => {
    const h = evidenceTaskHarness();
    h.transport.send.mockRejectedValueOnce(new Error("storage unavailable"));
    const id = await h.queue.submit(definition);
    expect(h.records.get(id)?.dispatchedAt).toBe(0);
    expect(h.observe).toHaveBeenCalledWith("EvidenceTaskDispatchDeferred", expect.objectContaining({id}));
    expect(h.records.size).toBe(1);
    await h.queue.recover();
    expect(h.transport.send).toHaveBeenLastCalledWith("review", [...h.records.keys()][0]);
  });
  it("executes a duplicate delivery only once, including concurrent deliveries", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit(definition);
    let release!: () => void;
    const execute = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return {valid: true}; });
    const first = h.queue.process(id, "review", execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await expect(h.queue.process(id, "review", execute)).resolves.toBe(false);
    release(); await first;
    await h.queue.process(id, "review", execute);
    expect(execute).toHaveBeenCalledOnce();
    expect(h.records.get(id)).toMatchObject({status: "completed", result: {valid: true}});
    expect(await h.queue.submit(definition)).toBe(id);
  });
  it("sends only a failed component to repair and ignores stale review notifications", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit(definition);
    const sibling = await h.queue.submit({...definition, payload: {batch: 2}});
    await h.queue.process(sibling, "review", async () => "complete");
    await h.queue.process(id, "review", async () => { throw new Error("model failure"); });
    expect(h.records.get(id)).toMatchObject({lane: "repair", attempts: 0});
    const repaired = vi.fn(async () => "repaired");
    await h.queue.process(id, "review", repaired);
    expect(repaired).not.toHaveBeenCalled();
    await h.queue.process(id, "repair", repaired);
    expect(h.records.get(id)).toMatchObject({status: "completed", result: "repaired"});
    expect(h.records.get(sibling)?.result).toBe("complete");
  });
  it("preserves a repair transition if sending its queue message fails", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit(definition);
    h.transport.send.mockRejectedValueOnce(new Error("send failed"));
    await expect(h.queue.process(id, "review", async () => { throw new Error(); })).rejects.toThrow("send failed");
    expect(h.records.get(id)?.lane).toBe("repair");
    await h.queue.recover();
    expect(h.transport.send).toHaveBeenLastCalledWith("repair", id);
  });
  it("waits without consuming retries or publishing an incomplete result", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition, lane: "finalize"});
    for (let i = 0; i < 8; i++) {
      await h.queue.process(id, "finalize", async () => { throw new EvidenceReviewPending(); });
      h.advance(20_000);
    }
    expect(h.records.get(id)).toMatchObject({status: "pending", attempts: 0});
    expect(h.records.get(id)?.result).toBeUndefined();
    await h.queue.process(id, "finalize", async () => "validated");
    expect(h.records.get(id)?.status).toBe("completed");
  });
  it("poisons exhausted tasks and retries failed terminal notification without running the model again", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition, lane: "repair", maxAttempts: 1});
    const execute = vi.fn(async () => { throw new Error("failed"); });
    const terminal = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("notification unavailable"));
    await expect(h.queue.process(id, "repair", execute, terminal)).rejects.toThrow("notification unavailable");
    await h.queue.process(id, "repair", execute, terminal);
    expect(execute).toHaveBeenCalledOnce();
    expect(h.records.get(id)?.status).toBe("failed");
    expect(h.transport.send).toHaveBeenLastCalledWith("poison", id);
  });
  it("recovers a failed poison-queue send", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition, lane: "repair", maxAttempts: 1});
    h.transport.send.mockRejectedValueOnce(new Error("poison send failed"));
    await expect(h.queue.process(id, "repair", async () => { throw new Error(); })).rejects.toThrow("poison send failed");
    await h.queue.recover();
    expect(h.records.get(id)).toMatchObject({status: "failed", poisonSent: true});
  });
  it("rejects completion after lease loss and preserves the attempt consumed before execution", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit(definition);
    await expect(h.queue.process(id, "review", async () => { h.loseLease(); return "late"; })).rejects.toThrow("lease lost");
    expect(h.records.get(id)).toMatchObject({status: "pending", attempts: 1});
    expect(h.records.get(id)?.result).toBeUndefined();
    h.recoverLease(); h.advance(61_000); await h.queue.recover();
    await h.queue.process(id, "review", async () => "valid");
    expect(h.records.get(id)?.result).toBe("valid");
  });
  it("uses the extraction job's retry budget for finalization failures", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition, lane: "finalize", maxAttempts: 1});
    await h.queue.process(id, "finalize", async () => { throw new EvidenceTaskRetry(false, new Error()); });
    expect(h.records.get(id)?.status).toBe("pending");
    h.advance(31_000);
    await h.queue.process(id, "finalize", async () => { throw new EvidenceTaskRetry(true, new Error()); });
    expect(h.records.get(id)?.status).toBe("failed");
  });
  it("rejects a modified completed result before returning it to the coordinator", async () => {
    const h = evidenceTaskHarness();
    const dispatcher = h.queue.dispatcher(definition.correlation);
    const task = {version: 1 as const, component: "dates" as const, context: {
      identity: {accountId: "account", sourceId: "source", runFingerprint: "fingerprint"}, windowIndex: 0},
      batchId: "batch", candidates: [], initialReviewer: "reconciliation" as const, allowFailover: true};
    const source = {pageContent: "source", metadata: {}};
    await expect(dispatcher.result(task, source)).rejects.toBeInstanceOf(EvidenceReviewPending);
    const id = [...h.records.keys()][0];
    await h.queue.process(id, "review", async () => ({validated: true}));
    await expect(dispatcher.result(task, source)).resolves.toEqual({validated: true});
    h.records.get(id)!.result = {modified: true};
    await expect(dispatcher.result(task, source)).rejects.toThrow("checksum mismatch");
  });

  it("recovers an already completed indexing job after the coordinator consumed its last attempt", async () => {
    const h = evidenceTaskHarness();
    const id = await h.queue.submit({...definition, lane: "finalize", maxAttempts: 1});
    h.records.get(id)!.attempts = 1; // Simulates a crash after the job success marker, before task completion.
    const execute = vi.fn();
    await h.queue.process(id, "finalize", execute, async () => ({result: {jobId: "already-completed"}}));
    expect(execute).not.toHaveBeenCalled();
    expect(h.records.get(id)?.status).toBe("completed");
    expect(h.transport.send).not.toHaveBeenCalledWith("poison", id);
  });

  it("does not reuse tasks after changing source, configuration, or job identity", async () => {
    const h = evidenceTaskHarness();
    const ids = await Promise.all([definition, {...definition, payload: {batch: 1, fingerprint: "changed"}},
      {...definition, correlation: {...definition.correlation, jobId: "new"}}].map(value => h.queue.submit(value)));
    expect(new Set(ids).size).toBe(3);
  });
});
