import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {createBlobServiceClient} from "../dist/src/storage.js";
import {digest, jsonDigest, validateReplayInput, ReplayCheckpoints, replayReviewDispatcher,
  createReplayExtractor, resumeReplayIndexing, validateReplayBudget, attachReplayLocations} from "./evidence-finalization-replay-core.mjs";
import {loadAppSettings} from "../dist/src/settings.js";

assert.ok(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING, "Set the environment's telemetry override explicitly");
await loadAppSettings();
const required = name => {assert.ok(process.env[name], `${name} is required`); return process.env[name];};
const storage = createBlobServiceClient();
const container = storage.getContainerClient(process.env.EVIDENCE_REPLAY_CONTAINER || "file-operations-evidence-replays");
const prefix = required("EVIDENCE_REPLAY_PREFIX");
assert.match(prefix, /^[a-z0-9-]+\/$/);
const manifestBytes = await container.getBlobClient(prefix + "manifest.json").downloadToBuffer();
assert.equal(digest(manifestBytes), required("EVIDENCE_REPLAY_MANIFEST_SHA256"), "Replay manifest changed");
const manifest = JSON.parse(manifestBytes.toString());
const {request} = manifest;
assert.equal(request.evidenceBudgetOverride, false, "Replay cannot bypass its spending limit");
assert.equal(request.jobId, manifest.jobId);
assert.equal(request.accountId, manifest.accountId); assert.equal(request.sourceId, manifest.sourceId);
const {source, documents} = validateReplayInput(await container.getBlobClient(prefix + "input.json").downloadToBuffer(), manifest);
const log = (phase, properties = {}) => console.log(JSON.stringify({event:"EvidenceFinalizationReplay", phase,
  accountId:manifest.accountId, sourceId:manifest.sourceId, jobId:manifest.jobId, ...properties}));
const durable = {
  async read(name) {
    try {return JSON.parse((await container.getBlobClient(prefix + name).downloadToBuffer()).toString());}
    catch (error) {if (error.statusCode === 404) return null; throw error;}
  },
  async write(name, value, abortSignal) {
    await container.getBlockBlobClient(prefix + name).uploadData(Buffer.from(JSON.stringify(value)),
      {blobHTTPHeaders:{blobContentType:"application/json"}, abortSignal});
  },
  async pin(name, value) {
    try {await container.getBlockBlobClient(prefix + name).uploadData(Buffer.from(JSON.stringify(value)),
      {conditions:{ifNoneMatch:"*"}, blobHTTPHeaders:{blobContentType:"application/json"}});}
    catch (error) {
      if (![409,412].includes(error.statusCode)) throw error;
      assert.equal(jsonDigest(await this.read(name)), jsonDigest(value), `Saved replay ${name} changed`);
    }
  },
};
const {withRequestContext} = await import("../dist/src/requestContext.js");
const {withEvidenceReviewDispatcher, withEvidenceTaskCancellation, withEvidenceTaskOwnership} = await import("../dist/src/processors/evidence/evidenceAsync.js");
const {selectedEvidenceBudget, evidenceCostBudget, budgetErrorCode, EvidenceBudgetError} = await import("../dist/src/processors/evidence/evidenceCostBudget.js");
const {BlobOperationOrderStore, compareEventOrder} = await import("../dist/src/operationOrderStore.js");
const {BlobEvidenceCheckpointStore} = await import("../dist/src/processors/evidence/evidenceCheckpoint.js");
const {BlobEvidenceWorkStore} = await import("../dist/src/processors/evidence/evidenceWorkStore.js");
const {BlobEvidenceTaskStore} = await import("../dist/src/processors/evidence/evidenceTaskQueue.js");
const {currentImplementationFingerprint} = await import("../dist/src/processors/evidence/evidenceImplementationFingerprint.js");
const {processEvidenceJob, EvidenceJobAttemptError} = await import("../dist/src/processors/evidence/evidenceWorker.js");
const {EvidenceExtractor} = await import("../dist/src/processors/evidence/evidenceExtractor.js");
const {DocumentIngressProcessor} = await import("../dist/src/processors/dataIngestionProcessor.js");
const {parseExtractionPackage, literalDocument} = await import("../dist/src/processors/extractionPackage.js");
const {telemetryClient} = await import("../dist/src/processors/appInsights.js");
const correlation = {accountId:manifest.accountId, sourceId:manifest.sourceId, jobId:manifest.jobId};
const controller = new AbortController();
const stop = () => controller.abort(new Error("Replay worker stopped; durable progress is retained"));
process.once("SIGTERM", stop); process.once("SIGINT", stop);
const orders = new BlobOperationOrderStore(storage);
const tasks = new BlobEvidenceTaskStore(storage);
const work = new BlobEvidenceWorkStore(storage);
const shared = new BlobEvidenceCheckpointStore(storage);
const assertActive = () => controller.signal.throwIfAborted();
const checkOpen = async () => {
  assertActive();
  const [current, purge, stopped] = await Promise.all([orders.get(manifest.accountId, manifest.sourceId),
    orders.get(manifest.accountId, "PURGE_ACCOUNT"), tasks.isJobStopped(correlation)]);
  assert.ok(!stopped, "Replay has been stopped");
  assert.ok(current?.operation === "ingest" && compareEventOrder(current, request.eventOrder) === 0,
    "Source was replaced or removed; replay is blocked");
  assert.ok(!purge || compareEventOrder(purge, request.eventOrder) < 0, "Account was purged; replay is blocked");
  assertActive();
};
const selected = selectedEvidenceBudget(correlation);
assert.ok(selected, "Replay requires a durable spending limit");
validateReplayBudget(manifest, selected);
const executionSettings = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(EVIDENCE_|AZURE_OPENAI_|TEXT_EMBEDDING_)/.test(key)
  && !/API_KEY|COST_BUDGET_CONFIG|REPLAY_|QUEUE_CONCURRENCY/.test(key)).sort(([a],[b]) => a.localeCompare(b)));
