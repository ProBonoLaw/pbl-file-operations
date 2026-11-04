import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename, rm, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Document } from "@langchain/core/documents";
import appInsights from "applicationinsights";
import { loadAppSettings } from "../dist/src/settings.js";
import { extractionSkippedOnReplay, partitionEvidenceDocuments, repeatedExactAssertionGroups } from "./evidence-live-checks.mjs";

const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(serviceDirectory, "../..");
const { values } = parseArgs({ options: {
  settings: { type: "string", default: resolve(repositoryDirectory, ".vscode/azure-test.appsettings.json") },
  output: { type: "string", default: resolve(repositoryDirectory, ".local/evidence-live-result.json") },
  input: { type: "string", default: resolve(serviceDirectory, "test/fixtures/evidence-live.md") },
  checks: { type: "string", default: "general" },
  models: { type: "string", default: "configured" },
  resume: { type: "boolean", default: false },
  candidateMode: { type: "string", default: "none" },
  candidateDirectory: { type: "string" },
  reconciliationModel: { type: "string", default: "configured" },
  reconciliationDeployment: { type: "string" },
  reconciliationTier: { type: "string", default: "configured" },
  batchMode: { type: "string", default: "configured" },
  canonicalizationMode: { type: "string", default: "configured" },
  eventStructure: { type: "string", default: "configured" },
  verbosity: { type: "string", default: "configured" },
  concurrency: { type: "string" },
  requestIntervalMs: { type: "string", default: "0" },
} });
assert.ok(["general", "synthetic", "categories"].includes(values.checks), "--checks must be general, synthetic, or categories");
assert.ok(["configured", "claude"].includes(values.models), "--models must be configured or claude");
assert.ok(["none", "capture", "captureOnly", "replay"].includes(values.candidateMode),
  "--candidateMode must be none, capture, captureOnly, or replay");
assert.ok(["configured", "sol", "luna", "mistral", "deepseek"].includes(values.reconciliationModel),
  "--reconciliationModel must be configured, sol, luna, mistral, or deepseek");
assert.ok(["configured", "default", "priority"].includes(values.reconciliationTier),
  "--reconciliationTier must be configured, default, or priority");
assert.ok(["configured", "fixed", "tokenAware"].includes(values.batchMode),
  "--batchMode must be configured, fixed, or tokenAware");
assert.ok(["configured", "off", "review"].includes(values.canonicalizationMode),
  "--canonicalizationMode must be configured, off, or review");
assert.ok(["configured", "off", "annotate"].includes(values.eventStructure),
  "--eventStructure must be configured, off, or annotate");
assert.ok(["configured", "default", "low", "medium", "high"].includes(values.verbosity),
  "--verbosity must be configured, default, low, medium, or high");
assert.ok(values.reconciliationTier === "configured" || values.models !== "claude",
  "--reconciliationTier applies only to GPT reconciliation");
assert.ok(values.candidateMode === "none" || values.candidateDirectory,
  "--candidateDirectory is required for candidate capture or replay");
assert.ok(!values.resume || ["none", "replay"].includes(values.candidateMode),
  "Window checkpoints can be combined with candidate replay, but not capture");
assert.ok(values.models !== "claude" || values.reconciliationModel === "configured",
  "--models claude uses its configured Claude reconciler");
const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency);
const requestIntervalMs = Number(values.requestIntervalMs);
assert.ok(concurrency === undefined || Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 4,
  "--concurrency must be an integer from 1 to 4");
assert.ok(Number.isSafeInteger(requestIntervalMs) && requestIntervalMs >= 0,
  "--requestIntervalMs must be a nonnegative integer");
assert.ok(!requestIntervalMs || concurrency === 1,
  "--requestIntervalMs requires --concurrency 1");

