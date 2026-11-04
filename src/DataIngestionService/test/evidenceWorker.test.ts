import { EvidenceReviewPending } from "../src/processors/evidence/evidenceAsync.js";
import { EvidenceBudgetError } from "../src/processors/evidence/evidenceCostBudget.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Document } from "@langchain/core/documents";
import { EvidenceJobAttemptError, processEvidenceJob, recoverEvidenceCompletion, validateEvidenceWork, type EvidenceJobOperations } from "../src/processors/evidence/evidenceWorker.js";
import type { EvidenceJobStore, EvidenceWorkRecord } from "../src/processors/evidence/evidenceWorkStore.js";
import { telemetryClient } from "../src/processors/appInsights.js";

vi.mock("../src/processors/appInsights.js", () => ({ telemetryClient: { trackEvent: vi.fn() } }));

const request = {
  accountId: "account-1", sourceId: "source-1", containerName: "results", containerPath: "source.md",
  documentName: "source.md", sourceUrl: "https://example.test/source", identifier: "Shared Documents/source.md",
  filepath: "/Shared Documents/source.md", jobId: "original-event-1", progressPartition: "progress", progressRow: "1:1",
  eventOrder: { enqueuedTicks: "100", partitionId: "0", sequenceNumber: "1" },
  cleanupBlobs: [{ containerName: "results", containerPath: "source.md" }],
};

function harness() {
  let record: EvidenceWorkRecord | null = null;
  let savedDocuments: Document[] = [];
  const store: EvidenceJobStore = {
    enqueue: vi.fn(async value => { record ??= { request: value, status: "queued", attempts: 0 }; }),
    get: async () => record,
    documents: async () => savedDocuments,
    indexResult: vi.fn(async () => null),
    saveIndexResult: vi.fn(async () => {}),
    saveDocuments: vi.fn(async (_id, documents) => { savedDocuments = documents; }),
    removeDocuments: vi.fn(async () => { savedDocuments = []; }),
    withLease: async (_id, apply) => {
      if (!record || record.status === "completed") return false;
      await apply(structuredClone(record), async value => { record = structuredClone(value); }, () => {});
      return true;
    },
  };
  const operations: EvidenceJobOperations = {
    resolveMode: vi.fn(async()=>"thorough"),
    extract: vi.fn(async () => [new Document({ pageContent: "A dated event.", metadata: { tags: ["event"] } })]),
    index: vi.fn(async () => "SUCCESS"),
    publishCleanup: vi.fn(async () => {}),
  };
  return { store, operations };
}