await durable.pin("execution.json", {implementation:await currentImplementationFingerprint(),
  settingsHash:jsonDigest(executionSettings), inputHash:manifest.inputHash, budgetFingerprint:selected.fingerprint});
await checkOpen();
const pkgBytes = await container.getBlobClient(prefix + "extraction-package.json").downloadToBuffer();
assert.equal(digest(pkgBytes), manifest.extractionPackageHash, "Extraction locations changed");
const pkg = parseExtractionPackage(JSON.parse(pkgBytes.toString()));
assert.equal(pkg.accountId, manifest.accountId); assert.equal(pkg.sourceId, manifest.sourceId);
assert.equal(digest(literalDocument(pkg).pageContent), manifest.sourceContentHash, "Extraction package source changed");
log("validated", {documentCount:documents.length, extractionCalls:0, limitUsd:manifest.limitUsd,
  reviewLimitUsd:manifest.reviewLimitUsd, indexLimitUsd:manifest.indexLimitUsd});
if (process.env.EVIDENCE_REPLAY_VALIDATE_ONLY === "true") {
  log("preflight_completed");
  await telemetryClient.shutdown();
  process.exit(0);
}

// A separate lease fences concurrent/restarted replay pods without altering the
// original stopped task or submitting anything to the general extraction queue.
await durable.pin("ownership.json", {jobId:manifest.jobId});
const lease = container.getBlobClient(prefix + "ownership.json").getBlobLeaseClient();
await lease.acquireLease(60);
let renewing, checking;
const leaseTimer = setInterval(() => {
  renewing ??= lease.renewLease().catch(error => controller.abort(error)).finally(() => {renewing = undefined;});
}, 20_000);
const stopTimer = setInterval(() => {
  checking ??= checkOpen().catch(error => controller.abort(error)).finally(() => {checking = undefined;});
}, 3_000);
try {
  await withRequestContext(correlation, () => withEvidenceTaskOwnership(assertActive, () =>
    withEvidenceTaskCancellation({signal:controller.signal, assertOpen:checkOpen}, async () => {
      let embeddingFingerprint;
      const checkpoints = new ReplayCheckpoints(durable, correlation, assertActive, async (identity, index, stage) => {
        // Existing vectors and partition readiness are reusable; extraction
        // windows from another implementation are never read as a fallback.
        return identity.runFingerprint === embeddingFingerprint || identity.runFingerprint.startsWith("source-partitions-v1-")
          ? shared.getStage(identity, index, stage) : null;
      });
      const ingress = new DocumentIngressProcessor(request.containerName, request.containerPath,
        request.documentName, request.sourceUrl, request.accountId, request.sourceId,
        request.isCurrentOrder ?? false, false, checkpoints, true, request.extractionContainerPath, "thorough");
      // Use the deployed cache/provider identity, including its budgeted fetch.
      const embeddings = ingress.duplicateEvidenceEmbeddings();
      embeddingFingerprint = embeddings.fingerprint;
      const extractor = createReplayExtractor(EvidenceExtractor, request, checkpoints, embeddings);
      let completed = 0, restored = 0;
      const dispatcher = replayReviewDispatcher({storage:durable, source, checkOpen,
        execute:(task, source) => extractor.executeReviewTask(task, source, false),
        track:(phase, batchId) => {
          if (phase === "completed") completed++; else restored++;
          log("review_progress", {completed, restored, batchId});
        }});
      const operations = {
        resolveMode:async () => "thorough",
        extract:async () => {
          await checkOpen();
          const saved = await durable.read("finalized.json");
          if (saved) {
            assert.equal(saved.inputHash, manifest.inputHash);
            assert.equal(jsonDigest(saved.documents), saved.documentsHash, "Finalized replay output changed");
            log("finalized_restored", {documentCount:saved.documents.length}); return saved.documents;
          }
          log("reviewing", {documentCount:documents.length});
          const result = await withEvidenceReviewDispatcher(dispatcher,
            () => extractor.canonicalizeDocuments(documents, source.document));
          const finalized = attachReplayLocations(result.documents, pkg);
          await checkOpen();
          await durable.pin("review-report.json", {pairCount:result.pairs.length, mergedCount:result.applied.length,
            failedPairIds:result.failedPairIds, failedBatches:result.failedBatches});
          await durable.pin("finalized.json", {inputHash:manifest.inputHash, documents:finalized,
            documentsHash:jsonDigest(finalized)});
          log("reviewed", {documentCount:finalized.length, pairCount:result.pairs.length, mergedCount:result.applied.length,
            unresolvedPairCount:result.failedPairIds.length});
          return finalized;
        },
        index:async () => {
          await checkOpen(); log("indexing");
          const response = await fetch(new URL("/internal/data-ingestion/evidence", required("DATA_INGESTION_SERVICE_URL")),
            {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({...correlation,eventOrder:request.eventOrder}),
              signal:controller.signal});
          const result = await response.json();
          if (budgetErrorCode(result)) throw new EvidenceBudgetError(result.code, "Replay indexing reached its spending limit");
          assert.ok(response.ok, `Evidence indexing failed: ${response.status} ${result.code ?? result.error ?? ""}`);
          assert.ok(!result.superseded, "Source changed before indexing");
          await durable.pin("indexed.json", result);
          return "SUCCESS";
        },
        publishCleanup:async () => {
          // Retain recovery inputs and record this replay's completion separately
          // from the original failed ingestion's cleanup/notification event.
          await durable.pin("completed.json", {jobId:manifest.jobId, inputHash:manifest.inputHash});
        },
      };
      const runJob = async jobOperations => {
        for (;;) {
          try {await processEvidenceJob(request, work, jobOperations); break;}
          catch (error) {
            log("attempt_failed", {error:budgetErrorCode(error) ?? error.name,
              causeName:error.cause?.name, causeCode:error.cause?.code});
            if (budgetErrorCode(error) || !(error instanceof EvidenceJobAttemptError) || error.exhausted) throw error;
            await checkOpen(); await delay(15_000, undefined, {signal:controller.signal});
          }
        }
      };
      if (process.env.EVIDENCE_REPLAY_WAIT_FOR_INDEX_RECEIPT === "true") {
        log("awaiting_index_receipt");
        // Poll outside processEvidenceJob: observing an accepted upload must
        // neither spend an attempt nor be blocked by exhausted attempts.
        await resumeReplayIndexing({work, jobId:manifest.jobId, checkOpen, signal:controller.signal,
          complete:async indexed => {
            await durable.pin("indexed.json", indexed);
            await runJob({...operations, index:async () => {await checkOpen(); return "SUCCESS";}});
          }});
      } else await runJob(operations);
      log("completed", {remainingBudgetUsd:(await evidenceCostBudget().availableMicros(selected)) / 1_000_000});
    })));
} catch (error) {
  await durable.write("last-error.json", {at:new Date().toISOString(), name:error.name,
    code:budgetErrorCode(error), message:error.message}).catch(() => {});
  throw error;
} finally {
  clearInterval(leaseTimer); clearInterval(stopTimer);
  await Promise.allSettled([renewing, checking].filter(Boolean));
  await lease.releaseLease().catch(() => {});
  await telemetryClient.shutdown();
}
process.exit(0);
