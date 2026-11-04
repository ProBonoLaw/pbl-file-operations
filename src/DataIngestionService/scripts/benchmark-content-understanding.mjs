import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Document } from "@langchain/core/documents";
import { EvidenceSource } from "../dist/src/processors/evidence/evidenceSource.js";
import { evidenceSkillsFingerprint } from "../dist/src/processors/evidence/evidenceSkills.js";
import { analyzerDefinition, layoutDefinition, layoutSource, normalizeCandidates, validateSnapshots,
  combineSnapshots, documentMetrics, priceUsage, gradeJudgments, pipelineMeasurements, combineCosts,
  sha256, API_VERSION } from "./content-understanding-benchmark.mjs";
import { ContentUnderstandingClient } from "./content-understanding-client.mjs";

const { values } = parseArgs({ options: {
  input: { type: "string" }, output: { type: "string" }, stage: { type: "string", default: "prepare" },
  settings: { type: "string" }, live: { type: "boolean", default: false }, arm: { type: "string" },
  response: { type: "string" }, receipt: { type: "string" }, encoding: { type: "string" }, reference: { type: "string" },
  judgments: { type: "string" }, rates: { type: "string" },
} });
const stages = ["prepare", "cu-candidates", "cu-layout", "capture-baseline", "capture-layout", "replay", "report"];
assert(values.input && values.output, "Provide --input FIXTURE.json --output DIRECTORY");
assert(stages.includes(values.stage), `--stage must be one of ${stages.join(", ")}`);
assert(!values.live || values.settings, "Live calls require an explicit --settings FILE");
assert(!values.response || ["cu-candidates", "cu-layout"].includes(values.stage), "--response only imports CU results");
assert(!(values.live && values.response), "Choose live analysis or saved response import");
assert(!values.response || values.encoding === "utf16", "Saved response import requires --encoding utf16");
assert(!values.response || values.receipt, "Saved response import requires its --receipt FILE with source and analyzer hashes");
const output = resolve(values.output), fixturePath = resolve(values.input), root = dirname(fixturePath);
const readJSON = async path => JSON.parse(await readFile(path, "utf8"));
const optionalJSON = async path => { try { return await readJSON(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const save = async (path, value) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, path);
};
const freeze = async (name, value) => {
  const path = resolve(output, name), existing = await optionalJSON(path);
  if (existing) assert.deepEqual(existing, value, `${name} changed; use a new output directory`);
  else await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
};
const fixture = await readJSON(fixturePath);
assert.equal(fixture.version, 1);
assert(fixture.source?.id && fixture.source?.markdown && fixture.source?.sha256 && fixture.source?.pdf && fixture.source?.pdfSha256,
  "Freeze both source Markdown and original PDF hashes");
assert(typeof fixture.contentUnderstanding?.completionModel === "string", "Choose a supported Content Understanding completion model");
assert(["development-regression", "held-out"].includes(fixture.evaluationStatus), "Declare evaluationStatus");
const sourceText = await readFile(resolve(root, fixture.source.markdown), "utf8");
const pdf = await readFile(resolve(root, fixture.source.pdf));
assert.equal(sha256(sourceText), fixture.source.sha256, "Canonical source changed");
assert.equal(sha256(pdf), fixture.source.pdfSha256, "Original PDF changed");
const makeDocument = text => new Document({ pageContent: text,
  metadata: { sourceId: fixture.source.id, title: fixture.source.title ?? "Document",
    pages: text.split("<!-- PageBreak -->").map((_, index) => index + 1) } });
const document = makeDocument(sourceText), source = new EvidenceSource(document);

// Initialize telemetry locally before importing the extractor. No application,
// indexing, event hubs, tracing exporter or notifications are started.
const { default: appInsights } = await import("applicationinsights");
appInsights.setup("InstrumentationKey=00000000-0000-0000-0000-000000000000");
appInsights.defaultClient.config.disableAppInsights = true;
const events = [];
let eventLog;
const recordEvent = event => {
  events.push(event);
  if (eventLog) appendFileSync(eventLog, JSON.stringify(event) + "\n", { mode: 0o600 });
};
Object.assign(appInsights.defaultClient, { trackEvent: recordEvent,
  trackException({ exception, properties }) { recordEvent({ name: "exception", properties: { ...properties, errorType: exception.name } }); } });
process.env.LANGSMITH_TRACING = "false"; process.env.LANGCHAIN_TRACING_V2 = "false";
const { EvidenceExtractor, evidenceCandidateSchemas, CandidateSnapshotSchema } = await import("../dist/src/processors/evidence/evidenceExtractor.js");
const definitions = { candidates: analyzerDefinition(evidenceCandidateSchemas, fixture.contentUnderstanding.completionModel), layout: layoutDefinition() };
const implementationRoot = new URL("../dist/src/processors/evidence/", import.meta.url);
const implementationFiles = (await readdir(implementationRoot)).filter(name => name.endsWith(".js")).sort();
const implementationHash = sha256(JSON.stringify(await Promise.all(implementationFiles.map(async name =>
  [name, sha256(await readFile(new URL(name, implementationRoot)))]))));
const runnerHash = sha256(JSON.stringify(await Promise.all(["benchmark-content-understanding.mjs", "content-understanding-benchmark.mjs", "content-understanding-client.mjs"]
  .map(async name => [name, sha256(await readFile(new URL(name, import.meta.url)))]))));
const manifest = { version: 1, fixtureHash: sha256(await readFile(fixturePath)), sourceHash: source.contentHash,
  pdfHash: sha256(pdf), evaluationStatus: fixture.evaluationStatus, implementationHash, runnerHash,
  skillsHash: await evidenceSkillsFingerprint(), dependencyHash: sha256(await readFile(new URL("../bun.lock", import.meta.url))),
  apiVersion: API_VERSION, stringEncoding: "utf16", sourceId: fixture.source.id,
  contentUnderstanding: fixture.contentUnderstanding, definitions,
  baselineProvenance: fixture.baseline?.provenance ?? "Capture with the frozen implementation and explicit settings",
  comparisons: {
    candidates: "Same canonical Markdown; same saved baseline candidates and downstream configuration. Compare baseline, CU replacement and baseline plus CU.",
    layout: "Same original PDF; CU OCR/layout Markdown replaces the frozen Document Intelligence Markdown. Fresh extraction is required.",
  } };
await mkdir(output, { recursive: true, mode: 0o700 });
await freeze("manifest.json", manifest);
if (fixture.baseline?.candidates) {
  const path = resolve(root, fixture.baseline.candidates);
  const snapshots = await Promise.all((await readdir(path)).filter(name => name.endsWith(".json")).sort().map(name => readJSON(resolve(path, name))));
  await freeze("baseline.snapshots.json", validateSnapshots(snapshots, source, CandidateSnapshotSchema));
}
if (fixture.baseline?.captureMetrics) await freeze("baseline.imported-metrics.json", await readJSON(resolve(root, fixture.baseline.captureMetrics)));
const manifestHash = sha256(JSON.stringify(manifest));
const summary = value => console.log(JSON.stringify({ stage: values.stage, output, ...value }));

if (values.stage === "prepare") {
  summary({ modelCalls: 0, pages: source.pages.filter(page => page.text.trim()).length, windows: source.windows().length,
    baselineCandidates: (await optionalJSON(resolve(output, "baseline.snapshots.json")))?.reduce((sum, row) => sum + row.candidates.length, 0) ?? null,
    evaluationStatus: fixture.evaluationStatus });
} else if (["cu-candidates", "cu-layout"].includes(values.stage)) {
  const label = values.stage === "cu-candidates" ? "candidates" : "layout", definition = definitions[label];
  const analyzerId = `aimie-benchmark-${label}-${sha256(JSON.stringify(definition)).slice(0, 20)}`;
  const receiptFor = response => ({ version: 1, inputHash: label === "layout" ? sha256(pdf) : source.contentHash,
    definitionHash: sha256(JSON.stringify(definition)), apiVersion: API_VERSION, stringEncoding: "utf16", responseHash: sha256(JSON.stringify(response)) });
  let response;
  if (values.response) {
    response = await readJSON(resolve(values.response));
    assert.equal(response.result?.analyzerId, analyzerId, "Imported response uses a different analyzer");
    assert.deepEqual(await readJSON(resolve(values.receipt)), receiptFor(response), "Imported response receipt differs from frozen inputs");
    await freeze(`${label}.import.json`, { pathHash: sha256(await readFile(resolve(values.response))), manifestHash, stringEncoding: values.encoding });
  } else {
    assert(values.live, "Use --live --settings FILE or --response FILE --encoding utf16");
    const settings = await readJSON(resolve(values.settings));
    assert(settings.CONTENT_UNDERSTANDING_ENDPOINT, "CONTENT_UNDERSTANDING_ENDPOINT is missing from settings");
    const credential = settings.CONTENT_UNDERSTANDING_API_KEY ? null : new (await import("@azure/identity")).DefaultAzureCredential();
    const headers = async () => settings.CONTENT_UNDERSTANDING_API_KEY
      ? { "Ocp-Apim-Subscription-Key": settings.CONTENT_UNDERSTANDING_API_KEY }
      : { Authorization: `Bearer ${(await credential.getToken("https://cognitiveservices.azure.com/.default")).token}` };
    const client = new ContentUnderstandingClient({ endpoint: settings.CONTENT_UNDERSTANDING_ENDPOINT, headers,
      processingLocation: fixture.contentUnderstanding.processingLocation ?? "geography" });
    // Verify supported models against the actual resource, not a stale catalog.
    const base = (await client.request(client.url("analyzers/prebuilt-document"))).data;
    if (label === "candidates") {
      const supported = base.supportedModels?.completion;
      assert(Array.isArray(supported) && supported.includes(fixture.contentUnderstanding.completionModel), "Selected model is not supported by this resource's base analyzer");
    }
    const modelDeployments = await client.modelDeployments(fixture.contentUnderstanding.modelDeployments);
    if (label === "candidates") assert(typeof modelDeployments[fixture.contentUnderstanding.completionModel] === "string",
      "No deployment mapping for the selected completion model; specify contentUnderstanding.modelDeployments in the fixture");
    await freeze(`${label}.model-deployments.json`, modelDeployments);
    const analyzer = await client.ensureAnalyzer(analyzerId, definition);
    await freeze(`${label}.analyzer.json`, analyzer);
    const journalPath = resolve(output, `${label}.operation.json`);
    const input = label === "layout" ? { data: pdf.toString("base64"), mimeType: "application/pdf", name: "source.pdf" }
      : { data: Buffer.from(sourceText).toString("base64"), mimeType: "text/markdown", name: "source.md" };
    const identity = { manifestHash, analyzerId, inputHash: label === "layout" ? sha256(pdf) : source.contentHash,
      endpointHash: sha256(client.endpoint), modelDeployments: modelDeployments ?? null, stringEncoding: "utf16" };
    const journal = await client.analyze({ analyzerId, input, modelDeployments, identity,
      journal: await optionalJSON(journalPath), save: state => save(journalPath, state) });
    response = journal.response;
  }
  if (response.result?.apiVersion) assert.equal(response.result.apiVersion, API_VERSION, "Response API version differs");
  await freeze(`${label}.receipt.json`, receiptFor(response));
  await freeze(`${label}.response.json`, response);
  if (label === "candidates") {
    const normalized = normalizeCandidates(response, source, evidenceCandidateSchemas, { stringEncoding: "utf16", analyzerId });
    await freeze("cu.normalization.json", normalized);
    await freeze("cu.snapshots.json", validateSnapshots(normalized.snapshots, source, CandidateSnapshotSchema));
    summary({ accepted: normalized.accepted.length, rejected: normalized.rejected.length, missingCategories: normalized.missingCategories });
    if (normalized.missingCategories.length) process.exitCode = 1;
  } else {
    const text = layoutSource(response, "utf16");
    const path = resolve(output, "layout-source.md");
    try { assert.equal(await readFile(path, "utf8"), text, "Layout source changed"); }
    catch (error) { if (error.code !== "ENOENT") throw error; await writeFile(path, text, { flag: "wx", mode: 0o600 }); }
    summary({ sourceHash: sha256(text), pages: text.split("<!-- PageBreak -->").length });
  }
} else if (["capture-baseline", "capture-layout", "replay"].includes(values.stage)) {
  assert(values.live && values.settings, "Pipeline stages require --live --settings FILE");
  const arm = values.stage === "capture-baseline" ? "baseline" : values.stage === "capture-layout" ? "layout" : values.arm;
  assert(["baseline", "cu", "supplement", "layout"].includes(arm), "Replay requires --arm baseline|cu|supplement|layout");
  const settings = await readJSON(resolve(values.settings));
  for (const name of Object.keys(process.env)) if (/^(AZURE_OPENAI_|EVIDENCE_|LANGCHAIN_|LANGSMITH_)/.test(name)) delete process.env[name];
  for (const [name, value] of Object.entries(settings)) if (/^(AZURE_OPENAI_|EVIDENCE_)/.test(name) && ["string", "number", "boolean"].includes(typeof value)) process.env[name] = String(value);
  process.env.LANGSMITH_TRACING = "false"; process.env.LANGCHAIN_TRACING_V2 = "false";
  assert.equal(process.env.EVIDENCE_CANONICALIZATION_MODE, "review", "Benchmark requires canonicalization review");
  assert.equal(process.env.EVIDENCE_EVENT_STRUCTURE_MODE, "annotate", "Benchmark requires event annotations");
  const configuration = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(AZURE_OPENAI_|EVIDENCE_)/.test(name)
    && !/(?:API_KEY|SECRET|ACCESS_TOKEN|CHECKPOINT_EPOCH)$/.test(name)).sort());
  const pipelineIdentity = { manifestHash, configurationHash: sha256(JSON.stringify(configuration)),
    configuration: Object.fromEntries(Object.entries(configuration).filter(([name]) => !/ENDPOINT/.test(name))) };
  await freeze("pipeline-identity.json", pipelineIdentity);
  const localDocument = arm === "layout" ? makeDocument(await readFile(resolve(output, "layout-source.md"), "utf8")) : document;
  const localSource = new EvidenceSource(localDocument), capture = values.stage.startsWith("capture-");
  let snapshots;
  if (!capture) {
    snapshots = arm === "supplement"
      ? combineSnapshots(await readJSON(resolve(output, "baseline.snapshots.json")), await readJSON(resolve(output, "cu.snapshots.json")))
      : await readJSON(resolve(output, `${arm}.snapshots.json`));
    snapshots = validateSnapshots(snapshots, localSource, CandidateSnapshotSchema);
    await freeze(`${arm}.replay-input.json`, snapshots);
  }
  const prefix = `${arm}.${capture ? "capture" : "replay"}`, resultPath = resolve(output, `${prefix}.json`);
  const inputHash = capture ? localSource.contentHash : sha256(JSON.stringify(snapshots));
  const previous = await optionalJSON(resultPath);
  if (previous) {
    assert.equal(previous.manifestHash, manifestHash, "Saved pipeline result belongs to a different benchmark");
    assert.equal(previous.inputHash, inputHash, "Saved pipeline result uses different inputs");
    assert.deepEqual(previous.pipelineIdentity, pipelineIdentity, "Saved pipeline configuration differs");
  }
  if (previous?.status === "completed") { summary({ arm, reused: true }); process.exit(0); }
  if (capture && !previous) assert(!await optionalJSON(resolve(output, `${arm}.snapshots.json`)), "Candidates are already frozen; use a new fixture/output for fresh extraction");
  if (previous?.activeAttempt) {
    assert(/^[0-9a-f-]{36}$/.test(previous.activeAttempt.id), "Invalid attempt log identifier");
    const path = resolve(output, "attempts", `${prefix}.${previous.activeAttempt.id}.jsonl`);
    let raw = "";
    try { raw = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const recovered = [];
    for (const line of raw.split("\n").filter(Boolean)) {
      try { recovered.push(JSON.parse(line)); } catch { break; }
    }
    previous.attempts.push({ status: "interrupted", elapsedMs: null, events: recovered,
      note: "Recovered telemetry after interruption; total time and unreported usage are unknown." });
  }
  // Candidate sets are part of checkpoint identity; completed baseline work must
  // never be restored into the supplement or replacement arm.
  process.env.EVIDENCE_CHECKPOINT_EPOCH = sha256(JSON.stringify({ manifestHash, inputHash, prefix }));
  const checkpointPath = (identity, index, stage = "window") => resolve(output, "checkpoints", prefix,
    sha256(JSON.stringify(identity)), String(index), `${sha256(stage)}.json`);
  const checkpointStore = {
    get: (identity, index) => optionalJSON(checkpointPath(identity, index)),
    put: (identity, index, value) => save(checkpointPath(identity, index), value),
    getStage: (identity, index, stage) => optionalJSON(checkpointPath(identity, index, stage)),
    putStage: (identity, index, stage, value) => save(checkpointPath(identity, index, stage), value),
    clearSource: async () => { throw new Error("Benchmark checkpoints are immutable audit artifacts"); },
    clearAccount: async () => { throw new Error("Benchmark checkpoints are immutable audit artifacts"); },
  };
  const capturePath = window => resolve(output, "captured", arm, `${window.pageNumber}-${window.startOffset}.json`);
  const store = { mode: capture ? "captureOnly" : "replay",
    get: async window => capture ? optionalJSON(capturePath(window))
      : snapshots.find(item => item.pageNumber === window.pageNumber && item.startOffset === window.startOffset),
    put: async (window, snapshot) => { assert(capture); await save(capturePath(window), snapshot); } };
  const started = Date.now(), extractor = new EvidenceExtractor("content-understanding-benchmark", fixture.source.id, undefined, checkpointStore, store);
  const row = { manifestHash, inputHash, pipelineIdentity, arm, status: "running", sourceHash: localSource.contentHash,
    attempts: previous?.attempts ?? [], activeAttempt: { id: randomUUID(), startedAt: started } };
  await mkdir(resolve(output, "attempts"), { recursive: true, mode: 0o700 });
  eventLog = resolve(output, "attempts", `${prefix}.${row.activeAttempt.id}.jsonl`);
  await save(resultPath, row);
  const decisions = [], invokeStructured = extractor.invokeStructured.bind(extractor);
  extractor.invokeStructured = async (...args) => {
    const response = await invokeStructured(...args);
    if (["reconciliation", "reconciliation-fallback"].includes(args[4])) {
      const observed = (response.decisions ?? []).filter(decision => typeof decision.keepOriginal === "boolean");
      decisions.push(...observed);
      await save(resolve(output, "invocations", prefix, `${randomUUID()}.json`), { stage: args[4], decisions: observed });
    }
    return response;
  };
  // Observe existing reconciliation/canonicalization without changing decisions.
  const canonicalize = extractor.canonicalizeDocuments.bind(extractor);
  extractor.canonicalizeDocuments = async (...args) => {
    const result = await canonicalize(...args);
    await save(resolve(output, `${prefix}.canonicalization.json`), result);
    if (result.failedBatches) throw new Error("Canonicalization has failed batches");
    return result;
  };
  try {
    row.documents = await extractor.generateDocuments(localDocument);
    if (capture) {
      const captured = await Promise.all(localSource.windows().map(window => readJSON(capturePath(window))));
      await freeze(`${arm}.snapshots.json`, validateSnapshots(captured, localSource, CandidateSnapshotSchema));
    }
    row.status = "completed";
  } catch (error) { row.status = "failed"; row.error = { name: error.name, message: error.message }; }
  row.attempts.push({ elapsedMs: Date.now() - started, events: [...events], decisions, status: row.status });
  delete row.activeAttempt;
  row.elapsedMs = row.attempts.every(attempt => typeof attempt.elapsedMs === "number")
    ? row.attempts.reduce((total, attempt) => total + attempt.elapsedMs, 0) : null;
  await save(resultPath, row);
  summary({ arm, status: row.status, elapsedMs: row.elapsedMs, records: row.documents?.length ?? null });
  if (row.status !== "completed") process.exitCode = 1;
} else {
  const rates = values.rates ? await readJSON(resolve(values.rates)) : null;
  const reference = values.reference ? await readJSON(resolve(values.reference)) : null;
  const judgments = values.judgments ? await readJSON(resolve(values.judgments)) : null;
  assert(!judgments || reference, "Judgments require --reference FILE");
  if (reference) assert.equal(reference.pdfSha256, manifest.pdfHash, "Reference belongs to another source PDF");
  const referenceHash = reference ? sha256(JSON.stringify(reference)) : null;
  if (judgments) { assert.equal(judgments.manifestHash, manifestHash); assert.equal(judgments.referenceHash, referenceHash); }
  const report = { manifestHash, referenceHash, evaluationStatus: fixture.evaluationStatus, arms: {}, service: {},
    limitations: ["NTSB provisional references are not an exhaustive gold inventory. Recall requires exhaustive human-adjudicated units and complete output judgments.",
      "Exact citation matching measures text identity; semantic support and OCR fidelity still require source review.",
      "Candidate comparisons freeze baseline inputs; added candidates necessarily change reconciliation batches. Model-call nondeterminism remains.",
      "Whole-document CU analysis and the windowed baseline receive the same source bytes but have different context strategies.",
      "Pipeline event telemetry includes token usage, not Azure invoices. Missing usage and missing rates leave total cost unknown."] };
  for (const label of ["candidates", "layout"]) {
    const operation = await optionalJSON(resolve(output, `${label}.operation.json`));
    const response = await optionalJSON(resolve(output, `${label}.response.json`)) ?? operation?.response;
    if (response) report.service[label] = { elapsedMs: operation?.activeElapsedMs ?? null, status: response.status,
      usage: response.usage ?? response.result?.usage ?? null, warnings: response.result?.warnings ?? [], infos: response.result?.infos ?? [],
      cost: priceUsage(response.usage ?? response.result?.usage ?? null, rates?.contentUnderstanding) };
  }
  const review = { manifestHash, referenceHash, arms: {} };
  const pipelineCost = measurements => {
    const cost = priceUsage(measurements?.meters, rates?.pipeline);
    if (measurements?.usageComplete === false) { cost.total = null; cost.missing.push("interruptedAttemptUsage"); }
    return cost;
  };
  const baselineCapture = await optionalJSON(resolve(output, "baseline.capture.json"));
  const importedCapture = await optionalJSON(resolve(output, "baseline.imported-metrics.json"));
  const baselineCaptureMeasurements = baselineCapture ? pipelineMeasurements(baselineCapture.attempts)
    : importedCapture ? { meters: importedCapture.usageMeters, usageComplete: importedCapture.usageComplete === true } : null;
  const baselineCaptureMs = baselineCapture?.elapsedMs ?? importedCapture?.elapsedMs ?? null;
  const parserCost = priceUsage(fixture.baseline?.parsing?.usageMeters ?? null, rates?.documentIntelligence);
  const baselineCaptureCost = pipelineCost(baselineCaptureMeasurements);
  for (const arm of ["baseline", "cu", "supplement", "layout"]) {
    const result = await optionalJSON(resolve(output, `${arm}.replay.json`));
    if (!result) { report.arms[arm] = { status: "not-run" }; continue; }
    if (result.status === "running") { report.arms[arm] = { status: "running-or-interrupted", totalCost: null }; continue; }
    const localSource = arm === "layout" ? new EvidenceSource(makeDocument(await readFile(resolve(output, "layout-source.md"), "utf8"))) : source;
    assert.equal(result.manifestHash, manifestHash, "Replay belongs to a different benchmark");
    assert.equal(result.sourceHash, localSource.contentHash, "Replay source differs");
    assert.deepEqual(result.pipelineIdentity, await readJSON(resolve(output, "pipeline-identity.json")), "Replay model configuration differs");
    const replayInput = validateSnapshots(await readJSON(resolve(output, `${arm}.replay-input.json`)), localSource, CandidateSnapshotSchema);
    assert.equal(result.inputHash, sha256(JSON.stringify(replayInput)), "Replay candidates differ");
    const metrics = documentMetrics(result.documents ?? [], localSource);
    const resultHash = sha256(JSON.stringify(result));
    if (judgments?.arms?.[arm]) assert.equal(judgments.arms[arm].resultHash, resultHash, "Judgments belong to different output records");
    const measurements = pipelineMeasurements(result.attempts);
    const capture = arm === "layout" ? await optionalJSON(resolve(output, "layout.capture.json")) : baselineCapture;
    const captureMs = arm === "layout" ? capture?.elapsedMs ?? null : baselineCaptureMs;
    const components = { replay: pipelineCost(measurements) };
    const times = [result.elapsedMs];
    if (arm === "layout") {
      components.parsing = report.service.layout?.cost ?? null;
      components.capture = pipelineCost(capture ? pipelineMeasurements(capture.attempts) : null);
      times.push(report.service.layout?.elapsedMs ?? null, captureMs);
    } else {
      components.parsing = parserCost; times.push(fixture.baseline?.parsing?.elapsedMs ?? null);
      if (arm !== "cu") { components.capture = baselineCaptureCost; times.push(captureMs); }
      if (arm !== "baseline") { components.contentUnderstanding = report.service.candidates?.cost ?? null; times.push(report.service.candidates?.elapsedMs ?? null); }
    }
    report.arms[arm] = { status: result.status, resultHash, ...metrics, records: undefined,
      replayElapsedMs: result.elapsedMs, captureElapsedMs: arm === "cu" ? null : captureMs, measurements,
      totalProcessingMs: times.every(value => typeof value === "number") ? times.reduce((sum, value) => sum + value, 0) : null,
      semantic: result.status === "completed" && judgments?.arms?.[arm] && reference ? gradeJudgments(metrics.records, reference, judgments.arms[arm].records) : null,
      cost: combineCosts(components) };
    review.arms[arm] = { resultHash, records: metrics.records.map(record => ({ ...record, recordId: record.id,
      supported: null, classificationCorrect: null, citationSupported: null, atomic: null, unitIds: [],
    })) };
  }
  for (const arm of Object.keys(judgments?.arms ?? {})) assert.equal(report.arms[arm]?.status, "completed", "Judgments require a completed known arm");
  report.normalization = await optionalJSON(resolve(output, "cu.normalization.json"));
  if (report.normalization) report.normalization = { accepted: report.normalization.accepted.length,
    rejected: report.normalization.rejected.length, missingCategories: report.normalization.missingCategories };
  await save(resolve(output, "report.json"), report);
  await save(resolve(output, "review-records.json"), review);
  summary({ arms: Object.fromEntries(Object.entries(report.arms).map(([arm, row]) => [arm, { status: row.status, records: row.count }])),
    semanticScores: judgments ? "provided judgments" : "pending independent review" });
}