describe("evidence service stage handoff", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["evidence_budget_busy","evidence_budget_unavailable","evidence_budget_exhausted"] as const)(
    "preserves attempts, source and checkpoints when %s propagates",async code=>{
      const {store,operations}=harness();
      vi.mocked(operations.index).mockRejectedValue(new EvidenceBudgetError(code,"budget stop"));
      for(let i=0;i<6;i++)await expect(processEvidenceJob(request,store,operations)).rejects.toMatchObject({code});
      expect(await store.get(request.jobId)).toMatchObject({attempts:0,status:"extracted"});
      expect(operations.extract).toHaveBeenCalledOnce();
      expect(operations.publishCleanup).not.toHaveBeenCalled();
      expect(store.removeDocuments).not.toHaveBeenCalled();
    });

  it.each(["SUCCESS", "SUPERSEDED"] as const)("recovers an indexed job after exhausted HTTP retries with %s", async status => {
    const {store, operations} = harness();
    await store.enqueue(request);
    await store.withLease(request.jobId, async (record, save) => {
      record.status = "extracted";
      record.attempts = 25;
      record.retryBudget = {pagesPerGroup:20,retriesPerGroup:3,pageCount:156,maxAttempts:25};
      await save(record);
    });
    vi.mocked(store.indexResult).mockResolvedValue({indexes:["index-a"]});
    vi.mocked(operations.index).mockResolvedValue(status);
    expect(await recoverEvidenceCompletion(request, store, operations)).toBe(true);
    expect(operations.extract).not.toHaveBeenCalled();
    expect(operations.index).toHaveBeenCalledOnce();
    expect(operations.publishCleanup).toHaveBeenCalledWith(request, status, false);
    expect(await store.get(request.jobId)).toMatchObject({status:"completed",attempts:25});
  });

  it("does not treat extracted documents as successfully indexed", async () => {
    const {store, operations} = harness();
    await store.enqueue(request);
    await store.withLease(request.jobId, async (record, save) => {record.status="extracted";await save(record);});
    expect(await recoverEvidenceCompletion(request, store, operations)).toBe(false);
    expect(operations.publishCleanup).not.toHaveBeenCalled();
  });

  it("keeps review-pending jobs unindexed without consuming the extraction retry budget", async () => {
    const {store, operations} = harness();
    vi.mocked(operations.extract).mockRejectedValue(new EvidenceReviewPending());
    for (let i = 0; i < 6; i++) await expect(processEvidenceJob(request, store, operations)).rejects.toBeInstanceOf(EvidenceReviewPending);
    expect((await store.get(request.jobId))?.attempts).toBe(0);
    expect(operations.index).not.toHaveBeenCalled();
    expect(operations.publishCleanup).not.toHaveBeenCalled();
    expect(vi.mocked(telemetryClient.trackEvent).mock.calls.some(([event]) => event.name === "EvidenceExtractionFailed")).toBe(false);
    vi.mocked(operations.extract).mockResolvedValue([]);
    await processEvidenceJob(request, store, operations);
    expect(operations.index).toHaveBeenCalledOnce();
  });

  it("tracks extraction independently from indexing, with account, source and job correlation", async () => {
    const { store, operations } = harness();
    vi.mocked(operations.index).mockImplementation(async () => {
      const events = vi.mocked(telemetryClient.trackEvent).mock.calls.map(([event]) => event);
      expect(events.map(event => event.name)).toEqual(["EvidenceExtractionStarted", "EvidenceExtractionModeSelected", "EvidenceExtractionCompleted"]);
      expect(events[2]).toMatchObject({ properties: { accountId: request.accountId, sourceId: request.sourceId,
        jobId: request.jobId, attempt: "1", executionMode: "worker" }, measurements: { documentCount: 1 } });
      expect(events[2].measurements?.durationMs).toBeGreaterThanOrEqual(0);
      return "SUCCESS";
    });
    await processEvidenceJob(request, store, operations);
  });
  it("preserves the extraction package and four Office cleanup artifacts through the worker handoff", () => {
    const value = { ...request, extractionContainerPath: "source.md.extraction.json", cleanupBlobs: [
      { containerName: "input", containerPath: "original.docx" },
      { containerName: "input", containerPath: "rendered.pdf" },
      { containerName: "results", containerPath: "source.md" },
      { containerName: "results", containerPath: "source.md.extraction.json" },
    ] };
    const validated = validateEvidenceWork(value);
    expect(validated.extractionContainerPath).toBe(value.extractionContainerPath);
    expect(validated.cleanupBlobs).toEqual(value.cleanupBlobs);
  });
  it("retains extracted output after an indexing failure and retries without another model call", async () => {
    const { store, operations } = harness();
    vi.mocked(operations.index).mockRejectedValueOnce(new Error("search unavailable"));
    await expect(processEvidenceJob(request, store, operations)).rejects.toThrow("search unavailable");
    expect(operations.publishCleanup).not.toHaveBeenCalled();
    expect(store.removeDocuments).not.toHaveBeenCalled();
    expect((await store.get(request.jobId))?.status).toBe("extracted");
    await processEvidenceJob(request, store, operations);
    expect(operations.extract).toHaveBeenCalledTimes(1);
    expect(vi.mocked(telemetryClient.trackEvent).mock.calls.map(([event]) => event.name))
      .toEqual(["EvidenceExtractionStarted", "EvidenceExtractionModeSelected", "EvidenceExtractionCompleted"]);
    expect(operations.publishCleanup).toHaveBeenCalledWith(request, "SUCCESS", false);
    expect((await store.get(request.jobId))?.status).toBe("completed");
  });

  it("keeps a completed marker so duplicate broker delivery does not extract or index again", async () => {
    const { store, operations } = harness();
    await processEvidenceJob(request, store, operations);
    await processEvidenceJob(request, store, operations);
    expect(operations.extract).toHaveBeenCalledTimes(1);
    expect(operations.index).toHaveBeenCalledTimes(1);
    expect(operations.publishCleanup).toHaveBeenCalledTimes(1);
    expect(telemetryClient.trackEvent).toHaveBeenCalledTimes(3);
  });

  it("retains input and extracted output when cleanup publication fails", async () => {
    const { store, operations } = harness();
    vi.mocked(operations.publishCleanup).mockRejectedValueOnce(new Error("hub unavailable"));
    await expect(processEvidenceJob(request, store, operations)).rejects.toThrow("hub unavailable");
    expect((await store.get(request.jobId))?.status).toBe("extracted");
    expect(store.removeDocuments).not.toHaveBeenCalled();
    await processEvidenceJob(request, store, operations);
    expect(operations.extract).toHaveBeenCalledTimes(1);
  });

  it("does not publish success when extraction fails", async () => {
    const { store, operations } = harness();
    vi.mocked(operations.extract).mockRejectedValueOnce(new Error("invalid structured output"));
    await expect(processEvidenceJob(request, store, operations)).rejects.toThrow("invalid structured output");
    expect(operations.index).not.toHaveBeenCalled();
    expect(operations.publishCleanup).not.toHaveBeenCalled();
    expect(vi.mocked(telemetryClient.trackEvent).mock.calls.map(([event]) => event.name))
      .toEqual(["EvidenceExtractionStarted", "EvidenceExtractionModeSelected", "EvidenceExtractionFailed"]);
    expect(vi.mocked(telemetryClient.trackEvent).mock.calls[2][0].properties)
      .toMatchObject({ accountId: request.accountId, sourceId: request.sourceId, jobId: request.jobId, errorType: "Error" });
    await processEvidenceJob(request, store, operations);
    expect(vi.mocked(telemetryClient.trackEvent).mock.calls[3][0].properties).toMatchObject({ attempt: "2" });
  });

  it("marks replaced source jobs as superseded for cleanup without an outdated success notice", async () => {
    const { store, operations } = harness();
    vi.mocked(operations.index).mockResolvedValue("SUPERSEDED");
    await processEvidenceJob(request, store, operations);
    expect(operations.publishCleanup).toHaveBeenCalledWith(request, "SUPERSEDED", false);
  });

  it("persists the selected mode so billing changes cannot mix fast and thorough attempts",async()=>{
    const {store,operations}=harness();
    vi.mocked(operations.resolveMode).mockResolvedValueOnce("fast").mockResolvedValue("thorough");
    vi.mocked(operations.extract).mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(processEvidenceJob(request,store,operations)).rejects.toThrow("provider unavailable");
    expect((await store.get(request.jobId))?.extractionMode).toBe("fast");
    await processEvidenceJob(request,store,operations);
    expect(operations.resolveMode).toHaveBeenCalledOnce();
    expect(operations.extract).toHaveBeenLastCalledWith({...request,evidenceExtractionMode:"fast"},expect.any(Function));
    expect((await store.get(request.jobId))?.request).toEqual(request);
  });

  it("completes shared-resource cleanup without invoking extraction or reporting extracted evidence",async()=>{
    const {store,operations}=harness();
    vi.mocked(operations.resolveMode).mockResolvedValue("skip");
    await processEvidenceJob(request,store,operations);
    expect(operations.extract).not.toHaveBeenCalled();
    expect(operations.publishCleanup).toHaveBeenCalledWith(request,"SUCCESS",true);
    expect(telemetryClient.trackEvent).toHaveBeenCalledWith(expect.objectContaining({name:"EvidenceExtractionSkipped",
      properties:expect.objectContaining({evidenceExtractionMode:"skip"})}));
    expect(vi.mocked(telemetryClient.trackEvent).mock.calls.map(([event])=>event.name)).not.toContain("EvidenceExtractionCompleted");
    expect((await store.get(request.jobId))?.status).toBe("completed");
  });

  it("correlates a failed billing lookup and leaves the job retryable",async()=>{
    const {store,operations}=harness();
    vi.mocked(operations.resolveMode).mockRejectedValue(new Error("Cosmos unavailable"));
    await expect(processEvidenceJob(request,store,operations)).rejects.toThrow("Cosmos unavailable");
    expect(operations.extract).not.toHaveBeenCalled();
    expect(vi.mocked(telemetryClient.trackEvent).mock.calls.map(([event])=>event.name))
      .toEqual(["EvidenceExtractionStarted","EvidenceExtractionFailed"]);
    expect((await store.get(request.jobId))?.extractionMode).toBeUndefined();
  });

  it("requires original ordering and upload input for extraction", () => {
    expect(validateEvidenceWork(request)).toMatchObject(request);
    expect(() => validateEvidenceWork({ ...request, eventOrder: undefined })).toThrow("ordered uploaded document");
    expect(() => validateEvidenceWork({ ...request, isWebSite: true })).toThrow("ordered uploaded document");
    expect(() => validateEvidenceWork({ ...request, cleanupBlobs: [] })).toThrow("Invalid cleanup");
  });

  it("persists a 100-page budget before extraction and exhausts it across restarted processing calls",async()=>{
    const {store,operations}=harness();
    vi.mocked(operations.extract).mockImplementation(async(_request,onSource)=>{
      await onSource(100);
      expect((await store.get(request.jobId))?.retryBudget).toMatchObject({pageCount:100,maxAttempts:16});
      throw new Error("provider timeout");
    });
    for(let attempt=1;attempt<=16;attempt++){
      const error=await processEvidenceJob(request,store,operations).catch(error=>error);
      expect(error).toBeInstanceOf(EvidenceJobAttemptError);
      expect(error.attempt).toBe(attempt);
      expect(error.exhausted).toBe(attempt===16);
    }
    await expect(processEvidenceJob(request,store,operations,{pagesPerGroup:1,retriesPerGroup:999}))
      .rejects.toThrow("retry budget exhausted");
    expect(operations.extract).toHaveBeenCalledTimes(16);
    expect((await store.get(request.jobId))?.attempts).toBe(16);
    expect(operations.index).not.toHaveBeenCalled();
    expect(telemetryClient.trackEvent).toHaveBeenCalledWith(expect.objectContaining({name:"EvidenceExtractionRetryBudgetResolved",
      properties:expect.objectContaining({pageCount:"100",maxAttempts:"16",attempt:"1"})}));
  });

  it("allows the final permitted attempt to succeed and leaves completed redelivery idempotent",async()=>{
    const {store,operations}=harness();
    let count=0;
    vi.mocked(operations.extract).mockImplementation(async(_request,onSource)=>{
      await onSource(20);
      if(++count<4)throw new Error("retryable failure");
      return [];
    });
    for(let attempt=0;attempt<3;attempt++)await expect(processEvidenceJob(request,store,operations)).rejects.toThrow("retryable");
    await processEvidenceJob(request,store,operations);
    await processEvidenceJob(request,store,operations);
    expect(operations.extract).toHaveBeenCalledTimes(4);
    expect(operations.publishCleanup).toHaveBeenCalledOnce();
    expect((await store.get(request.jobId))?.status).toBe("completed");
  });

  it("uses one page group until source size is known, including billing lookup failures",async()=>{
    const {store,operations}=harness();
    vi.mocked(operations.resolveMode).mockRejectedValue(new Error("Cosmos unavailable"));
    for(let attempt=0;attempt<4;attempt++)await expect(processEvidenceJob(request,store,operations)).rejects.toThrow("Cosmos unavailable");
    await expect(processEvidenceJob(request,store,operations)).rejects.toThrow("retry budget exhausted");
    expect(operations.resolveMode).toHaveBeenCalledTimes(4);
    expect((await store.get(request.jobId))?.retryBudget).toMatchObject({pageCount:null,maxAttempts:4});
  });

  it("gives an old job one persisted chance to resolve its document size",async()=>{
    const {store,operations}=harness();
    await store.enqueue(request);
    await store.withLease(request.jobId,async(record,save)=>{record.attempts=5;await save(record);});
    vi.mocked(operations.extract).mockImplementation(async(_request,onSource)=>{
      await onSource(101);
      throw new Error("provider unavailable");
    });
    await expect(processEvidenceJob(request,store,operations)).rejects.toThrow("provider unavailable");
    expect((await store.get(request.jobId))?.retryBudget).toMatchObject({pageCount:101,maxAttempts:19});
    expect((await store.get(request.jobId))?.attempts).toBe(6);
  });

  it("does not renew the legacy bootstrap allowance after another source-load failure",async()=>{
    const {store,operations}=harness();
    await store.enqueue(request);
    await store.withLease(request.jobId,async(record,save)=>{record.attempts=5;await save(record);});
    vi.mocked(operations.extract).mockRejectedValue(new Error("source unavailable"));
    await expect(processEvidenceJob(request,store,operations)).rejects.toThrow("source unavailable");
    await expect(processEvidenceJob(request,store,operations)).rejects.toThrow("retry budget exhausted");
    expect(operations.extract).toHaveBeenCalledOnce();
  });

  it("can finish result deletion after succeeding on the last permitted attempt",async()=>{
    const {store,operations}=harness();
    vi.mocked(operations.extract).mockRejectedValueOnce(new Error("retryable"));
    await expect(processEvidenceJob(request,store,operations,{pagesPerGroup:20,retriesPerGroup:1})).rejects.toThrow("retryable");
    vi.mocked(store.removeDocuments).mockRejectedValueOnce(new Error("result deletion unavailable"));
    const error=await processEvidenceJob(request,store,operations).catch(error=>error);
    expect(error).not.toBeInstanceOf(EvidenceJobAttemptError);
    expect((await store.get(request.jobId))?.status).toBe("completed");
    await processEvidenceJob(request,store,operations);
    expect(operations.extract).toHaveBeenCalledTimes(2);
    expect(operations.index).toHaveBeenCalledOnce();
    expect(operations.publishCleanup).toHaveBeenCalledOnce();
  });
});