// Make the selected settings file authoritative for this isolated Test process.
// Do not let a shell's model/key overrides accidentally route it elsewhere.
const settings = JSON.parse(await readFile(resolve(values.settings), "utf8"));
for (const name of Object.keys(process.env)) {
  if (/^(AZURE_OPENAI_|EVIDENCE_)/.test(name)) delete process.env[name];
}
process.env.APPSETTINGS_FILE = resolve(values.settings);
await loadAppSettings();
if (values.models === "claude") {
  process.env.EVIDENCE_PRIMARY_DEPLOYMENT_NAME = "tasks-claude-haiku-5-5";
  process.env.EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME = "research-claude-sonnet-5-5";
  process.env.EVIDENCE_PRIMARY_PROVIDER = "anthropic";
  process.env.EVIDENCE_INDEPENDENT_PROVIDER = "anthropic";
  process.env.EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME = "research-claude-sonnet-5-5";
  process.env.EVIDENCE_RECONCILIATION_PROVIDER = "anthropic";
  for (const role of ["PRIMARY", "INDEPENDENT"]) {
    const endpoint = process.env[`EVIDENCE_${role}_ENDPOINT`] || process.env.AZURE_OPENAI_LLM_ENDPOINT;
    assert.ok(endpoint && new URL(endpoint).protocol === "https:",
      `Claude ${role} requires a configured HTTPS Foundry endpoint`);
  }
} else {
  assert.equal(process.env.EVIDENCE_PRIMARY_DEPLOYMENT_NAME, "tasks-gpt-6.0-luna");
  assert.equal(process.env.EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME, "research-gpt-6.1-sol");
}
if (["sol", "luna"].includes(values.reconciliationModel)) {
  process.env.EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME = values.reconciliationModel === "sol"
    ? "research-gpt-6.1-sol" : "tasks-gpt-6.0-luna";
  process.env.EVIDENCE_RECONCILIATION_PROVIDER = "openai";
  process.env.EVIDENCE_RECONCILIATION_REASONING = values.reconciliationModel === "sol" ? "low" : "xhigh";
}
if (values.reconciliationDeployment) {
  assert.ok(["configured", "sol", "luna"].includes(values.reconciliationModel),
    "--reconciliationDeployment requires configured, sol, or luna reconciliation");
  process.env.EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME = values.reconciliationDeployment.trim();
  assert.ok(process.env.EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME, "--reconciliationDeployment must not be empty");
}
if (["mistral", "deepseek"].includes(values.reconciliationModel)) {
  process.env.EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME = values.reconciliationModel === "mistral"
    ? "Recon-Test-Mistral-Large-3" : "Recon-Test-DeepSeek-V4-Pro";
  process.env.EVIDENCE_RECONCILIATION_PROVIDER = values.reconciliationModel;
  delete process.env.EVIDENCE_RECONCILIATION_REASONING;
  delete process.env.EVIDENCE_RECONCILIATION_SERVICE_TIER;
}
assert.ok(!["mistral", "deepseek"].includes(values.reconciliationModel) || values.reconciliationTier === "configured",
  "Mistral and DeepSeek reconciliation do not support the GPT service tier override");
if (values.reconciliationTier !== "configured") {
  process.env.EVIDENCE_RECONCILIATION_SERVICE_TIER = values.reconciliationTier;
}
if (values.batchMode !== "configured") process.env.EVIDENCE_RECONCILIATION_BATCH_MODE = values.batchMode;
if (values.canonicalizationMode !== "configured") {
  process.env.EVIDENCE_CANONICALIZATION_MODE = values.canonicalizationMode;
}
if (values.eventStructure !== "configured") process.env.EVIDENCE_EVENT_STRUCTURE_MODE = values.eventStructure;
if (values.verbosity === "default") delete process.env.AZURE_OPENAI_VERBOSITY;
else if (values.verbosity !== "configured") process.env.AZURE_OPENAI_VERBOSITY = values.verbosity;
assert.ok(settings.AZURE_OPENAI_LLM_API_KEY, "The Test settings need an LLM API key");

// Collect actual extractor telemetry locally; this run has no indexing or
// application telemetry side effects. Both Azure model clients remain real.
const events = [];
appInsights.setup("InstrumentationKey=00000000-0000-0000-0000-000000000000");
appInsights.defaultClient.config.disableAppInsights = true;
Object.assign(appInsights.defaultClient, {
  trackEvent(event) {
    events.push(event);
    if (event.name === "llm.call.token_usage") {
      console.log(JSON.stringify({ event: event.name, model: event.properties.model,
        stage: event.properties.stage, ...event.measurements }));
    }
    if (/windowCompleted|documentCompleted|candidateRepair|candidateRejected|windowReconciled|stageRestored|stageCheckpointRejected|reviewBatchCompleted|boundaryReviewRequested|eventClassificationReviewed|claimAttributionReviewed|reviewLoopEscalated|structuredReviewRecovered|missingStructuredResponseRetry/.test(event.name)) {
      console.log(JSON.stringify({ event: event.name, ...event.properties }));
    }
  },
  trackException({ exception, properties }) {
    events.push({ name: "exception", properties: { ...properties, message: exception.message } });
  },
});

