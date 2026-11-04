import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Document } from "@langchain/core/documents";
import appInsights from "applicationinsights";
import { loadAppSettings } from "../dist/src/settings.js";

const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(serviceDirectory, "../..");
const { values } = parseArgs({ options: {
  input: { type: "string" },
  output: { type: "string" },
  settings: { type: "string", default: resolve(repositoryDirectory, ".vscode/azure-test.appsettings.json") },
} });
assert.ok(values.input && values.output, "Provide --input BEFORE.json and --output AFTER.json");
const inputFile = resolve(values.input);
const outputFile = resolve(values.output);
try {
  await access(outputFile);
  throw new Error(`Refusing to replace an existing canonicalization result: ${outputFile}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

// Match the live runner: the selected private settings file controls this isolated process.
const settings = JSON.parse(await readFile(resolve(values.settings), "utf8"));
for (const name of Object.keys(process.env)) {
  if (/^(AZURE_OPENAI_|EVIDENCE_)/.test(name)) delete process.env[name];
}
process.env.APPSETTINGS_FILE = resolve(values.settings);
await loadAppSettings();
assert.ok(settings.AZURE_OPENAI_LLM_API_KEY, "The selected settings need an LLM API key");

const events = [];
appInsights.setup("InstrumentationKey=00000000-0000-0000-0000-000000000000");
appInsights.defaultClient.config.disableAppInsights = true;
Object.assign(appInsights.defaultClient, {
  trackEvent(event) { events.push(event); },
  trackException({ exception, properties }) {
    events.push({ name: "exception", properties: { ...properties, message: exception.message } });
  },
});

const { EvidenceExtractor } = await import("../dist/src/processors/evidence/evidenceExtractor.js");
const previous = JSON.parse(await readFile(inputFile, "utf8"));
const sourceText = await readFile(previous.input, "utf8");
const sourceHash = createHash("sha256").update(sourceText).digest("hex");
assert.equal(previous.inputHash, sourceHash, "The source changed since the saved extraction");
const pages = sourceText.split("<!-- PageBreak -->");
const source = new Document({ pageContent: sourceText, metadata: {
  sourceId: previous.sourceId, title: basename(previous.input), pages: pages.map((_, index) => index + 1),
} });
const documents = previous.documents.map(value => new Document(value));
const started = Date.now();
const result = await new EvidenceExtractor("local-canonicalization", previous.sourceId)
  .canonicalizeDocuments(documents, source);
const usage = events.filter(event => event.name === "llm.call.token_usage")
  .reduce((totals, event) => {
    totals.calls++;
    for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens", "cacheWriteTokens"]) {
      totals[key] += event.measurements?.[key] ?? 0;
    }
    return totals;
  }, { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0,
    cacheWriteTokens: 0 });
const output = { inputFile, sourceHash, originalCount: documents.length,
  finalCount: result.documents.length, elapsedSeconds: (Date.now() - started) / 1000,
  failedBatches: result.failedBatches, usage,
  pairs: result.pairs, decisions: result.decisions, reviewDecisions: result.reviewDecisions,
  applied: result.applied, documents: result.documents };
await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
await writeFile(outputFile, JSON.stringify(output, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ output: outputFile, originalCount: output.originalCount,
  finalCount: output.finalCount, pairCount: output.pairs.length,
  proposedMerges: output.decisions.length, appliedMerges: output.applied.length,
  failedBatches: output.failedBatches, elapsedSeconds: output.elapsedSeconds, usage }, null, 2));
if (output.failedBatches > 0) process.exitCode = 1;
