import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DefaultAzureCredential } from "@azure/identity";
import { SearchClient } from "@azure/search-documents";
import { Document } from "@langchain/core/documents";
import { EvidenceSearchLookup } from "../dist/src/processors/evidence/evidenceSearchLookup.js";
import { compareIndexedEvidenceRetrieval } from "../dist/src/processors/evidence/evidenceSearchReview.js";
import { parseExtractionPackage, literalDocument } from "../dist/src/processors/extractionPackage.js";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Search hits are bound to the complete snapshot and query options by key. */
export function indexedSearchQueryCache(directory) {
  const filename = key => {
    assert.match(key, /^[a-f0-9]{64}$/);
    return resolve(directory, key + ".json");
  };
  return {
    async get(key) {
      try {
        const saved = JSON.parse(await readFile(filename(key), "utf8"));
        assert.equal(saved.version, 1); assert.equal(saved.key, key);
        return saved.ids;
      } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    async put(key, ids) {
      await mkdir(directory, {recursive: true, mode: 0o700});
      const path = filename(key), temporary = path + "." + randomUUID() + ".tmp";
      await writeFile(temporary, JSON.stringify({version: 1, key, ids}), {flag: "wx", mode: 0o600});
      await rename(temporary, path);
    },
  };
}

/** Atomic local checkpoints allow paid pair decisions to survive interruption. */
export function indexedReviewCheckpoints(directory) {
  const filename = (identity, window, stage) => resolve(directory, hash([identity, window, stage]) + ".json");
  return {
    get: async () => null,
    put: async () => { throw new Error("Indexed review saves pair stages only"); },
    clearSource: async () => { throw new Error("Indexed review checkpoints are retained for replay"); },
    clearAccount: async () => { throw new Error("Indexed review checkpoints are retained for replay"); },
    async getStage(identity, window, stage, signal) {
      signal?.throwIfAborted();
      try { return JSON.parse(await readFile(filename(identity, window, stage), "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    async putStage(identity, window, stage, value, guard) {
      guard?.assertActive();
      await mkdir(directory, {recursive: true, mode: 0o700});
      const path = filename(identity, window, stage), temporary = path + "." + randomUUID() + ".tmp";
      await writeFile(temporary, JSON.stringify(value), {flag: "wx", mode: 0o600});
      // The guard acknowledges the upload while its scope is active. Publication
      // runs after that scope closes, including for earlier good stages when a
      // sibling times out; it must not recheck the closed admission guard.
      const publish = () => rename(temporary, path);
      if (guard) guard.deferPublication(path, publish);
      else await publish();
    },
  };
}

async function review(snapshot, source, searchPairs, values, usage) {
  assert.ok(values.settings, "--review requires --settings");
  process.env.APPSETTINGS_FILE = resolve(values.settings);
  const {loadAppSettings} = await import("../dist/src/settings.js");
  await loadAppSettings();
  process.env.EVIDENCE_PROMPT_COMPACTION = "on";
  process.env.EVIDENCE_PROMPT_FORMAT = "json";
  const {default: appInsights} = await import("applicationinsights");
  appInsights.setup("InstrumentationKey=00000000-0000-0000-0000-000000000000");
  appInsights.defaultClient.config.disableAppInsights = true;
  Object.assign(appInsights.defaultClient, {trackException() {}, trackEvent(event) {
    if (event.name !== "llm.call.token_usage") return;
    usage.calls++;
    for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens"])
      usage[key] += event.measurements?.[key] ?? 0;
  }});
  const {EvidenceExtractor} = await import("../dist/src/processors/evidence/evidenceExtractor.js");
  const store = indexedReviewCheckpoints(resolve(values.checkpoints ?? resolve(values.output, "checkpoints")));
  // Pairs come from the indexed snapshot; source context always uses the local lookup,
  // so a hybrid rollout setting cannot demand a partition-readiness checkpoint here.
  const extractor = new EvidenceExtractor(values["account-id"], values["source-id"], undefined, store,
    undefined, undefined, undefined, async () => undefined);
  return extractor.canonicalizeDocuments(snapshot.documents, source, {retrieval: {searchPairs}});
}

/** Preview performs Search reads only. Optional model review writes a local
 * repair proposal and checkpoints; it never mutates the Search index.
 */
export async function runIndexedEvidenceReview(values, dependencies = {}) {
  for (const key of ["endpoint", "index", "account-id", "source-id", "source", "output"])
    assert.ok(values[key], `--${key} is required`);
  const endpoint = new URL(values.endpoint);
  assert.ok(endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    "Use an HTTPS Search endpoint without credentials or query parameters");
  const maxReviewPairs = Number(values["max-review-pairs"] ?? 0);
  if (values.review) assert.ok(Number.isSafeInteger(maxReviewPairs) && maxReviewPairs > 0,
    "--review requires a positive --max-review-pairs bound");
  const text = await readFile(resolve(values.source), "utf8");
  let source;
  if (values.source.endsWith(".json")) {
    const pkg = parseExtractionPackage(JSON.parse(text));
    assert.equal(pkg.accountId, values["account-id"]);
    assert.equal(pkg.sourceId, values["source-id"]);
    source = literalDocument(pkg);
    source.metadata.sourceId = pkg.sourceId;
  } else {
    source = new Document({pageContent: text, metadata: {sourceId: values["source-id"],
      pages: text.split("<!-- PageBreak -->").map((_, index) => index + 1)}});
  }
  const output = resolve(values.output);
  await mkdir(dirname(output), {recursive: true, mode: 0o700});
  await mkdir(output, {mode: 0o700});
  const persist = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + "\n", {mode: 0o600});
  const options = {topK: Number(values["top-k"] ?? 8), maxRecords: Number(values["max-records"] ?? 2000),
    maxQueries: Number(values["max-queries"] ?? 2000), concurrency: Number(values.concurrency ?? 4),
    includeVectors: !values["without-vectors"],
    ...(values["semantic-configuration"] ? {semanticConfiguration: values["semantic-configuration"]} : {})};
  const lookup = dependencies.lookup ?? new EvidenceSearchLookup(new SearchClient(endpoint.origin, values.index, new DefaultAzureCredential()),
    values["account-id"], source, options, indexedSearchQueryCache(resolve(values["query-cache"] ?? resolve(output, "search-cache"))));
  const usage = {calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0};
  const started = performance.now();
  try {
    const snapshot = await lookup.snapshot();
    assert.ok(snapshot.records.length, "No complete evidence matched this source revision");
    await persist("snapshot.json", {sourceHash: lookup.source.contentHash, sourceId: values["source-id"], ...snapshot});
    const searchStarted = performance.now();
    const searchPairs = await lookup.duplicatePairs(snapshot);
    const retrievalElapsedMs = performance.now() - searchStarted;
    await persist("search-pairs.json", searchPairs);
    const comparison = compareIndexedEvidenceRetrieval(snapshot, searchPairs, lookup.source, values["account-id"], options.topK);
    const report = {...comparison, retrievalElapsedMs, searchStats: lookup.stats, indexChanged: false,
      requestedRetrieval: `${options.includeVectors ? "hybrid" : "lexical"}${options.semanticConfiguration ? "+semantic" : ""}`,
      newEmbeddingCalls: 0, mode: values.review ? "review-proposal" : "preview", usage};
    await persist("comparison.json", report);
    if (values.review) {
      assert.ok(comparison.pairs.length <= maxReviewPairs,
        `Review needs ${comparison.pairs.length} pairs, exceeding --max-review-pairs ${maxReviewPairs}; preview saved`);
      const result = await (dependencies.review ?? review)(snapshot, source, searchPairs, values, usage);
      assert.equal((await lookup.snapshot()).fingerprint, snapshot.fingerprint, "Indexed evidence changed during review; proposal is stale");
      await persist("proposal.json", {snapshotFingerprint: snapshot.fingerprint, sourceHash: lookup.source.contentHash,
        originalIds: snapshot.records.map(record => record.id), ...result, usage, indexChanged: false});
      report.review = {appliedMergesInProposal: result.applied.length, remainingRecords: result.documents.length,
        failedBatches: result.failedBatches, failedPairIds: result.failedPairIds};
    }
    report.elapsedMs = performance.now() - started;
    await persist("comparison.json", report);
    return report;
  } catch (error) {
    await persist("failure.json", {error: error instanceof Error ? error.message : String(error), usage,
      searchStats: lookup.stats, indexChanged: false, elapsedMs: performance.now() - started});
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = ["endpoint", "index", "account-id", "source-id", "source", "output", "settings", "checkpoints",
    "top-k", "max-records", "max-queries", "max-review-pairs", "concurrency", "semantic-configuration", "query-cache"];
  const {values} = parseArgs({options: {...Object.fromEntries(names.map(name => [name, {type: "string"}])),
    review: {type: "boolean"}, "without-vectors": {type: "boolean"}}});
  try {
    const report = await runIndexedEvidenceReview(values);
    console.log(JSON.stringify({...report, pairs: undefined}, null, 2));
    if (report.review?.failedPairIds?.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Indexed evidence review failed");
    process.exitCode = 1;
  }
}
