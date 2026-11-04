import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {startEvidenceQueueWorker} from "../src/processors/evidence/evidenceQueueWorker.js";
import type {EvidenceTaskLane} from "../src/processors/evidence/evidenceTaskQueue.js";

const lifecycle = vi.hoisted(()=>({receive:vi.fn(),process:vi.fn(),get:vi.fn(),recover:vi.fn(),
  prune:vi.fn(),close:vi.fn(),telemetry:vi.fn(),event:vi.fn(),artifact:vi.fn(),producerClose:vi.fn(),delete:vi.fn(),update:vi.fn()}));
vi.mock("../src/processors/evidence/evidenceQueueClient.js",()=>({createEvidenceTaskQueue:()=>({
  transport:{client:async()=>({receiveMessages:lifecycle.receive,deleteMessage:lifecycle.delete,updateMessage:lifecycle.update})},
  store:{get:lifecycle.get,artifact:lifecycle.artifact,pruneTerminal:lifecycle.prune},recover:lifecycle.recover,process:lifecycle.process,
})}));
vi.mock("../src/processors/evidence/evidenceCheckpoint.js",()=>({BlobEvidenceCheckpointStore:class{}}));
vi.mock("../src/processors/evidence/evidenceWorkStore.js",()=>({BlobEvidenceWorkStore:class{}}));
vi.mock("../src/processors/appInsights.js",()=>({telemetryClient:{shutdown:lifecycle.telemetry,trackEvent:lifecycle.event}}));
vi.mock("@azure/event-hubs",()=>({EventHubProducerClient:class{close=lifecycle.producerClose;}}));
vi.mock("@azure/identity",()=>({DefaultAzureCredential:class{}}));
vi.mock("node:http",()=>({createServer:()=>({listen(){},close:lifecycle.close})}));
vi.mock("node:timers/promises",()=>({setTimeout:(ms:number,_value:unknown,options?:{signal?:AbortSignal})=>
  new Promise<void>((resolve,reject)=>{
    const signal=options?.signal;
    if(signal?.aborted) {reject(signal.reason);return;}
    const onAbort=()=>{clearTimeout(timer);reject(signal?.reason);};
    const timer=setTimeout(()=>{signal?.removeEventListener("abort",onAbort);resolve();},ms);
    signal?.addEventListener("abort",onAbort,{once:true});
  })}));

