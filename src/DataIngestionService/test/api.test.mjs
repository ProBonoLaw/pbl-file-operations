import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "vitest";
import { createDataIngestionApiServer } from "../src/api.ts";
import { withRequestContext, currentRequestContext } from "../src/requestContext.ts";
import { EvidenceBudgetError } from "../src/processors/evidence/evidenceCostBudget.ts";
import { formatStructuredLog } from "../src/structuredLogger.ts";

function createHarness(options = {}) {
  const calls = [];
  const telemetry = { traces: [], events: [], exceptions: [] };
  const dependencies = {
    telemetryClient: {
      trackTrace: (value) => telemetry.traces.push(value),
      trackEvent: (value) => telemetry.events.push(value),
      trackException: (value) => telemetry.exceptions.push(value),
    },
    createDuplicateDocumentProcessor: (accountId) => {
      calls.push(["createDuplicateDocumentProcessor", accountId]);
      return {
        open: async () => {
          calls.push(["open"]);
          if (options.openError) throw options.openError;
        },
        delete: async () => {
          calls.push(["delete"]);
          if (options.deleteError) throw options.deleteError;
        },
        removeEntries: async (sourceId) => {
          calls.push(["removeEntries", sourceId]);
          if (options.removeError) throw options.removeError;
          return options.removed ?? true;
        },
      };
    },
    createDocumentIngressProcessor: (request) => {
      calls.push(["createDocumentIngressProcessor", request]);
      return {
        processDocument: async () => {
          calls.push(["processDocument"]);
          if (options.processError) throw options.processError;
          return options.indexes ?? ["index-a", "index-b"];
        },
      };
    },
  };
  return { calls, telemetry, dependencies };
}

