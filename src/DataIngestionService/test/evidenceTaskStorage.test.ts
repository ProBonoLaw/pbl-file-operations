import { BlobServiceClient, BlockBlobClient } from "@azure/storage-blob";
import { QueueServiceClient, QueueClient } from "@azure/storage-queue";
import { BlobEvidenceCheckpointStore } from "../src/processors/evidence/evidenceCheckpoint.js";
import { withReconciliationDeadline, reconciliationCheckpointGuard, EvidenceReconciliationTimeoutError } from "../src/processors/evidence/evidenceReconciliationDeadline.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { BlobOperationOrderStore } from "../src/operationOrderStore.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { BlobEvidenceTaskStore, StorageEvidenceTaskTransport, EvidenceTaskQueue, evidenceTaskHash,
  type EvidenceTaskDefinition } from "../src/processors/evidence/evidenceTaskQueue.js";

// Explicitly local-only: these tests never accept a cloud storage connection string.
const key = Buffer.from("local-evidence-queue-test-key-only").toString("base64");
const connection = `DefaultEndpointsProtocol=http;AccountName=evidencetest;AccountKey=${key};BlobEndpoint=http://127.0.0.1:10070/evidencetest;QueueEndpoint=http://127.0.0.1:10071/evidencetest;`;
const definition = (): EvidenceTaskDefinition => ({lane: "review", payload: {testId: randomUUID()},
  correlation: {accountId: "test", sourceId: "test", jobId: randomUUID()}, maxAttempts: 3, allowFailover: true});
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.env.EVIDENCE_QUEUE_AZURITE_TESTS !== "1")("Azure Storage queue and blob integration (Azurite)", () => {
  it("isolates the same job, stop marker, checkpoint, and source order across Test and Production in one account", async () => {
    const clients = ["test", "production"].map(environment => {
      const settings = JSON.parse(readFileSync(new URL(`../../../.vscode/azure-${environment}.appsettings.json.example`, import.meta.url), "utf8"));
      for (const key of ["EVIDENCE_TASK_CONTAINER", "EVIDENCE_CHECKPOINT_CONTAINER", "EVIDENCE_QUEUE_PREFIX", "OPERATION_ORDER_CONTAINER"])
        vi.stubEnv(key, settings[key]);
      const store = new BlobEvidenceTaskStore(BlobServiceClient.fromConnectionString(connection));
      const transport = new StorageEvidenceTaskTransport(QueueServiceClient.fromConnectionString(connection));
      return {store, transport, queue: new EvidenceTaskQueue(store, transport),
        checkpoints: new BlobEvidenceCheckpointStore(BlobServiceClient.fromConnectionString(connection)), orders: new BlobOperationOrderStore(BlobServiceClient.fromConnectionString(connection))};
    });
    const [test, production] = clients;
    const task = definition();
    const id = await test.queue.submit(task);
    expect(await production.queue.submit(task)).toBe(id);
    await test.queue.process(id, "review", async () => ({environment: "test"}));
    expect((await test.store.get(id))?.status).toBe("completed");
    expect((await production.store.get(id))?.status).toBe("pending");
    const testQueue = await test.transport.client("review"), productionQueue = await production.transport.client("review");
    expect(testQueue.url).not.toBe(productionQueue.url);
    expect((await productionQueue.peekMessages()).peekedMessageItems.length).toBeGreaterThan(0);

    await test.store.stopJob(task.correlation, "test stop");
    expect(await test.store.isJobStopped(task.correlation)).toBe(true);
    expect(await production.store.isJobStopped(task.correlation)).toBe(false);
    const identity = {accountId: randomUUID(), sourceId: "same-source", runFingerprint: "same-run"};
    await test.checkpoints.put(identity, 0, {environment: "test"});
    await production.checkpoints.put(identity, 0, {environment: "production"});
    await test.checkpoints.clearSource(identity.accountId, identity.sourceId);
    expect(await production.checkpoints.get(identity, 0)).toEqual({environment: "production"});
    await test.orders.put(identity.accountId, identity.sourceId,
      {operation: "remove", partitionId: "0", sequenceNumber: "10", enqueuedTicks: "10"});
    expect(await production.orders.get(identity.accountId, identity.sourceId)).toBeNull();
  });

  it("redelivers a notification consumed while its sender still holds the manifest lease", async () => {
    const store = new BlobEvidenceTaskStore(BlobServiceClient.fromConnectionString(connection)), transport = new StorageEvidenceTaskTransport(QueueServiceClient.fromConnectionString(connection));
    const queue = new EvidenceTaskQueue(store, transport);
    const client = await transport.client("finalize");
    const execute = vi.fn(async () => ({validated:true}));
    const send = transport.send.bind(transport);
    let firstMessageId: string | undefined;
    let firstAcknowledgement: boolean | undefined;
    const sending = vi.spyOn(transport,"send").mockImplementationOnce(async (lane,id) => {
      await send(lane,id);
      const received = await client.receiveMessages({numberOfMessages:32,visibilityTimeout:1});
      const message = received.receivedMessageItems.find(item=>JSON.parse(item.messageText).taskId===id);
      expect(message).toBeDefined();
      firstMessageId = message!.messageId;
      firstAcknowledgement = await queue.process(id,"finalize",execute);
      // The worker leaves this message unacknowledged when process returns false.
    });
    try {
      const id = await queue.submit({...definition(),lane:"finalize",allowFailover:false});
      expect(firstMessageId).toBeTypeOf("string");
      expect(firstAcknowledgement).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      expect(await store.get(id)).toMatchObject({status:"pending",attempts:0});
      await delay(1500);
      const received = await client.receiveMessages({numberOfMessages:32,visibilityTimeout:10});
      const message = received.receivedMessageItems.find(item=>JSON.parse(item.messageText).taskId===id);
      expect(message?.messageId).toBe(firstMessageId);
      await expect(queue.process(id,"finalize",execute)).resolves.toBe(true);
      await client.deleteMessage(message!.messageId,message!.popReceipt);
      expect(execute).toHaveBeenCalledOnce();
      expect(sending).toHaveBeenCalledOnce();
      expect(await store.get(id)).toMatchObject({status:"completed",result:{validated:true}});
    } finally { sending.mockRestore(); }
  }, 15_000);

  it("recovers an expired wake-up from its durable manifest without replaying completed work", async () => {
    vi.stubEnv("EVIDENCE_TASK_REDISPATCH_MS", "60000");
    const store = new BlobEvidenceTaskStore(BlobServiceClient.fromConnectionString(connection)), transport = new StorageEvidenceTaskTransport(QueueServiceClient.fromConnectionString(connection));
    let now = Date.now();
    const queue = new EvidenceTaskQueue(store, transport, undefined, () => now);
    const client = await transport.client("gather");
    const originalSend = QueueClient.prototype.sendMessage;
    // Use one second only for this actual queue expiration; production TTL remains 60 seconds.
    const send = vi.spyOn(QueueClient.prototype, "sendMessage").mockImplementationOnce(function(text, options) {
      expect(options?.messageTimeToLive).toBe(60);
      return originalSend.call(this, text, {...options, messageTimeToLive: 1});
    });
    try {
      const id = await queue.submit({...definition(), lane:"gather", allowFailover:false});
      expect((await client.peekMessages({numberOfMessages:32})).peekedMessageItems.some(m=>JSON.parse(m.messageText).taskId===id)).toBe(true);
      await delay(2000);
      expect((await client.peekMessages({numberOfMessages:32})).peekedMessageItems.some(m=>JSON.parse(m.messageText).taskId===id)).toBe(false);
      expect(await store.get(id)).toMatchObject({status:"pending",attempts:0});
      now += 60_000;
      await queue.recover("gather");
      expect((await client.peekMessages({numberOfMessages:32})).peekedMessageItems.some(m=>JSON.parse(m.messageText).taskId===id)).toBe(true);
      const execute = vi.fn(async () => ({validated:true}));
      await queue.process(id,"gather",execute);
      now += 60_000;
      await queue.recover("gather");
      await queue.process(id,"gather",execute);
      expect(execute).toHaveBeenCalledOnce();
      expect(await store.get(id)).toMatchObject({status:"completed",result:{validated:true}});
    } finally { send.mockRestore(); }
  }, 15_000);
  it("moves an exhausted fast window from the real gather queue to repair and retains a completed sibling",async()=>{
    const store=new BlobEvidenceTaskStore(BlobServiceClient.fromConnectionString(connection)),transport=new StorageEvidenceTaskTransport(QueueServiceClient.fromConnectionString(connection));
    const queue=new EvidenceTaskQueue(store,transport);
    const input={...definition(),lane:"gather" as const,payload:{component:"fast-window",testId:randomUUID()},maxAttempts:1};
    const id=await queue.submit(input);
    const sibling=await queue.submit({...input,payload:{component:"fast-window",testId:randomUUID()}});
    await queue.process(sibling,"gather",async()=>({validated:"sibling"}));
    await queue.process(id,"gather",async()=>{throw new Error("missing model response");});
    expect(await store.get(id)).toMatchObject({lane:"repair",status:"pending",attempts:0});
    const client=await transport.client("repair");
    const messages=await client.receiveMessages({numberOfMessages:32});
    const message=messages.receivedMessageItems.find(m=>JSON.parse(m.messageText).taskId===id);
    expect(message).toBeDefined();
    const competitor=new EvidenceTaskQueue(new BlobEvidenceTaskStore(BlobServiceClient.fromConnectionString(connection)),transport);
    await competitor.process(id,"repair",async()=>({validated:"fallback"}));
    await client.deleteMessage(message!.messageId,message!.popReceipt);
    expect(await store.get(id)).toMatchObject({status:"completed",result:{validated:"fallback"}});
    expect(await store.get(sibling)).toMatchObject({status:"completed",result:{validated:"sibling"}});
  },15_000);
  it.each(["gather", "review", "reconcile"] as const)("creates, renews and acknowledges %s messages; leases fence competing workers", async lane => {
    const store = new BlobEvidenceTaskStore(BlobServiceClient.fromConnectionString(connection));
    const transport = new StorageEvidenceTaskTransport(QueueServiceClient.fromConnectionString(connection));
    const queue = new EvidenceTaskQueue(store, transport);
    const id = await queue.submit({...definition(),lane});
    const client = await transport.client(lane);
    let message;
    for (let i = 0; i < 10 && !message; i++) {
      const received = await client.receiveMessages({numberOfMessages: 32, visibilityTimeout: 10});
      message = received.receivedMessageItems.find(item => JSON.parse(item.messageText).taskId === id);
    }
    expect(message).toBeDefined();
    const renewed = await client.updateMessage(message!.messageId, message!.popReceipt, undefined, 60);
    expect(renewed.popReceipt).toBeTruthy();
    let release!: () => void;
    const execute = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return {validated: true}; });
    const processing = queue.process(id, lane, execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const competitor = new EvidenceTaskQueue(new BlobEvidenceTaskStore(BlobServiceClient.fromConnectionString(connection)), transport);
    await expect(competitor.process(id, lane, execute)).resolves.toBe(false);
    expect(execute).toHaveBeenCalledOnce();
    release(); await processing;
    await client.deleteMessage(message!.messageId, renewed.popReceipt!);
    await competitor.process(id, lane, execute);
    expect(execute).toHaveBeenCalledOnce();
    expect(await store.get(id)).toMatchObject({status: "completed", result: {validated: true}});
  }, 15_000);

  it("cannot restore a real uploaded checkpoint whose acknowledgement arrives after timeout", async () => {
    const store = new BlobEvidenceCheckpointStore(BlobServiceClient.fromConnectionString(connection));
    const identity = {accountId:"test",sourceId:randomUUID(),runFingerprint:randomUUID()};
    await store.getStage(identity,0,"review"); // Initialize outside the short test deadline.
    let release!:()=>void;
    let uploaded!:()=>void;
    const delayed = new Promise<void>(resolve=>{release=resolve;});
    const persisted = new Promise<void>(resolve=>{uploaded=resolve;});
    const original = BlockBlobClient.prototype.uploadData;
    const upload = vi.spyOn(BlockBlobClient.prototype,"uploadData").mockImplementationOnce(async function(...args) {
      const response = await original.apply(this,args); // Blob exists before the simulated delayed acknowledgement.
      uploaded();await delayed;return response;
    });
    let write!:Promise<void>;
    try {
      const failed = withReconciliationDeadline(1000, () => {
        write = store.putStage(identity,0,"review",{attempt:"late"},reconciliationCheckpointGuard());
        return write;
      },vi.fn()).catch(error=>error);
      await persisted;
      expect(await failed).toBeInstanceOf(EvidenceReconciliationTimeoutError);
      expect(await store.getStage(identity,0,"review")).toBeNull();
      await withReconciliationDeadline(5000, () => store.putStage(identity,0,"review",{attempt:"retry"},reconciliationCheckpointGuard()),vi.fn());
      release();
      await expect(write).rejects.toBeInstanceOf(EvidenceReconciliationTimeoutError);
      expect(await store.getStage(identity,0,"review")).toEqual({attempt:"retry"});
    } finally {
      release();upload.mockRestore();
      await store.clearSource(identity.accountId,identity.sourceId);
    }
  }, 15_000);

  it("recovers a real blob outbox after a failed queue send and preserves source artifacts", async () => {
    const store = new BlobEvidenceTaskStore(BlobServiceClient.fromConnectionString(connection));
    const transport = new StorageEvidenceTaskTransport(QueueServiceClient.fromConnectionString(connection));
    const send = vi.spyOn(transport, "send").mockRejectedValueOnce(new Error("simulated interrupted handoff"));
    const queue = new EvidenceTaskQueue(store, transport);
    const input = definition();
    const id = evidenceTaskHash(input);
    const sourceId = evidenceTaskHash({document: randomUUID()});
    await store.putArtifact(sourceId, {pageContent: "private source", metadata: {}});
    await store.putArtifact(sourceId, {pageContent: "private source", metadata: {}});
    expect(await store.artifact(sourceId)).toMatchObject({pageContent: "private source"});
    expect(await queue.submit(input)).toBe(id);
    expect((await store.get(id))?.status).toBe("pending");
    await queue.recover();
    expect(send).toHaveBeenCalledWith("review", id);
    expect((await store.get(id))?.dispatchedAt).toBeGreaterThan(0);
  }, 15_000);
});