const { EvidenceExtractor } = await import("../dist/src/processors/evidence/evidenceExtractor.js");
const { EvidenceSource } = await import("../dist/src/processors/evidence/evidenceSource.js");
const { EVIDENCE_CONTENT_VERSION, formatEvidenceContent, formatEvidenceDate } = await import("../dist/src/processors/evidence/evidenceContent.js");
const { EVIDENCE_TAXONOMY_VERSION, summarizeEvidenceTaxonomy } = await import("../dist/src/processors/evidence/evidenceTaxonomy.js");
const { deduplicateEvidenceDocuments } = await import("../dist/src/processors/evidence/evidenceDeduplication.js");
const input = await readFile(resolve(values.input), "utf8");
const pages = input.split("<!-- PageBreak -->");
const inputHash = createHash("sha256").update(input).digest("hex");
const sourceId = "evidence-live-" + inputHash.slice(0, 12);
const source = new Document({ pageContent: input, metadata: {
  sourceId, title: basename(values.input), pages: pages.map((_, index) => index + 1),
} });
const checkpointDirectory = resolve(values.output + ".checkpoints");
const checkpointFile = (identity, windowIndex) => {
  const sourceKey = createHash("sha256").update(identity.accountId).update("\0")
    .update(identity.sourceId).digest("hex");
  return resolve(checkpointDirectory, sourceKey, identity.runFingerprint, `${windowIndex}.json`);
};
const checkpointStore = values.resume ? {
  async getStage(identity, windowIndex, stage) {
    const stageHash = createHash("sha256").update(stage).digest("hex");
    try {
      return JSON.parse(await readFile(checkpointFile(identity, windowIndex) + `.stages/${stageHash}.json`, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) return "[invalid stage checkpoint JSON]";
      throw error;
    }
  },
  async putStage(identity, windowIndex, stage, value) {
    const stageHash = createHash("sha256").update(stage).digest("hex");
    const filename = checkpointFile(identity, windowIndex) + `.stages/${stageHash}.json`;
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, filename);
  },
  async get(identity, windowIndex) {
    try {
      return JSON.parse(await readFile(checkpointFile(identity, windowIndex), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      // The extractor rejects this record and re-extracts its window.
      if (error instanceof SyntaxError) return "[invalid checkpoint JSON]";
      throw error;
    }
  },
  async put(identity, windowIndex, value) {
    const filename = checkpointFile(identity, windowIndex);
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, filename);
  },
} : undefined;
const candidateDirectory = values.candidateDirectory ? resolve(values.candidateDirectory) : undefined;
if (values.resume && values.candidateMode === "replay") {
  const hash = createHash("sha256").update(process.env.EVIDENCE_CHECKPOINT_EPOCH || "");
  const names = (await readdir(candidateDirectory)).filter(name => name.endsWith(".json")).sort();
  for (const name of names) {
    hash.update(name).update("\0").update(await readFile(resolve(candidateDirectory, name))).update("\0");
  }
  // Different candidate sets must not restore a completed window from an earlier replay.
  process.env.EVIDENCE_CHECKPOINT_EPOCH = hash.digest("hex");
}
const candidateFile = (window) => resolve(candidateDirectory, `${window.pageNumber}-${window.startOffset}.json`);
const candidateStore = candidateDirectory ? {
  mode: values.candidateMode,
  async get(window) {
    try { return JSON.parse(await readFile(candidateFile(window), "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  },
  async put(window, snapshot) {
    await mkdir(candidateDirectory, { recursive: true, mode: 0o700 });
    const filename = candidateFile(window);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    await rename(temporary, filename);
  },
} : undefined;
const windowCount = new EvidenceSource(source).windows().length;
const configuredReconciliation = ["DEPLOYMENT_NAME", "PROVIDER", "ENDPOINT", "API_KEY", "REASONING", "SERVICE_TIER", "MAX_OUTPUT_TOKENS", "REQUEST_INTERVAL_MS"]
  .some(name => process.env[`EVIDENCE_RECONCILIATION_${name}`]?.trim());
const configuration = Object.fromEntries(["PRIMARY", "INDEPENDENT", "RECONCILIATION"].map(role => {
  const configuredRole = role === "RECONCILIATION" && !configuredReconciliation ? "INDEPENDENT" : role;
  const deployment = process.env[`EVIDENCE_${configuredRole}_DEPLOYMENT_NAME`];
  const provider = process.env[`EVIDENCE_${configuredRole}_PROVIDER`]
    || (/claude/i.test(deployment) ? "anthropic" : /mistral/i.test(deployment) ? "mistral"
      : /deepseek/i.test(deployment) ? "deepseek" : "openai");
  return [role.toLowerCase(), { deployment, provider,
    reasoningEffort: provider === "openai" ? process.env[`EVIDENCE_${configuredRole}_REASONING`]
      || process.env.AZURE_OPENAI_REASONING || (configuredRole === "PRIMARY" ? "high" : "low") : null }];
}));
configuration.reconciliation.serviceTier = process.env.EVIDENCE_RECONCILIATION_SERVICE_TIER || null;
configuration.reconciliation.batchMode = process.env.EVIDENCE_RECONCILIATION_BATCH_MODE || "fixed";
configuration.reconciliation.maxOutputTokens = ["mistral", "deepseek"].includes(configuration.reconciliation.provider)
  ? Number(process.env.EVIDENCE_RECONCILIATION_MAX_OUTPUT_TOKENS || 8192) : null;
configuration.reconciliation.requestIntervalMs = Number(process.env.EVIDENCE_RECONCILIATION_REQUEST_INTERVAL_MS || 0);
configuration.reconciliation.fallback = process.env.EVIDENCE_RECONCILIATION_FALLBACK || "off";
configuration.canonicalizationMode = process.env.EVIDENCE_CANONICALIZATION_MODE || "off";
configuration.eventStructureMode = process.env.EVIDENCE_EVENT_STRUCTURE_MODE || "off";
configuration.specialistMode = process.env.EVIDENCE_SPECIALIST_MODE || "off";
configuration.verbosity = process.env.AZURE_OPENAI_VERBOSITY || null;
const started = Date.now();
const cpuStarted = process.cpuUsage();
const requestSemaphore = concurrency === undefined ? undefined : await (async () => {
  const { default: Semaphore } = await import("semaphore-async-await");
  const SemaphoreClass = Semaphore.default ?? Semaphore;
  const permits = new SemaphoreClass(concurrency);
  let lastStarted = 0;
  return {
    async acquire() {
      const acquired = await permits.acquire();
      const delay = Math.max(0, lastStarted + requestIntervalMs - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      lastStarted = Date.now();
      return acquired;
    },
    release() { permits.release(); },
  };
})();
const memorySamples = [];
const sampleMemory = () => {
  let rssBytes = process.memoryUsage().rss;
  let highWaterBytes = null;
  if (process.platform === "linux") {
    try {
      const status = readFileSync("/proc/self/status", "utf8");
      const rss = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
      const highWater = status.match(/^VmHWM:\s+(\d+)\s+kB/m);
      if (rss) rssBytes = Number(rss[1]) * 1024;
      if (highWater) highWaterBytes = Number(highWater[1]) * 1024;
    } catch { /* Fall back to the runtime's resident-memory measurement. */ }
  }
  memorySamples.push({ rssBytes, highWaterBytes });
};
sampleMemory();
const memoryTimer = setInterval(sampleMemory, 1000);
memoryTimer.unref();
console.log(JSON.stringify({ event: "liveTestStarted", primary: process.env.EVIDENCE_PRIMARY_DEPLOYMENT_NAME,
  independent: process.env.EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME,
  pageCount: pages.length, windowCount, input: resolve(values.input), checks: values.checks, configuration,
  resume: values.resume, candidateMode: values.candidateMode,
  concurrency: concurrency ?? 4, requestIntervalMs,
  endpoint: new URL(values.models === "claude" ? "/anthropic" : "/openai/v1/",
    process.env.AZURE_OPENAI_LLM_ENDPOINT).toString() }));

const result = { input: resolve(values.input), sourceId, inputHash, pageCount: pages.length, windowCount, configuration,
  resume: values.resume, candidateMode: values.candidateMode,
  concurrency: concurrency ?? 4, requestIntervalMs,
  elapsedSeconds: 0, documents: [], events, checks: {}, statistics: {} };
try {
  result.documents = await new EvidenceExtractor("local-integration-test", sourceId, requestSemaphore, checkpointStore, candidateStore)
    .generateDocuments(source);
  for (const doc of result.documents) {
    assert.ok(doc.metadata.sourceSpans.length > 0);
    assert.equal(doc.metadata.sourceId, sourceId);
    assert.equal(doc.metadata.sourceContentHash, inputHash);
    for (const span of doc.metadata.sourceSpans) {
      assert.equal(pages[span.pageNumber - 1]?.slice(span.sourceOffset, span.sourceOffset + span.sourceQuote.length), span.sourceQuote);
    }
  }
  const {claims, events: eventDocs, facts} = partitionEvidenceDocuments(result.documents);
  const hasEventDate = doc => {
    const resolution = doc.metadata.eventDateResolution;
    const dates = resolution?.status === "dated" && resolution.relation === "bounded"
      ? [resolution.start, resolution.end] : [doc.metadata.whenStarted, doc.metadata.whenEnded];
    return dates.some(date => formatEvidenceDate(date) !== null);
  };
  const sourceRange = (pageNumber, marker) => {
    const page = pages[pageNumber - 1] ?? "";
    const start = page.indexOf(marker);
    if (start < 0) return null;
    const newline = page.indexOf("\n", start);
    return { pageNumber, start, end: newline < 0 ? page.length : newline };
  };
  const overlapsSourceRange = (doc, range) => !!range && doc.metadata.sourceSpans.some(span =>
    span.pageNumber === range.pageNumber && span.sourceOffset < range.end
      && range.start < span.sourceOffset + span.sourceQuote.length);
  const duplicateExactAssertionCount = repeatedExactAssertionGroups(result.documents);
  const paymentRange = sourceRange(2, "On March 10, 2025, Cedar Legal Services");
  const interviewRanges = [sourceRange(3, "On March 12, 2025, W-17 told"), sourceRange(3, "On March 13, 2025, W-22 told")];
  const witnessMappings = [
    ["W-17", "Morgan Hale", sourceRange(1, "Witness code W-17 identifies Morgan Hale.")],
    ["W-22", "Riley Chen", sourceRange(1, "Witness code W-22 identifies Riley Chen.")],
  ];
  const canonicalizationCompleted = events.findLast(event => event.name === "evidenceExtractor.canonicalizationCompleted");
  const dateIsIncluded = (doc, field, label) => {
    const date = formatEvidenceDate(doc.metadata[field]);
    return date === null || doc.pageContent.includes(`${label}: ${date}`);
  };
  const reusedStage = (stage) => values.resume && events.some(event =>
    event.name === "evidenceExtractor.windowRestored"
    || event.name === "evidenceExtractor.stageRestored" && event.properties.stage.startsWith(stage));
  result.checks = {
    allCitationsResolve: true,
    sourceIdentityPreserved: true,
    everyWindowCompleted: events.filter(event => event.name === "evidenceExtractor.windowCompleted").length === windowCount,
    primaryCalled: reusedStage("primary-") || values.candidateMode === "replay" || (values.candidateMode === "captureOnly"
      && events.filter(event => event.name === "evidenceExtractor.candidateSnapshotCaptured").length === 0)
      || events.some(event => event.name === "llm.call.token_usage"
      && event.properties.stage?.startsWith("primary-")
      && event.properties.model === process.env.EVIDENCE_PRIMARY_DEPLOYMENT_NAME),
    independentCalled: reusedStage("independent") || values.candidateMode === "replay" || (values.candidateMode === "captureOnly"
      && events.filter(event => event.name === "evidenceExtractor.candidateSnapshotCaptured").length === 0)
      || events.some(event => event.name === "llm.call.token_usage"
      && event.properties.stage === "independent"
      && event.properties.model === process.env.EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME),
    reconciliationCalled: values.candidateMode === "captureOnly" ? !events.some(event =>
      event.name === "llm.call.token_usage" && event.properties.stage === "reconciliation") : reusedStage("reconciliation:") || events.some(event => event.name === "llm.call.token_usage"
      && event.properties.stage === "reconciliation"
      && event.properties.model === configuration.reconciliation.deployment),
    priorityServed: configuration.reconciliation.serviceTier !== "priority" || events.filter(event =>
      event.name === "llm.call.token_usage" && event.properties.stage === "reconciliation")
      .every(event => ["priority", "fast"].includes(event.properties.serviceTier)),
    defaultVerbosityUsed: values.verbosity !== "default" || configuration.verbosity === null,
    extractionSkippedOnReplay: extractionSkippedOnReplay(values.candidateMode, events),
    canonicalizationReviewComplete: configuration.canonicalizationMode !== "review"
      || (canonicalizationCompleted !== undefined && Number(canonicalizationCompleted.properties.failedBatches) === 0),
    snapshotsCaptured: !["capture", "captureOnly"].includes(values.candidateMode) || events.filter(event =>
      ["evidenceExtractor.candidateSnapshotCaptured", "evidenceExtractor.candidateSnapshotReused"].includes(event.name)).length === windowCount,
    snapshotsReplayed: values.candidateMode !== "replay" || events.filter(event =>
      event.name === "evidenceExtractor.candidateSnapshotReplayed" || event.name === "evidenceExtractor.windowRestored").length === windowCount,
    evidenceContentFormatted: result.documents.every(doc => doc.metadata.evidenceContentVersion === EVIDENCE_CONTENT_VERSION
      && doc.pageContent === formatEvidenceContent(doc.metadata)),
    noRemainingMergeableExactAssertions: deduplicateEvidenceDocuments(result.documents).length === result.documents.length,
    factDatesIncluded: facts.every(doc => dateIsIncluded(doc, "asOf", "As of")),
    claimDatesIncluded: claims.every(doc => dateIsIncluded(doc, "whenStarted", "Date referenced by the claim")
      && dateIsIncluded(doc, "whenEnded", "End date referenced by the claim")),
    eventDatesIncluded: eventDocs.every(doc => {
      const resolution = doc.metadata.eventDateResolution;
      if (resolution?.status === "dated" && resolution.relation === "bounded") {
        return doc.pageContent.includes(`Earliest possible occurrence: ${formatEvidenceDate(resolution.start)}`)
          && doc.pageContent.includes(`Latest possible occurrence: ${formatEvidenceDate(resolution.end)}`)
          && doc.pageContent.includes(`Date uncertainty: ${resolution.qualifier}`);
      }
      return dateIsIncluded(doc, "whenStarted", resolution?.relation === "approximate"
        ? "Approximate event date" : "Event start date")
        && dateIsIncluded(doc, "whenEnded", "Event end date");
    }),
  };
  if (values.checks === "synthetic") Object.assign(result.checks, {
    paymentFound: eventDocs.some(doc => /250/.test(doc.metadata.what) && /Avery Patel/.test(doc.metadata.what + doc.metadata.who.join(" "))),
    attributedAffirmativeClaim: claims.some(doc => /Morgan Hale/.test(doc.metadata.claimant) && /folder/.test(doc.metadata.what)),
    attributedDenial: claims.some(doc => /Riley Chen/.test(doc.metadata.claimant) && /folder/.test(doc.metadata.what) && doc.metadata.claimPolarity === "denies"),
    undatedFact: facts.some(doc => /unsigned envelope/.test(doc.metadata.what) && doc.metadata.asOf.year === null),
    crossPageSupport: result.documents.some(doc => doc.metadata.sourceSpans.some(span => span.pageNumber === 1)
      && doc.metadata.sourceSpans.some(span => span.pageNumber === 3)),
    noRepeatedExactAssertions: duplicateExactAssertionCount === 0,
    onePaymentRecordPerOccurrence: eventDocs.filter(doc => doc.metadata.eventType === "payment"
      && overlapsSourceRange(doc, paymentRange)).length === 1,
    oneCommunicationRecordPerInterview: interviewRanges.every(range => eventDocs.filter(doc =>
      doc.metadata.eventType === "communication" && overlapsSourceRange(doc, range)).length === 1),
    oneRelationshipFactPerWitnessCode: witnessMappings.every(([code, name, range]) => facts.filter(doc =>
      doc.metadata.factType === "relationship" && doc.metadata.what.includes(code)
      && doc.metadata.what.includes(name) && overlapsSourceRange(doc, range)).length === 1),
  });
  if (values.checks === "categories") {
    const rows = [
      ["Anxious-Depressed", "Borderline", "65", "93"],
      ["Internalizing Problems", "Borderline", "63", "90"],
      ["Externalizing Problems", "Clinical", "71", "97"],
    ];
    Object.assign(result.checks, {
      assessmentRowsAreFacts: rows.every(([scale, range, score, percentile]) => facts.some(doc =>
        doc.metadata.factType === "assessmentResult" && doc.metadata.sourceQuote.includes(scale)
        && [scale, range, score, percentile].every(value => doc.metadata.what.includes(value)))),
      assessmentRowsAreNotEvents: eventDocs.every(doc => rows.every(([scale]) => !doc.metadata.sourceQuote.includes(scale))),
      subjectAndReporterSeparated: facts.some(doc => doc.metadata.subject?.includes("Casey Vale")
        && doc.metadata.reportedBy?.includes("Jordan Vale")),
      checklistCompletionIsEvent: eventDocs.some(doc => /completed.*(?:Child Behavior Checklist|CBC)/i.test(doc.metadata.what)),
      reportedSymptomIsClaim: claims.some(doc => /avoids group games/i.test(doc.metadata.what)
        && /Jordan Vale/.test(doc.metadata.claimant)),
    });
  }
  result.statistics = {
    taxonomyVersion: EVIDENCE_TAXONOMY_VERSION,
    classification: summarizeEvidenceTaxonomy(result.documents),
    eventCount: eventDocs.length, factCount: facts.length, claimCount: claims.length,
    repeatedSamePageAssertionGroups: duplicateExactAssertionCount,
    crossPageItems: result.documents.filter(doc => doc.metadata.pages.length > 1).length,
    undatedEvents: eventDocs.filter(doc => !hasEventDate(doc)).length,
    undatedFacts: facts.filter(doc => doc.metadata.asOf.year === null).length,
    datedFacts: facts.filter(doc => formatEvidenceDate(doc.metadata.asOf) !== null).length,
    datedClaims: claims.filter(doc => [doc.metadata.whenStarted, doc.metadata.whenEnded].some(date => formatEvidenceDate(date) !== null)).length,
    datedEvents: eventDocs.filter(hasEventDate).length,
    eventsWithDateBounds: eventDocs.filter(doc => doc.metadata.eventDateResolution?.status === "dated"
      && doc.metadata.eventDateResolution.relation === "bounded").length,
  };
  assert.ok(Object.values(result.checks).every(Boolean), "One or more live extraction checks failed; inspect the result artifact");
  if (values.resume) await rm(checkpointDirectory, { recursive: true, force: true });
} catch (error) {
  result.error = { name: error.name, message: error.message, status: error.status };
  process.exitCode = 1;
} finally {
  clearInterval(memoryTimer);
  sampleMemory();
  const cpu = process.cpuUsage(cpuStarted);
  const wallMs = Date.now() - started;
  result.resources = {
    runtime: process.versions.bun ? "bun" : "node",
    runtimeVersion: process.versions.bun || process.versions.node,
    cpuUserSeconds: cpu.user / 1_000_000,
    cpuSystemSeconds: cpu.system / 1_000_000,
    cpuTotalSeconds: (cpu.user + cpu.system) / 1_000_000,
    averageCpuPercentOfOneCore: wallMs > 0 ? (cpu.user + cpu.system) / (wallMs * 10) : 0,
    peakSampledRssMiB: Math.max(...memorySamples.map(sample => sample.rssBytes)) / 1_048_576,
    meanSampledRssMiB: memorySamples.reduce((sum, sample) => sum + sample.rssBytes, 0)
      / memorySamples.length / 1_048_576,
    processPeakRssMiB: process.platform === "linux"
      ? Math.max(...memorySamples.map(sample => sample.highWaterBytes || 0)) / 1_048_576 : null,
    memorySampleCount: memorySamples.length,
    memorySampleIntervalMs: 1000,
    scope: "CPU covers extraction and validation; Linux process peak RSS includes startup/imports. Excludes result-file serialization and remote model CPU/RAM.",
  };
  result.elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
  const usageByModel = {};
  const reconciliationServiceTiers = {};
  for (const event of events.filter(event => event.name === "llm.call.token_usage")) {
    const usage = usageByModel[event.properties.model] ??= { calls: 0, inputTokens: 0, outputTokens: 0,
      reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, toolCalls: 0, pageReadCalls: 0, contextSearchCalls: 0 };
    usage.calls++;
    for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens", "cacheWriteTokens",
      "toolCalls", "pageReadCalls", "contextSearchCalls"]) usage[key] += event.measurements?.[key] ?? 0;
    if (event.properties.stage === "reconciliation") {
      const tier = event.properties.serviceTier || "unreported";
      reconciliationServiceTiers[tier] = (reconciliationServiceTiers[tier] || 0) + 1;
    }
  }
  Object.assign(result.statistics, {
    completedWindows: events.filter(event => event.name === "evidenceExtractor.windowCompleted").length,
    restoredWindows: events.filter(event => event.name === "evidenceExtractor.windowRestored").length,
    restoredStages: events.filter(event => event.name === "evidenceExtractor.stageRestored").length,
    savedStages: events.filter(event => event.name === "evidenceExtractor.stageSaved").length,
    capturedWindows: events.filter(event => event.name === "evidenceExtractor.candidateSnapshotCaptured").length,
    reusedCandidateWindows: events.filter(event => event.name === "evidenceExtractor.candidateSnapshotReused").length,
    replayedWindows: events.filter(event => event.name === "evidenceExtractor.candidateSnapshotReplayed").length,
    repairAttempts: events.filter(event => event.name === "evidenceExtractor.candidateRepair").length,
    rejectedCandidates: events.filter(event => event.name === "evidenceExtractor.candidateRejected").length,
    boundaryReviewRequests: events.filter(event => event.name === "evidenceExtractor.boundaryReviewRequested").length,
    eventClassificationReviewRequests: events.filter(event => event.name === "evidenceExtractor.eventClassificationReviewRequested").length,
    claimAttributionsResolved: events.filter(event => event.name === "evidenceExtractor.claimAttributionReviewed"
      && event.properties.outcome === "resolved").length,
    claimAttributionsUnresolved: events.filter(event => event.name === "evidenceExtractor.claimAttributionReviewed"
      && event.properties.outcome === "unknown").length,
    reviewLoopsEscalated: events.filter(event => event.name === "evidenceExtractor.reviewLoopEscalated").length,
    structuredReviewRecoveries: events.filter(event => event.name === "evidenceExtractor.structuredReviewRecovered").length,
    missingStructuredResponseRetries: events.filter(event => event.name === "evidenceExtractor.missingStructuredResponseRetry").length,
    eventDateFallbackRequests: events.filter(event => event.name === "evidenceExtractor.eventDateFallbackRequested").length,
    eventDatesRecovered: events.filter(event => event.name === "evidenceExtractor.eventDateFallbackReviewed"
      && event.properties.outcome === "date-recovered").length,
    eventDateBoundsResolved: events.filter(event => event.name === "evidenceExtractor.eventDateFallbackReviewed"
      && event.properties.relation === "bounded").length,
    eventsRetainedUndatedAfterFallback: events.filter(event => event.name === "evidenceExtractor.eventDateFallbackReviewed"
      && event.properties.outcome === "retained-undated").length,
    reviewBatches: events.filter(event => event.name === "evidenceExtractor.reviewBatchCompleted").length,
    reviewInvocations: events.filter(event => event.name === "evidenceExtractor.agentInvocationCompleted"
      && event.properties.stage === "reconciliation").length,
    canonicalization: (() => {
      const completed = events.findLast(event => event.name === "evidenceExtractor.canonicalizationCompleted");
      return completed ? {
        pairCount: Number(completed.properties.pairCount),
        proposedMergeCount: Number(completed.properties.proposedMergeCount),
        mergedCount: Number(completed.properties.mergedCount),
        failedBatches: Number(completed.properties.failedBatches),
      } : null;
    })(),
    usageByModel,
    reconciliationServiceTiers,
  });
  await mkdir(dirname(resolve(values.output)), { recursive: true });
  await writeFile(resolve(values.output), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ event: "liveTestFinished", elapsedSeconds: result.elapsedSeconds,
    documents: result.documents.length, checks: result.checks, statistics: result.statistics, resources: result.resources,
    error: result.error, output: resolve(values.output) }, null, 2));
}
