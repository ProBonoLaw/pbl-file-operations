import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PartitionContext, ReceivedEventData, SubscriptionEventHandlers } from "@azure/event-hubs";
import type { EvidenceJobStore, EvidenceWorkRecord } from "../src/processors/evidence/evidenceWorkStore.js";
import { startEvidenceWorker } from "../src/processors/evidence/evidenceWorker.js";
import { currentRequestContext } from "../src/requestContext.js";

const mocks = vi.hoisted(() => ({
  store: undefined as EvidenceJobStore | undefined,
  subscribe: vi.fn(), sendBatch: vi.fn(), storeFailure: vi.fn(), delay: vi.fn(), trackEvent: vi.fn(),
}));
vi.mock("../src/processors/appInsights.js", () => ({ telemetryClient: {
  trackEvent: mocks.trackEvent,
} }));
vi.mock("@azure/event-hubs", () => ({
  earliestEventPosition: {},
  EventHubConsumerClient: class { subscribe = mocks.subscribe; },
  EventHubProducerClient: class { sendBatch = mocks.sendBatch; },
}));
vi.mock("@azure/storage-blob", () => ({ BlobServiceClient: class {
  getContainerClient() { return {
    createIfNotExists: async () => {},
    getBlockBlobClient: () => ({ uploadData: mocks.storeFailure }),
  }; }
} }));
vi.mock("@azure/identity", () => ({ DefaultAzureCredential: class {} }));
vi.mock("@azure/eventhubs-checkpointstore-blob", () => ({ BlobCheckpointStore: class {} }));
vi.mock("../src/processors/evidence/evidenceWorkStore.js", () => ({
  BlobEvidenceWorkStore: class { constructor() { return mocks.store!; } },
}));
vi.mock("node:http", () => ({ createServer: () => ({ listen() {} }) }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));

const request = {
  accountId: "account-1", sourceId: "source-1", containerName: "results", containerPath: "source.md",
  documentName: "source.md", sourceUrl: "https://example.test/source", identifier: "Shared Documents/source.md",
  filepath: "/Shared Documents/source.md", jobId: "original-event-1", progressPartition: "progress", progressRow: "1:1",
  eventOrder: { enqueuedTicks: "100", partitionId: "0", sequenceNumber: "1" },
  cleanupBlobs: [{ containerName: "results", containerPath: "source.md" }],
};