describe("queue worker deployment shutdown",()=>{
  let terminate:()=>void;
  beforeEach(()=>{
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.stubEnv("PROCESS_SHUTDOWN_TIMEOUT_MS","300000");
    vi.stubEnv("EVIDENCE_QUEUE_CONCURRENCY","1");
    vi.stubEnv("EVIDENCE_GATHER_CONCURRENCY","1");
    vi.stubEnv("EVIDENCE_RECONCILIATION_CONCURRENCY","1");
    vi.stubEnv("EVIDENCE_REPAIR_CONCURRENCY","1");
    vi.stubEnv("STORAGE_ACCOUNT_NAME","evidencetest");
    vi.stubEnv("EVENTHUB_NAMESPACE","test.servicebus.windows.net");
    const once = process.once;
    vi.spyOn(process,"once").mockImplementation((name,listener)=>{
      if(name==="SIGTERM") terminate=listener;
      if(name==="SIGTERM" || name==="SIGINT") return process;
      return once.call(process,name,listener);
    });
    vi.spyOn(process,"exit").mockImplementation(()=>undefined as never);
    vi.spyOn(console,"info").mockImplementation(()=>{});
    vi.spyOn(console,"error").mockImplementation(()=>{});
    lifecycle.receive.mockResolvedValue({receivedMessageItems:[]});
    lifecycle.update.mockResolvedValue({popReceipt:"renewed-receipt"});
    lifecycle.artifact.mockResolvedValue({pageContent:"Page one<!-- PageBreak -->Page two",metadata:{pages:[1,2]}});
  });
  afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.restoreAllMocks();});
  const lanes:EvidenceTaskLane[]=["gather","reconcile","review","repair","finalize"];

  it.each(lanes)("retains a busy %s notification until redelivery acquires the task",async lane=>{
    const item={messageId:"message",popReceipt:"receipt",
      messageText:JSON.stringify({version:1,taskId:"a".repeat(64)})};
    const redelivery=Promise.withResolvers<{receivedMessageItems:typeof item[]}>();
    lifecycle.receive.mockResolvedValueOnce({receivedMessageItems:[item]}).mockReturnValueOnce(redelivery.promise);
    lifecycle.get.mockResolvedValue({id:"a".repeat(64),definition:{correlation:{accountId:"account",sourceId:"391"}}});
    lifecycle.process.mockResolvedValueOnce(false).mockResolvedValue(true);
    const running=startEvidenceQueueWorker(lane);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.process).toHaveBeenCalledOnce();
    expect(lifecycle.delete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lifecycle.delete).not.toHaveBeenCalled();
    redelivery.resolve({receivedMessageItems:[{...item,popReceipt:"redelivered"}]});
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.process).toHaveBeenCalledTimes(2);
    expect(lifecycle.delete).toHaveBeenCalledExactlyOnceWith("message","redelivered");
    terminate();await running;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(lanes)("exits %s cleanly after draining despite remaining SDK handles",async lane=>{
    const running=startEvidenceQueueWorker(lane);
    await vi.advanceTimersByTimeAsync(0);
    terminate();
    await running;
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(lifecycle.telemetry).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers finalizer wake-ups while task cleanup is still scanning",async()=>{
    const cleanup=Promise.withResolvers<void>();
    lifecycle.prune.mockReturnValueOnce(cleanup.promise);
    const running=startEvidenceQueueWorker("finalize");
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.prune).toHaveBeenCalledOnce();
    expect(lifecycle.recover).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(lifecycle.recover).toHaveBeenCalledTimes(2);
    terminate();
    expect(lifecycle.prune.mock.calls[0]?.[0].aborted).toBe(true);
    cleanup.resolve();
    await running;
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each([
    ["primary-events",{events:[]},"gather","evidence_structured_invalid"],
    ["primary-facts",{facts:[]},"gather","evidence_structured_invalid"],
    ["primary-claims",{claims:[]},"gather","evidence_structured_invalid"],
    ["independent",{events:[],facts:[],claims:[]},"gather","evidence_structured_invalid"],
    ["primary-claims",{claims:[]},"repair","content_filter"],
  ] as const)("records an omitted %s unit without stopping the job",async(stage,expected,lane,error)=>{
    const id="a".repeat(64);
    const task={id,error,definition:{correlation:{accountId:"account",sourceId:"391",jobId:"job"},
      payload:{version:1,component:"gathering-unit",context:{identity:{accountId:"account",sourceId:"391",runFingerprint:"fingerprint"},windowIndex:0},
        batchId:"page-10",candidates:[],sourceArtifact:"b".repeat(64),initialReviewer:"reconciliation",allowFailover:false,
        gathering:{stage,startOffset:0,characterCount:4777,depth:0}}}};
    lifecycle.receive.mockResolvedValueOnce({receivedMessageItems:[{messageId:"message",popReceipt:"receipt",
      messageText:JSON.stringify({version:1,taskId:id})}]});
    lifecycle.get.mockResolvedValue(task);
    lifecycle.process.mockImplementation(async(_id,_lane,_execute,terminal)=>{
      expect(await terminal(task)).toEqual({result:expected});
      return true;
    });
    const running=startEvidenceQueueWorker(lane);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.event).toHaveBeenCalledWith(expect.objectContaining({name:"EvidenceGatheringUnitDropped",
      properties:expect.objectContaining({taskId:id,batchId:"page-10",stage})}));
    terminate();await running;
    expect(lifecycle.delete).toHaveBeenCalledExactlyOnceWith("message","receipt");
  });

  it("fails a one-page document visibly instead of returning empty evidence",async()=>{
    const id="a".repeat(64);
    const task={id,error:"evidence_structured_invalid",definition:{correlation:{accountId:"account",sourceId:"one-page",jobId:"job"},
      payload:{version:1,component:"gathering-unit",context:{identity:{accountId:"account",sourceId:"one-page",runFingerprint:"fingerprint"},windowIndex:0},
        batchId:"page-1",candidates:[],sourceArtifact:"b".repeat(64),initialReviewer:"reconciliation",allowFailover:false,
        gathering:{stage:"primary-claims",startOffset:0,characterCount:900,depth:0}}}};
    lifecycle.artifact.mockResolvedValue({pageContent:"One page of text",metadata:{pages:[1]}});
    lifecycle.receive.mockResolvedValueOnce({receivedMessageItems:[{messageId:"message",popReceipt:"receipt",
      messageText:JSON.stringify({version:1,taskId:id})}]});
    lifecycle.get.mockResolvedValue(task);
    lifecycle.process.mockImplementation(async(_id,_lane,_execute,terminal)=>{
      expect(await terminal(task)).toBeUndefined();
      return true;
    });
    const running=startEvidenceQueueWorker("gather");
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.event).toHaveBeenCalledWith(expect.objectContaining({name:"EvidenceGatheringUnitRejected",
      properties:expect.objectContaining({taskId:id,batchId:"page-1"})}));
    terminate();await running;
  });

  it.each(["task","outbox","telemetry","broker"])("forces finalizer exit when %s stalls",async stall=>{
    const pending=Promise.withResolvers<void>();
    if(stall==="task") {
      lifecycle.receive.mockResolvedValueOnce({receivedMessageItems:[{messageId:"message",popReceipt:"receipt",
        messageText:JSON.stringify({version:1,taskId:"a".repeat(64)})}]});
      lifecycle.get.mockResolvedValue({id:"a".repeat(64),definition:{correlation:{accountId:"account",sourceId:"391"}}});
      lifecycle.process.mockReturnValue(pending.promise);
    }
    if(stall==="outbox") lifecycle.recover.mockReturnValue(pending.promise);
    if(stall==="telemetry") lifecycle.telemetry.mockReturnValue(pending.promise);
    if(stall==="broker") lifecycle.producerClose.mockReturnValue(pending.promise);
    const running=startEvidenceQueueWorker("finalize");
    await vi.advanceTimersByTimeAsync(0);
    if(stall==="task") expect(lifecycle.process).toHaveBeenCalledOnce();
    terminate();
    await vi.advanceTimersByTimeAsync(299999);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    if(stall==="task") expect(lifecycle.delete).not.toHaveBeenCalled();
    pending.resolve();
    await running;
    expect(process.exit).toHaveBeenCalledOnce();
  });

  it("leaves a receive completed after termination unacknowledged instead of starting a task",async()=>{
    const received=Promise.withResolvers<{receivedMessageItems:unknown[]}>();
    lifecycle.receive.mockReturnValue(received.promise);
    const running=startEvidenceQueueWorker("finalize");
    await vi.advanceTimersByTimeAsync(0);
    terminate();
    received.resolve({receivedMessageItems:[{messageId:"message",popReceipt:"receipt",
      messageText:JSON.stringify({version:1,taskId:"a".repeat(64)})}]});
    await running;
    expect(lifecycle.process).not.toHaveBeenCalled();
    expect(lifecycle.delete).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("waits for active task completion and acknowledges it before graceful exit",async()=>{
    const task=Promise.withResolvers<void>();
    lifecycle.receive.mockResolvedValueOnce({receivedMessageItems:[{messageId:"message",popReceipt:"receipt",
      messageText:JSON.stringify({version:1,taskId:"a".repeat(64)})}]});
    lifecycle.get.mockResolvedValue({id:"a".repeat(64),definition:{correlation:{accountId:"account",sourceId:"391"}}});
    lifecycle.process.mockReturnValue(task.promise);
    const running=startEvidenceQueueWorker("finalize");
    await vi.advanceTimersByTimeAsync(0);
    terminate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(lifecycle.delete).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    task.resolve();
    await running;
    expect(lifecycle.delete).toHaveBeenCalledExactlyOnceWith("message","receipt");
    expect(lifecycle.receive).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("starts no task when its checkpoint lookup completes after termination",async()=>{
    const lookup=Promise.withResolvers<unknown>();
    lifecycle.receive.mockResolvedValueOnce({receivedMessageItems:[{messageId:"message",popReceipt:"receipt",
      messageText:JSON.stringify({version:1,taskId:"a".repeat(64)})}]});
    lifecycle.get.mockReturnValue(lookup.promise);
    const running=startEvidenceQueueWorker("finalize");
    await vi.advanceTimersByTimeAsync(0);
    terminate();
    lookup.resolve({id:"a".repeat(64),definition:{correlation:{accountId:"account",sourceId:"391"}}});
    await running;
    expect(lifecycle.process).not.toHaveBeenCalled();
    expect(lifecycle.delete).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