async function withApiServer(dependencies, action) {
  const server = createDataIngestionApiServer(dependencies);
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = () => {};
  console.error = () => {};
  try {
    await action(`http://127.0.0.1:${address.port}`, server);
  } finally {
    console.info = originalInfo;
    console.error = originalError;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("shutdown drain waits for processing after its HTTP caller disconnects", async () => {
  const harness = createHarness();
  const started = deferred();
  const finished = deferred();
  harness.dependencies.createDocumentIngressProcessor = () => ({
    processDocument: async () => { started.resolve(); await finished.promise; return ["index-a"]; },
  });
  await withApiServer(harness.dependencies, async (baseUrl, server) => {
    const controller = new AbortController();
    const response = fetch(`${baseUrl}/internal/data-ingestion/ingest`, {
      method:"POST", headers:{"content-type":"application/json"}, signal:controller.signal,
      body:JSON.stringify({accountId:"account-1",sourceId:"source-1",containerName:"results",
        containerPath:"source.md",documentName:"source.md",sourceUrl:"https://example.test/source"}),
    });
    await started.promise;
    controller.abort();
    await assert.rejects(response);
    let drained = false;
    const waiting = server.waitForRequests().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    finished.resolve();
    await waiting;
    assert.equal(harness.telemetry.events.at(-1).name, "DataIngestionApiRequestCompleted");
  });
});

test("a stopped job cannot remove or index source records", async () => {
  const harness = createHarness();
  harness.dependencies.evidenceTaskStore = {isJobStopped: async () => true};
  await withApiServer(harness.dependencies, async baseUrl => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/ingest`, {
      method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({accountId:"account-1",sourceId:"source-1",jobId:"job-1",
        containerName:"results",containerPath:"source.md",documentName:"source.md",
        sourceUrl:"https://example.test/source"}),
    });
    assert.equal(response.status,409);
    assert.deepEqual(await response.json(),{error:"ingestion_job_stopped"});
  });
  assert.deepEqual(harness.calls,[]);
});

test("an in-flight stop prevents ordered ingestion from recording completion", async () => {
  const harness = createHarness();
  let stopped = false;
  const processing = deferred();
  const continueProcessing = deferred();
  const orderWrites = [];
  harness.dependencies.evidenceTaskStore = {isJobStopped:async () => stopped};
  harness.dependencies.operationOrderStore = {
    get:async () => null,
    put:async (...args) => { orderWrites.push(args); },
  };
  harness.dependencies.createDocumentIngressProcessor = () => ({
    processDocument:async checkOpen => {
      processing.resolve();
      await continueProcessing.promise;
      await checkOpen();
      return ["index-a"];
    },
  });
  await withApiServer(harness.dependencies, async baseUrl => {
    const pending = fetch(`${baseUrl}/internal/data-ingestion/ingest`, {
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({accountId:"account-1",sourceId:"source-1",jobId:"job-1",
        containerName:"results",containerPath:"source.md",documentName:"source.md",
        sourceUrl:"https://example.test/source",
        eventOrder:{enqueuedTicks:"1",partitionId:"0",sequenceNumber:"1"}}),
    });
    await processing.promise;
    stopped = true;
    continueProcessing.resolve();
    const response = await pending;
    assert.equal(response.status,409);
  });
  assert.deepEqual(orderWrites,[]);
});

test("health endpoint responds without invoking processors or telemetry", async () => {
  const harness = createHarness();
  await withApiServer(harness.dependencies, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });

    const missing = await fetch(`${baseUrl}/not-an-endpoint`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Not found" });
  });
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.telemetry, { traces: [], events: [], exceptions: [] });
});

test("ingest endpoint validates, invokes processors, and traces account and source IDs", async () => {
  const harness = createHarness();
  const body = {
    accountId: "account-123",
    sourceId: "source-456",
    containerName: "uploads",
    containerPath: "docs/report.pdf",
    documentName: "report.pdf",
    sourceUrl: "https://example.test/report.pdf",
    extractionContainerPath: "docs/report.extraction.json",
    evidenceExtractionMode: "thorough",
    isCurrentOrder: true,
    isWebSite: false,
  };

  await withApiServer(harness.dependencies, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { indexes: ["index-a", "index-b"] });
  });

  assert.deepEqual(harness.calls, [
    ["createDuplicateDocumentProcessor", "account-123"],
    ["open"],
    ["removeEntries", "source-456"],
    ["createDocumentIngressProcessor", body],
    ["processDocument"],
  ]);
  assert.deepEqual(harness.telemetry.traces.map(({ properties }) => properties), [
    { operation: "ingest", accountId: "account-123", sourceId: "source-456" },
    { operation: "ingest", accountId: "account-123", sourceId: "source-456" },
  ]);
  assert.equal(harness.telemetry.events.length, 1);
  assert.equal(
    harness.telemetry.events[0].name,
    "DataIngestionApiRequestCompleted",
  );
  assert.deepEqual(harness.telemetry.events[0].properties, {
    operation: "ingest",
    accountId: "account-123",
    sourceId: "source-456",
  });
  assert.equal(typeof harness.telemetry.events[0].measurements.durationMs, "number");
  assert.deepEqual(harness.telemetry.exceptions, []);
});

test.each(["quick", "FAST", true, ["fast"], {}])("rejects malformed extraction mode %j before changing indexed data", async evidenceExtractionMode => {
  const harness = createHarness();
  await withApiServer(harness.dependencies, async baseUrl => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/ingest`, {
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
        accountId:"account",sourceId:"source",containerName:"results",containerPath:"source.md",
        documentName:"source.md",sourceUrl:"https://example.test/source",evidenceExtractionMode,
      }),
    });
    assert.equal(response.status,400);
  });
  assert.deepEqual(harness.calls,[]);
});

test.each([true, false, null])("ingest endpoint rejects unsupported shardData=%s before removing old chunks", async (shardData) => {
  const harness = createHarness();
  await withApiServer(harness.dependencies, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "account-123",
        sourceId: "source-456",
        containerName: "uploads",
        containerPath: "docs/report.md",
        documentName: "report.md",
        sourceUrl: "https://example.test/report.md",
        shardData,
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "shardData is not supported" });
  });

  assert.deepEqual(harness.calls, []);
  assert.equal(harness.telemetry.exceptions[0].exception.message, "shardData is not supported");
  assert.deepEqual(harness.telemetry.exceptions[0].properties, {
    operation: "ingest",
    accountId: "account-123",
    sourceId: "source-456",
  });
});