describe("inline evidence worker completion recovery", () => {
  let record: EvidenceWorkRecord;
  let receipt: { indexes: string[] } | null;
  let fetchIndex: ReturnType<typeof vi.fn<typeof fetch>>;
  const event = { body: { contentData: { ...request, eventKind: "EvidenceExtraction" } }, sequenceNumber: 1 } as ReceivedEventData;
  const checkpoint = vi.fn();
  const context = { partitionId: "0", updateCheckpoint: checkpoint } as unknown as PartitionContext;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("STORAGE_ACCOUNT_NAME", "evidencetest");
    vi.stubEnv("EVENTHUB_NAMESPACE", "test.servicebus.windows.net");
    // Exercise the default execution mode, without queue finalizers.
    vi.stubEnv("EVIDENCE_REVIEW_EXECUTION_MODE", "");
    vi.stubEnv("DATA_INGESTION_SERVICE_URL", "https://ingestion.test");
    const originalOnce = process.once;
    vi.spyOn(process, "once").mockImplementation((name, listener) => {
      if (name === "SIGTERM" || name === "SIGINT") return process;
      return originalOnce.call(process, name, listener);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    record = { request, status: "extracted", attempts: 3, extractionMode: "thorough",
      retryBudget: { pagesPerGroup: 20, retriesPerGroup: 3, pageCount: 1, maxAttempts: 4 } };
    receipt = null;
    mocks.store = {
      enqueue: vi.fn(async () => {}),
      get: vi.fn(async () => structuredClone(record)),
      indexResult: vi.fn(async () => receipt),
      saveIndexResult: vi.fn(async (_id, value) => { receipt = value; }),
      documents: vi.fn(async () => []), saveDocuments: vi.fn(async () => {}),
      removeDocuments: vi.fn(async () => {}),
      withLease: vi.fn(async (_id, apply) => {
        if (record.status === "completed") return false;
        await apply(structuredClone(record), async value => { record = structuredClone(value); }, () => {});
        return true;
      }),
    };
    fetchIndex = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      // The API commits its result before the last permitted HTTP response is lost.
      await mocks.store!.saveIndexResult(request.jobId, { indexes: ["index-a"] });
      throw new Error("indexing response lost");
    }).mockImplementation(async () => new Response(JSON.stringify({ indexes: ["index-a"] })));
    vi.stubGlobal("fetch", fetchIndex);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function deliver() {
    await startEvidenceWorker();
    const handlers = mocks.subscribe.mock.calls[0][0] as SubscriptionEventHandlers;
    await handlers.processEvents([event], context);
  }

  it.each(["evidence_budget_exhausted","evidence_budget_configuration"])("preserves input when indexing returns %s",async code=>{
    fetchIndex.mockReset().mockImplementation(async()=>{
      expect(currentRequestContext()).toMatchObject({accountId:request.accountId,sourceId:request.sourceId,jobId:request.jobId});
      return new Response(JSON.stringify({error:"budget stop",code}),{status:402});
    });
    await deliver();
    expect(fetchIndex).toHaveBeenCalledOnce();
    expect(record.attempts).toBe(3);
    expect(mocks.storeFailure).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(mocks.sendBatch).not.toHaveBeenCalled();
    expect(mocks.store!.removeDocuments).not.toHaveBeenCalled();
  });
  it.each(["evidence_budget_busy","evidence_budget_unavailable"])("retries %s without spending the last job attempt",async code=>{
    fetchIndex.mockReset().mockImplementationOnce(async()=>new Response(JSON.stringify({error:"wait",code}),{status:402}))
      .mockImplementation(async()=>new Response(JSON.stringify({indexes:["index-a"]})));
    await deliver();
    expect(record.attempts).toBe(4);
    expect(record.status).toBe("completed");
    expect(mocks.delay).toHaveBeenCalledWith(15_000,undefined,expect.anything());
    expect(mocks.storeFailure).not.toHaveBeenCalled();
    expect(fetchIndex).toHaveBeenCalledTimes(2);
  });

  it.each(["SUCCESS", "SUPERSEDED"])("recovers the last lost response as %s before checkpointing", async status => {
    fetchIndex.mockImplementation(async () => new Response(JSON.stringify({ superseded: status === "SUPERSEDED" })));
    mocks.sendBatch.mockImplementation(async () => { expect(checkpoint).not.toHaveBeenCalled(); });
    await deliver();
    expect(fetchIndex).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchIndex.mock.calls[1][1]?.body))).toMatchObject({ jobId: request.jobId, eventOrder: request.eventOrder });
    expect(mocks.sendBatch).toHaveBeenCalledOnce();
    expect(mocks.sendBatch.mock.calls[0][0][0].body.contentData.status).toBe(status);
    expect(record).toMatchObject({ status: "completed", attempts: 4 });
    expect(mocks.store!.saveDocuments).not.toHaveBeenCalled();
    expect(mocks.storeFailure).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith(event);
    expect(mocks.trackEvent).toHaveBeenCalledWith(expect.objectContaining({ name: "EvidenceExtractionJobCompleted" }));
  });

  it.each(["receipt read", "index response", "cleanup publication", "lease acquisition"])(
    "keeps the event pending when recovery fails during %s, then retries completion", async failure => {
      if (failure === "receipt read") vi.mocked(mocks.store!.indexResult)
        .mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("receipt unavailable"));
      if (failure === "index response") fetchIndex.mockRejectedValueOnce(new Error("recovery response lost"));
      if (failure === "cleanup publication") mocks.sendBatch.mockRejectedValueOnce(new Error("hub unavailable"));
      if (failure === "lease acquisition") vi.mocked(mocks.store!.withLease)
        .mockImplementationOnce(async (_id, apply) => {
          await apply(structuredClone(record), async value => { record = structuredClone(value); }, () => {});
          return true;
        }).mockResolvedValueOnce(false);
      const retry = Promise.withResolvers<void>();
      mocks.delay.mockReturnValueOnce(retry.promise);
      const delivery = deliver();
      await vi.waitFor(() => expect(mocks.delay).toHaveBeenCalledOnce());
      expect(mocks.delay.mock.calls[0][0]).toBe(60_000);
      expect(checkpoint).not.toHaveBeenCalled();
      expect(mocks.storeFailure).not.toHaveBeenCalled();
      expect(mocks.sendBatch.mock.calls.every(([events]) => events[0].body.contentData.status !== "FAILED")).toBe(true);
      expect(record.status).toBe("extracted");
      retry.resolve();
      await delivery;
      expect(record).toMatchObject({ status: "completed", attempts: 4 });
      expect(checkpoint).toHaveBeenCalledExactlyOnceWith(event);
      expect(mocks.storeFailure).not.toHaveBeenCalled();
      expect(mocks.sendBatch.mock.calls.at(-1)?.[0][0].body.contentData.status).toBe("SUCCESS");
    });

  it("still records terminal failure when indexing exhausted its budget without a receipt", async () => {
    fetchIndex.mockReset().mockRejectedValue(new Error("indexing failed"));
    await deliver();
    expect(receipt).toBeNull();
    expect(record.status).toBe("extracted");
    expect(mocks.storeFailure).toHaveBeenCalledOnce();
    expect(mocks.sendBatch.mock.calls[0][0][0].body.contentData.status).toBe("FAILED");
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith(event);
    expect(mocks.delay).not.toHaveBeenCalled();
  });
});
