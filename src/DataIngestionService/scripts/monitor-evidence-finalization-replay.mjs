import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {createBlobServiceClient} from "../dist/src/storage.js";
import {loadAppSettings} from "../dist/src/settings.js";

// An isolated operational job must inherit the deployment's telemetry override,
// not the historical destination stored in the shared application settings.
assert.ok(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING, "Set the environment's telemetry override explicitly");
await loadAppSettings();
const {telemetryClient} = await import("../dist/src/processors/appInsights.js");
const hash = value => createHash("sha256").update(value).digest("hex");
const storage = createBlobServiceClient();
const replays = storage.getContainerClient(process.env.EVIDENCE_REPLAY_CONTAINER || "file-operations-evidence-replays");
const work = storage.getContainerClient(process.env.EVIDENCE_WORK_CONTAINER || "file-operations-evidence-work");
const budgets = storage
  .getContainerClient(process.env.EVIDENCE_BUDGET_CONTAINER || "file-operations-evidence-budgets");
const prefix = process.env.EVIDENCE_REPLAY_PREFIX;
assert.match(prefix, /^[a-z0-9-]+\/$/);
const bytes = await replays.getBlobClient(prefix + "manifest.json").downloadToBuffer();
assert.equal(hash(bytes), process.env.EVIDENCE_REPLAY_MANIFEST_SHA256);
const manifest = JSON.parse(bytes.toString());
const totalBatches = Number(process.env.EVIDENCE_REPLAY_BATCH_COUNT);
assert.ok(Number.isSafeInteger(totalBatches) && totalBatches > 0);
const read = async (container, name) => {
  try {
    // One GET observes one version of a ledger that changes during model calls.
    // downloadToBuffer first fetches its size and can truncate a newer version.
    const response = await container.getBlobClient(name).download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  catch (error) {if (error.statusCode === 404) return null; throw error;}
};
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
try {
  while (!controller.signal.aborted) {
    const [record, completed, reviewBudget, indexBudget] = await Promise.all([
      read(work, "jobs/" + hash(manifest.jobId) + ".json"), read(replays, prefix + "completed.json"),
      ...[manifest.reviewBudgetScope, manifest.indexBudgetScope]
        .map(scope => read(budgets, hash(JSON.stringify(scope)) + ".json")),
    ]);
    let completedBatches = 0, lastProgressAt = 0;
    for await (const blob of replays.listBlobsFlat({prefix:prefix + "reviews/"})) {
      completedBatches++;
      lastProgressAt = Math.max(lastProgressAt, blob.properties.lastModified?.getTime() ?? 0);
    }
    assert.ok(completedBatches <= totalBatches, "Replay progress exceeds its frozen plan");
    const entries = [reviewBudget, indexBudget].flatMap(ledger => Object.values(ledger?.entries ?? {}));
    const chargedUsd = entries.reduce((sum, entry) => sum + (entry.chargedMicros ?? 0), 0) / 1_000_000;
    const reservedUsd = entries.reduce((sum, entry) => sum + (entry.chargedMicros === undefined ? entry.reservedMicros : 0), 0) / 1_000_000;
    const state = record?.status === "completed" && completed ? "Completed"
      : record?.status === "extracted" ? "Indexing" : "Reviewing";
    const properties = {accountId:manifest.accountId, sourceId:manifest.sourceId, jobId:manifest.jobId,
      state, observationSource:"durable-replay-records", lastProgressAt:lastProgressAt ? new Date(lastProgressAt).toISOString() : ""};
    const measurements = {completedBatches, totalBatches, progressPercent:100 * completedBatches / totalBatches,
      chargedUsd, reservedUsd, limitUsd:manifest.limitUsd};
    telemetryClient.trackEvent({name:"EvidenceFinalizationReplayProgress", properties, measurements});
    await telemetryClient.flush();
    console.log(JSON.stringify({event:"EvidenceFinalizationReplayProgress", ...properties, ...measurements}));
    if (state === "Completed") break;
    await delay(60_000, undefined, {signal:controller.signal});
  }
} catch (error) {
  if (!controller.signal.aborted) throw error;
} finally {
  await telemetryClient.shutdown();
}
process.exit(0);