test("remove endpoint accepts numeric source IDs and returns processor result", async () => {
  const harness = createHarness({ removed: false });
  await withApiServer(harness.dependencies, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/remove`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "account-789", sourceId: 42 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { removedFromGeneralIndex: false });
  });

  assert.deepEqual(harness.calls, [
    ["createDuplicateDocumentProcessor", "account-789"],
    ["open"],
    ["removeEntries", "42"],
  ]);
  assert.equal(harness.telemetry.events[0].properties.operation, "remove");
  assert.equal(harness.telemetry.events[0].properties.accountId, "account-789");
  assert.equal(harness.telemetry.events[0].properties.sourceId, "42");
});

test("remove endpoint purges the account index for the reserved source ID", async () => {
  const harness = createHarness();
  await withApiServer(harness.dependencies, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/remove`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "account-purge", sourceId: "PURGE_ACCOUNT" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { removedFromGeneralIndex: true });
  });

  assert.deepEqual(harness.calls, [
    ["createDuplicateDocumentProcessor", "account-purge"],
    ["open"],
    ["delete"],
  ]);
});

test("source removal clears its evidence checkpoints after Search removal", async () => {
  const harness = createHarness();
  harness.dependencies.evidenceCheckpointStore = {
    clearSource: async (accountId, sourceId) => harness.calls.push(["clearSource", accountId, sourceId]),
  };
  await withApiServer(harness.dependencies, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/remove`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "account-1", sourceId: "source-1" }),
    });
    assert.equal(response.status, 200);
  });
  assert.deepEqual(harness.calls, [
    ["createDuplicateDocumentProcessor", "account-1"], ["open"],
    ["removeEntries", "source-1"], ["clearSource", "account-1", "source-1"],
  ]);
});

test.each(["DELETE", "POST"])("%s account purge clears all evidence checkpoints after Search deletion", async (method) => {
  const harness = createHarness();
  harness.dependencies.evidenceCheckpointStore = {
    clearAccount: async (accountId) => harness.calls.push(["clearAccount", accountId]),
  };
  const body = { accountId: "account-1", sourceId: "PURGE_ACCOUNT",
    containerName: "uploads", containerPath: "purge", documentName: "purge",
    sourceUrl: "https://example.test/purge" };
  await withApiServer(harness.dependencies, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/${method === "POST" ? "ingest" : "remove"}`, {
      method,
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
  });
  const purgeIndex = harness.calls.findIndex(call => call[0] === "delete");
  const cleanupIndex = harness.calls.findIndex(call => call[0] === "clearAccount");
  assert.ok(purgeIndex >= 0 && cleanupIndex > purgeIndex);
  assert.deepEqual(harness.calls[cleanupIndex], ["clearAccount", "account-1"]);
});

test.each([
  ["source-1", "removed source-1"],
  ["PURGE_ACCOUNT", "purged index"],
])("removal of %s waits until ingestion has finished uploading", async (removalSourceId, finalStep) => {
  const uploadStarted = deferred();
  const allowUpload = deferred();
  const removeRequestStarted = deferred();
  const steps = [];
  const telemetryExceptions = [];
  const dependencies = {
    telemetryClient: {
      trackTrace: ({ message, properties }) => {
        if (message === "Data Ingestion API request started" && properties.operation === "remove") {
          removeRequestStarted.resolve();
        }
      },
      trackEvent: () => {},
      trackException: (value) => telemetryExceptions.push(value),
    },
    createDuplicateDocumentProcessor: () => ({
      open: async () => { steps.push("opened index"); },
      delete: async () => { steps.push("purged index"); },
      removeEntries: async (sourceId) => {
        steps.push(`removed ${sourceId}`);
        return true;
      },
    }),
    createDocumentIngressProcessor: () => ({
      processDocument: async () => {
        steps.push("upload started");
        uploadStarted.resolve();
        await allowUpload.promise;
        steps.push("upload finished");
        return ["general-index"];
      },
    }),
  };

  await withApiServer(dependencies, async (baseUrl) => {
    const ingestionResponse = fetch(`${baseUrl}/internal/data-ingestion/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "account-1",
        sourceId: "source-1",
        containerName: "uploads",
        containerPath: "document.md",
        documentName: "document.md",
        sourceUrl: "https://example.test/document.md",
      }),
    });
    await uploadStarted.promise;

    let removalAcknowledged = false;
    const removalResponse = fetch(`${baseUrl}/internal/data-ingestion/remove`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "account-1", sourceId: removalSourceId }),
    }).then((response) => {
      removalAcknowledged = true;
      return response;
    });

    try {
      await removeRequestStarted.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(steps, ["opened index", "removed source-1", "upload started"]);
      assert.equal(removalAcknowledged, false);
    } finally {
      allowUpload.resolve();
    }

    const [ingestion, removal] = await Promise.all([ingestionResponse, removalResponse]);
    assert.equal(ingestion.status, 200);
    assert.equal(removal.status, 200);
    assert.deepEqual(await removal.json(), { removedFromGeneralIndex: true });
  });

  assert.deepEqual(steps, [
    "opened index",
    "removed source-1",
    "upload started",
    "upload finished",
    "opened index",
    finalStep,
  ]);
  assert.deepEqual(telemetryExceptions, []);
});

test("invalid fields return 400 and retain supplied identity in exception telemetry", async () => {
  const harness = createHarness();
  await withApiServer(harness.dependencies, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "account-invalid",
        sourceId: "source-invalid",
        containerName: "uploads",
        containerPath: "docs/file.txt",
        documentName: "file.txt",
        sourceUrl: "https://example.test/file.txt",
        isWebSite: "yes",
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "isWebSite must be a boolean" });
  });

  assert.equal(harness.telemetry.exceptions.length, 1);
  assert.deepEqual(harness.telemetry.exceptions[0].properties, {
    operation: "ingest",
    accountId: "account-invalid",
    sourceId: "source-invalid",
  });
  assert.equal(harness.telemetry.exceptions[0].exception.message, "isWebSite must be a boolean");
  assert.deepEqual(harness.calls, []);
});

test("processor failures return 500 and include request identity in exception telemetry", async () => {
  const harness = createHarness({ openError: new Error("storage unavailable") });
  await withApiServer(harness.dependencies, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/remove`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "account-error", sourceId: "source-error" }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "storage unavailable" });
  });

  assert.equal(harness.telemetry.exceptions.length, 1);
  assert.deepEqual(harness.telemetry.exceptions[0].properties, {
    operation: "remove",
    accountId: "account-error",
    sourceId: "source-error",
  });
  assert.deepEqual(harness.telemetry.events, []);
});

