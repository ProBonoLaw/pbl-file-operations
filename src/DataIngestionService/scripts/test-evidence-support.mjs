import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { validateSupportSuite, supportCaseInput, gradeSupportSuite, summarizeSupportRun } from "./evidence-support-benchmark.mjs";

const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {values} = parseArgs({options: {
  live: {type: "boolean", default: false}, settings: {type: "string"},
  predictions: {type: "string"}, output: {type: "string"}, case: {type: "string"},
  eventStructure: {type: "string", default: "configured"},
  fixture: {type: "string", default: resolve(serviceDirectory, "test/fixtures/evidence-support.json")},
}});
assert.ok(values.output, "--output is required");
assert.ok(values.live !== !!values.predictions, "Choose --predictions FILE for offline grading or --live for model calls");
assert.ok(!values.live || values.settings, "--live requires an explicit --settings FILE");
assert.ok(["configured", "off", "annotate"].includes(values.eventStructure), "--eventStructure must be configured, off or annotate");
const rawFixture = await readFile(resolve(values.fixture), "utf8");
const suite = validateSupportSuite(JSON.parse(rawFixture));
if (values.case) {
  suite.cases = suite.cases.filter(item => item.id === values.case);
  assert.equal(suite.cases.length, 1, "Unknown --case");
}
const fixtureHash = createHash("sha256").update(rawFixture).digest("hex");
const output = resolve(values.output);
assert.notEqual(output, resolve(values.fixture), "Output must not overwrite the fixture");
if (values.settings) assert.notEqual(output, resolve(values.settings), "Output must not overwrite settings");
if (values.predictions) assert.notEqual(output, resolve(values.predictions), "Output must not overwrite predictions");
const save = async value => {
  await mkdir(dirname(output), {recursive: true, mode: 0o700});
  const temporary = `${output}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {mode: 0o600});
  await rename(temporary, output);
};

let predictions;
let configuration;
if (!values.live) {
  const saved = JSON.parse(await readFile(resolve(values.predictions), "utf8"));
  if (saved.fixtureHash) assert.equal(saved.fixtureHash, fixtureHash, "Predictions use a different fixture version");
  predictions = saved.predictions ?? saved;
  if (values.case && Array.isArray(predictions)) predictions = predictions.filter(row => row?.caseId === values.case);
} else {
  // Keep these inputs explicit and isolated from shell overrides. Only model
  // credentials/configuration are loaded; indexing and notifications never run.
  const settings = JSON.parse(await readFile(resolve(values.settings), "utf8"));
  assert.ok(settings && typeof settings === "object" && !Array.isArray(settings), "Invalid settings object");
  for (const name of Object.keys(process.env)) if (/^(AZURE_OPENAI_|EVIDENCE_)/.test(name)) delete process.env[name];
  for (const [name, value] of Object.entries(settings)) {
    if (/^(AZURE_OPENAI_|EVIDENCE_)/.test(name) && ["string", "number", "boolean"].includes(typeof value)) process.env[name] = String(value);
  }
  process.env.EVIDENCE_CANONICALIZATION_MODE = "off";
  if (values.eventStructure !== "configured") process.env.EVIDENCE_EVENT_STRUCTURE_MODE = values.eventStructure;
  configuration = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => /^(?:EVIDENCE_(?:PRIMARY|INDEPENDENT|RECONCILIATION)_(?:DEPLOYMENT_NAME|PROVIDER|REASONING)|EVIDENCE_EVENT_STRUCTURE_MODE|EVIDENCE_RECONCILIATION_FALLBACK|AZURE_OPENAI_API_DEPLOYMENT_NAME|AZURE_OPENAI_VERBOSITY)$/.test(key)));

  const {default: appInsights} = await import("applicationinsights");
  appInsights.setup("InstrumentationKey=00000000-0000-0000-0000-000000000000");
  appInsights.defaultClient.config.disableAppInsights = true;
  let events = [];
  Object.assign(appInsights.defaultClient, {
    trackEvent(event) { events.push(event); },
    trackException({exception, properties}) { events.push({name: "exception", properties: {...properties, errorType: exception.name}}); },
  });
  const {EvidenceExtractor} = await import("../dist/src/processors/evidence/evidenceExtractor.js");
  const {EvidenceSource} = await import("../dist/src/processors/evidence/evidenceSource.js");
  predictions = [];
  for (const item of suite.cases) {
    const {document, store} = supportCaseInput(item);
    const source = new EvidenceSource(document);
    const window = source.windows().find(window => window.pageNumber === item.targetPage && window.startOffset === 0);
    assert.ok(window && source.windows().filter(window => window.pageNumber === item.targetPage).length === 1,
      "Benchmark cases must fit one target window");
    const prompt = JSON.parse(source.prompt(window));
    const supplied = [prompt.target, prompt.precedingContext, prompt.followingContext];
    // This is an oracle-context interpretation benchmark: every gold passage is
    // present in the actual source prompt. Do not claim a retrieval measurement.
    assert.ok(item.contextMode === "document" || item.evidence.every(unit => supplied.some(passage => passage.pageNumber === unit.page && passage.text.includes(unit.quote))),
      "Every gold passage must fit the supplied source context; use a separate retrieval benchmark for larger cases");
    const prediction = {caseId: item.id, documents: [], contextMode: item.contextMode,
      availableEvidenceIds: item.contextMode === "oracle" ? item.evidence.map(unit => unit.id) : null};
    events = [];
    const started = Date.now();
    try {
      prediction.documents = await new EvidenceExtractor("support-benchmark", item.id, undefined, undefined, store).generateDocuments(document);
    } catch (error) {
      prediction.failure = ["GraphRecursionError", "MultipleStructuredOutputsError"].includes(error?.constructor?.name) ? "loop"
        : error?.name === "ZodError" || error?.constructor?.name === "InvalidReconciliationResponseError" ? "schema"
          : events.some(event => event.name === "evidenceExtractor.agentInvocationCompleted" && event.properties.status === "failed")
            ? "invocation" : "pipeline";
      prediction.errorType = error?.name ?? "Error";
      prediction.errorMessage = error instanceof Error ? error.message : String(error);
    }
    prediction.elapsedMs = Date.now() - started;
    prediction.events = events;
    predictions.push(prediction);
    await save({fixtureHash, mode: "live-source-support", configuration, predictions,
      report: gradeSupportSuite(suite, predictions), measurements: summarizeSupportRun(predictions)});
    console.log(JSON.stringify({caseId: item.id, elapsedMs: prediction.elapsedMs, completed: !prediction.failure}));
  }
}
const report = gradeSupportSuite(suite, predictions);
await save({fixtureHash, mode: values.live ? "live-source-support" : "offline-grade", configuration, predictions, report,
  measurements: summarizeSupportRun(predictions)});
console.log(JSON.stringify({total: report.total, passed: report.passed, failures: report.failures, output}));
if (report.passed !== report.total) process.exitCode = 1;