test.each([
  ["PURGE_ACCOUNT", "deleteError", "index deletion rejected", "delete"],
  ["source-1", "removeError", "document deletion rejected", "removeEntries"],
])("DELETE %s reports Azure Search failures", async (sourceId, errorOption, message, operationCall) => {
  const harness = createHarness({ [errorOption]: new Error(message) });
  await withApiServer(harness.dependencies, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/remove`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "account-error", sourceId }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: message });
  });

  assert.ok(harness.calls.some(([name]) => name === operationCall));
  assert.equal(harness.telemetry.exceptions[0].exception.message, message);
  assert.deepEqual(harness.telemetry.exceptions[0].properties, {
    operation: "remove",
    accountId: "account-error",
    sourceId,
  });
  assert.deepEqual(harness.telemetry.events, []);
});

test("ingestion stops before indexing when old-chunk removal fails", async () => {
  const harness = createHarness({ removeError: new Error("document deletion rejected") });
  await withApiServer(harness.dependencies, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "account-error",
        sourceId: "source-1",
        containerName: "uploads",
        containerPath: "document.md",
        documentName: "document.md",
        sourceUrl: "https://example.test/document.md",
      }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "document deletion rejected" });
  });

  assert.deepEqual(harness.calls, [
    ["createDuplicateDocumentProcessor", "account-error"],
    ["open"],
    ["removeEntries", "source-1"],
  ]);
  assert.equal(harness.telemetry.exceptions[0].exception.message, "document deletion rejected");
});

test("malformed JSON returns 400 before request telemetry starts", async () => {
  const harness = createHarness();
  await withApiServer(harness.dependencies, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/remove`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{invalid json",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Request body must be valid JSON" });
  });
  assert.deepEqual(harness.telemetry, { traces: [], events: [], exceptions: [] });
});

test("structured logs include account and source IDs from async request context", () => {
  const line = withRequestContext(
    { accountId: "account-log", sourceId: "source-log" },
    () => formatStructuredLog("info", ["processing document", { pageCount: 3 }], "fixed-time"),
  );

  assert.deepEqual(JSON.parse(line), {
    timestamp: "fixed-time",
    level: "info",
    accountId: "account-log",
    sourceId: "source-log",
    message: "processing document { pageCount: 3 }",
  });
});

test("ingestion carries the durable session ID and explicit budget override", async () => {
  const harness = createHarness();
  harness.dependencies.createDocumentIngressProcessor = request => ({
    processDocument: async () => {
      assert.equal(request.evidenceBudgetOverride,true);
      assert.deepEqual(currentRequestContext(),{
        accountId:"account-1",sourceId:"391",jobId:"job-1",evidenceBudgetOverride:true,
      });
      return ["index-a"];
    },
  });
  await withApiServer(harness.dependencies, async baseUrl => {
    const response=await fetch(`${baseUrl}/internal/data-ingestion/ingest`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({accountId:"account-1",sourceId:"391",jobId:"job-1",
        evidenceBudgetOverride:true,containerName:"results",containerPath:"source.md",
        documentName:"source.md",sourceUrl:"https://example.test/source"}),
    });
    assert.equal(response.status,200);
  });
});

test("rejects malformed evidence budget overrides", async () => {
  const harness=createHarness();
  await withApiServer(harness.dependencies,async baseUrl=>{
    const response=await fetch(`${baseUrl}/internal/data-ingestion/ingest`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({accountId:"account-1",sourceId:"391",jobId:"job-1",
        evidenceBudgetOverride:"true",containerName:"results",containerPath:"source.md",
        documentName:"source.md",sourceUrl:"https://example.test/source"}),
    });
    assert.equal(response.status,400);
  });
});

test.each(["ingest", "remove", "purge"])("delayed evidence cannot restore a source after a newer %s", async (operation) => {
  const harness = createHarness();
  const originalOrder = { enqueuedTicks: "100", partitionId: "0", sequenceNumber: "1" };
  const newerOrder = { enqueuedTicks: "200", partitionId: "0", sequenceNumber: "2", operation: operation === "ingest" ? "ingest" : "remove" };
  const workRequest = { accountId: "account-1", sourceId: "source-1", eventOrder: originalOrder, jobId: "job-1" };
  const documents = [];
  harness.dependencies.evidenceWorkStore = { get: async () => ({ request: workRequest }),
    indexResult: async () => ({indexes:["previous-index"]}),
    documents: async () => { documents.push("read"); return []; } };
  harness.dependencies.operationOrderStore = {
    get: async (_account, source) => source === "PURGE_ACCOUNT"
      ? operation === "purge" ? newerOrder : null
      : operation === "purge" ? { ...originalOrder, operation: "ingest" } : newerOrder,
  };
  await withApiServer(harness.dependencies, async baseUrl => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/evidence`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(workRequest),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { indexes: [], superseded: true });
  });
  assert.deepEqual(documents, []);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.telemetry.events.map(event => [event.name, event.properties.outcome]),
    [["EvidenceIndexingCompleted", "SUPERSEDED"]]);
});

test("evidence indexing appends records under the original order without removing source chunks", async () => {
  const harness = createHarness();
  const eventOrder = { enqueuedTicks: "100", partitionId: "0", sequenceNumber: "1" };
  const workRequest = { accountId: "account-1", sourceId: "source-1", eventOrder, jobId: "job-1" };
  const indexed = [];
  harness.dependencies.evidenceWorkStore = {
    get: async () => ({ request: workRequest }), documents: async () => [{ pageContent: "Evidence", metadata: {} }],
    indexResult: async () => null, saveIndexResult: async () => {},
  };
  harness.dependencies.operationOrderStore = { get: async (_account, source) => source === "PURGE_ACCOUNT" ? null : { ...eventOrder, operation: "ingest" } };
  harness.dependencies.createDocumentIngressProcessor = () => ({
    indexEvidenceDocuments: async (documents, jobId) => {
      assert.deepEqual(currentRequestContext(),{accountId:"account-1",sourceId:"source-1",jobId:"job-1"});
      indexed.push([documents, jobId]); return ["index-a"];
    },
  });
  await withApiServer(harness.dependencies, async baseUrl => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/evidence`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(workRequest),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { indexes: ["index-a"] });
  });
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0][1], "job-1");
  assert.deepEqual(harness.calls, []);
  assert.equal(harness.telemetry.events.length, 1);
  assert.equal(harness.telemetry.events[0].name, "EvidenceIndexingCompleted");
  assert.deepEqual(harness.telemetry.events[0].properties, {
    operation: "indexEvidence", accountId: "account-1", sourceId: "source-1", jobId: "job-1", outcome: "SUCCESS",
  });
  assert.ok(harness.telemetry.traces.every(trace => trace.message.startsWith("Evidence indexing request") &&
    trace.properties.jobId === "job-1"));
});

for (const code of ["evidence_budget_busy","evidence_budget_unavailable","evidence_budget_exhausted"]) {
  test(`indexing preserves budget code ${code} for the finalizer`,async()=>{
    const harness=createHarness();
    const eventOrder={enqueuedTicks:"100",partitionId:"0",sequenceNumber:"1"};
    const workRequest={accountId:"account-1",sourceId:"source-1",eventOrder,jobId:"job-1"};
    let receipts=0;
    harness.dependencies.evidenceWorkStore={get:async()=>({request:workRequest}),documents:async()=>[],
      indexResult:async()=>null,saveIndexResult:async()=>{receipts++;}};
    harness.dependencies.operationOrderStore={get:async(_account,source)=>source==="PURGE_ACCOUNT"?null:{...eventOrder,operation:"ingest"}};
    harness.dependencies.createDocumentIngressProcessor=()=>({indexEvidenceDocuments:async()=>{
      throw new Error("SDK wrapper",{cause:new EvidenceBudgetError(code,"spending stop")});
    }});
    await withApiServer(harness.dependencies,async baseUrl=>{
      const response=await fetch(`${baseUrl}/internal/data-ingestion/evidence`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(workRequest)});
      assert.equal(response.status,402);assert.equal((await response.json()).code,code);
    });
    assert.equal(receipts,0);
    assert.equal(currentRequestContext(),undefined);
  });
}

test("lost indexing responses and API restarts reuse the persisted result", async () => {
  const harness = createHarness();
  const eventOrder = {enqueuedTicks:"100",partitionId:"0",sequenceNumber:"1"};
  const workRequest = {accountId:"account-1",sourceId:"source-1",eventOrder,jobId:"job-1"};
  const started = deferred();
  const release = deferred();
  let receipt = null;
  let indexCalls = 0;
  let documentReads = 0;
  harness.dependencies.evidenceWorkStore = {
    get: async () => ({request:workRequest}),
    documents: async () => {documentReads++;return [];},
    indexResult: async () => receipt,
    saveIndexResult: async (_id, result) => {receipt=structuredClone(result);},
  };
  harness.dependencies.operationOrderStore = {get:async (_account, source) => source === "PURGE_ACCOUNT" ? null : {...eventOrder,operation:"ingest"}};
  harness.dependencies.createDocumentIngressProcessor = () => ({indexEvidenceDocuments: async () => {
    indexCalls++;started.resolve();await release.promise;return ["index-a"];
  }});
  const options = {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(workRequest)};
  await withApiServer(harness.dependencies, async baseUrl => {
    const controller = new AbortController();
    const abandoned = fetch(`${baseUrl}/internal/data-ingestion/evidence`, {...options,signal:controller.signal}).catch(() => undefined);
    await started.promise;
    controller.abort();
    await abandoned;
    const retry = fetch(`${baseUrl}/internal/data-ingestion/evidence`, options);
    release.resolve();
    assert.deepEqual(await (await retry).json(), {indexes:["index-a"]});
  });
  // A new API process has no in-memory knowledge of the earlier request.
  await withApiServer(harness.dependencies, async baseUrl => {
    assert.deepEqual(await (await fetch(`${baseUrl}/internal/data-ingestion/evidence`, options)).json(), {indexes:["index-a"]});
  });
  assert.equal(indexCalls, 1);
  assert.equal(documentReads, 1);
});

test("failed indexing does not save a success receipt", async () => {
  const harness = createHarness();
  const eventOrder = {enqueuedTicks:"100",partitionId:"0",sequenceNumber:"1"};
  const workRequest = {accountId:"account-1",sourceId:"source-1",eventOrder,jobId:"job-1"};
  let saves = 0;
  harness.dependencies.evidenceWorkStore = {get:async () => ({request:workRequest}),documents:async () => [],
    indexResult:async () => null,saveIndexResult:async () => {saves++;}};
  harness.dependencies.operationOrderStore = {get:async (_account, source) => source === "PURGE_ACCOUNT" ? null : {...eventOrder,operation:"ingest"}};
  harness.dependencies.createDocumentIngressProcessor = () => ({indexEvidenceDocuments:async () => {throw new Error("Search upload failed");}});
  await withApiServer(harness.dependencies, async baseUrl => {
    const response = await fetch(`${baseUrl}/internal/data-ingestion/evidence`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(workRequest)});
    assert.equal(response.status,500);
  });
  assert.equal(saves,0);
});
