import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";
import {Document} from "@langchain/core/documents";
import {EvidenceSource} from "../dist/src/processors/evidence/evidenceSource.js";
import {parseExtractionPackage, literalDocument} from "../dist/src/processors/extractionPackage.js";
import {findCanonicalizationPairs} from "../dist/src/processors/evidence/evidenceCanonicalization.js";
import {indexedReviewCheckpoints} from "./review-indexed-evidence.mjs";

export function gradeReconciliationCases(cases, result) {
  const applied = new Set(result.applied.map(merge => merge.pairId));
  const reviewed = new Set(result.reviewDecisions.map(decision => decision.pairId));
  const rows = cases.map((entry, index) => ({id: entry.id, expectedDuplicate: entry.duplicate,
    reviewed: reviewed.has(`${2 * index}:${2 * index + 1}`), merged: applied.has(`${2 * index}:${2 * index + 1}`)}));
  return {cases: rows.length, expectedDuplicates: rows.filter(row => row.expectedDuplicate).length,
    duplicatesRemoved: rows.filter(row => row.expectedDuplicate && row.merged).length,
    remainingDuplicates: rows.filter(row => row.expectedDuplicate && !row.merged).length,
    falseMerges: rows.filter(row => !row.expectedDuplicate && row.merged).length,
    unreviewed: rows.filter(row => !row.reviewed).length, rows};
}

export function validateReconciliationSuite(suite, source) {
  assert.ok(Array.isArray(suite.cases) && suite.cases.length > 0 && suite.cases.length <= 16, "Use 1–16 labelled pairs");
  assert.equal(suite.sourceContentHash, source.contentHash);
  assert.equal(suite.sourceId, source.document.metadata.sourceId);
  assert.equal(new Set(suite.cases.map(entry => entry.id)).size, suite.cases.length);
  const pages = new Set();
  for (const entry of suite.cases) {
    assert.equal(typeof entry.duplicate, "boolean");
    assert.ok(typeof entry.rationale === "string" && entry.rationale.trim());
    assert.equal(entry.documents?.length, 2);
    const page = entry.documents[0].metadata.sourceSpans[0].pageNumber;
    assert.ok(!pages.has(page), "Use disjoint primary pages to isolate labelled comparisons"); pages.add(page);
    for (const document of entry.documents) {
      const metadata = document.metadata;
      assert.equal(metadata.accountId, suite.accountId); assert.equal(metadata.sourceId, suite.sourceId);
      assert.equal(metadata.sourceContentHash, source.contentHash);
      assert.equal(metadata.sourceSpans[0].pageNumber, page);
      for (const span of metadata.sourceSpans) assert.ok(source.matchOnPage(span.pageNumber, span.sourceQuote)
        .some(match => match.sourceOffset === span.sourceOffset && match.sourceQuote === span.sourceQuote), "Invalid literal citation");
    }
  }
}

export async function runSourceReconciliationBenchmark(values) {
  for (const key of ["suite", "source", "settings", "endpoint", "index", "output"]) assert.ok(values[key], `--${key} is required`);
  const suite = JSON.parse(await readFile(resolve(values.suite), "utf8"));
  const pkg = parseExtractionPackage(JSON.parse(await readFile(resolve(values.source), "utf8")));
  assert.equal(pkg.accountId, suite.accountId); assert.equal(pkg.sourceId, suite.sourceId);
  const document = literalDocument(pkg);
  Object.assign(document.metadata, {accountId: suite.accountId, sourceId: suite.sourceId});
  const source = new EvidenceSource(document);
  validateReconciliationSuite(suite, source);
  const documents = suite.cases.flatMap(entry => entry.documents).map(value => new Document(value));
  const expectedPairs = suite.cases.map((_, index) => `${2 * index}:${2 * index + 1}`).sort();
  assert.deepEqual(findCanonicalizationPairs(documents, {source}).map(pair => pair.id).sort(), expectedPairs,
    "Every labelled pair must reach the same existing candidate and metadata guards in both arms");
  const endpoint = new URL(values.endpoint);
  assert.ok(endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
  const output = resolve(values.output);
  await mkdir(dirname(output), {recursive: true, mode: 0o700}); await mkdir(output, {mode: 0o700});
  const persist = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + "\n", {mode: 0o600});
  // An explicit test settings file is authoritative, including credentials and
  // its existing spending controls; do not mix it with ambient provider settings.
  for (const name of Object.keys(process.env)) if (/^(AZURE_OPENAI_|EVIDENCE_|TEXT_EMBEDDING_)/.test(name)) delete process.env[name];
  process.env.APPSETTINGS_FILE = resolve(values.settings);
  const {loadAppSettings} = await import("../dist/src/settings.js"); await loadAppSettings();
  process.env.EVIDENCE_SOURCE_LOOKUP_MODE = "local"; // Explicit factories below select each arm.
  process.env.EVIDENCE_PROMPT_COMPACTION = "on"; process.env.EVIDENCE_PROMPT_FORMAT = "json";
  const {default: appInsights} = await import("applicationinsights");
  appInsights.setup("InstrumentationKey=00000000-0000-0000-0000-000000000000");
  appInsights.defaultClient.config.disableAppInsights = true;
  const events = [];
  Object.assign(appInsights.defaultClient, {trackException() {}, trackEvent(event) {events.push(event);}});
  const {EvidenceExtractor} = await import("../dist/src/processors/evidence/evidenceExtractor.js");
  const {withRequestContext} = await import("../dist/src/requestContext.js");
  const {SourcePartitionSearch} = await import("../dist/src/processors/evidence/sourcePartitionSearch.js");
  const {SearchSourceContext} = await import("../dist/src/processors/evidence/evidenceSourceLookup.js");
  const {EvidenceEmbeddingCache} = await import("../dist/src/processors/evidence/evidenceEmbeddingCache.js");
  const {AzureOpenAIEmbeddingsWithTelemetry} = await import("../dist/src/processors/azureOpenAIEmbeddingsWithTelemetry.js");
  const {DefaultAzureCredential} = await import("@azure/identity");
  const {SearchClient} = await import("@azure/search-documents");
  const usage = start => events.slice(start).reduce((total, event) => {
    if (event.name === "llm.call.token_usage") {
      total.chatCalls++;
      for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens"]) total[key] += event.measurements?.[key] ?? 0;
    }
    if (event.name === "aoai.embeddings.tokens") {total.embeddingCalls++; total.embeddingTokens += event.measurements?.inputTokens ?? 0;
      if (event.properties?.outcome === "failure") total.embeddingFailedCalls++;}
    return total;
  }, {chatCalls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, embeddingCalls: 0, embeddingFailedCalls: 0, embeddingTokens: 0});
  const report = {accountId: suite.accountId, sourceId: suite.sourceId, sourceContentHash: source.contentHash,
    filter: `sourceId eq '${suite.sourceId.replace(/'/g, "''")}' and not tags/any()`,
    suiteHash: createHash("sha256").update(JSON.stringify(suite)).digest("hex"),
    protocol: "Same labelled pairs, reviewer, compact prompt layout and merge guards; prefetch grounding in both arms. Local runs first. Hand-selected within-document cases; not extraction recall or an end-to-end benchmark.",
    indexChanged: false, arms: {}};
  // Account/source/session identity lets the configured cost guard apply to all
  // model and embedding calls, including retries and both comparison arms.
  const requestContext = {accountId: suite.accountId, sourceId: suite.sourceId,
    jobId: "source-reconciliation:" + createHash("sha256").update(output).digest("hex")};
  try {
    await withRequestContext(requestContext, async () => { for (const arm of ["local", "hybrid"]) {
      const checkpoints = indexedReviewCheckpoints(resolve(output, arm + "-checkpoints"));
      let search, context;
      const started = performance.now(), firstEvent = events.length;
      if (arm === "hybrid") {
        search = new SourcePartitionSearch(new SearchClient(endpoint.origin, values.index, new DefaultAzureCredential()),
          suite.accountId, suite.sourceId, {semanticConfiguration: "Primary"});
        const snapshot = await search.snapshot();
        const model = {endpoint: process.env.AZURE_OPENAI_CUSTOM_ENDPOINT,
          deployment: process.env.TEXT_EMBEDDING_LARGE_DEPLOYMENT_NAME || "text-embedding-3-large", model: "text-embedding-3-large",
          dimensions: 3072, apiVersion: "2024-12-01-preview", inputVersion: "strip-newlines-v1"};
        const provider = new AzureOpenAIEmbeddingsWithTelemetry(appInsights.defaultClient, suite.accountId, suite.sourceId, {
          azureOpenAIApiDeploymentName: model.deployment, azureOpenAIBasePath: model.endpoint,
          azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY, azureOpenAIApiInstanceName: new URL(model.endpoint).hostname.split(".")[0],
          model: model.model, dimensions: model.dimensions, azureOpenAIApiVersion: model.apiVersion, maxRetries: 0});
        const embeddings = new EvidenceEmbeddingCache(suite.accountId, suite.sourceId, model, provider, checkpoints);
        context = new SearchSourceContext(source, search, snapshot, suite.accountId, embeddings, model, checkpoints);
        await persist("source-snapshot.json", snapshot);
      } else context = {fingerprint: "local-context:" + source.contentHash,
        search: async request => ({passages: source.context.lookup(request.pageNumber, request.query, request.purpose)}), verify: async () => {}};
      const extractor = () => new EvidenceExtractor(suite.accountId, suite.sourceId, undefined, checkpoints, undefined, "thorough", undefined, async () => context);
      const reviewer = extractor();
      const result = await reviewer.canonicalizeDocuments(documents, document, {retrieval: {}, sourceContext: "prefetch"});
      await context.verify();
      const metrics = {quality: gradeReconciliationCases(suite.cases, result), usage: usage(firstEvent), elapsedMs: performance.now() - started,
        model: reviewer.reconciliationModel.deployment, failedBatches: result.failedBatches, failedPairIds: result.failedPairIds,
        searchStats: search ? {...search.stats} : undefined, contextStats: context.stats ? {...context.stats} : undefined};
      await persist(arm + "-result.json", result);
      report.arms[arm] = metrics;
      await persist("report.json", report);
      assert.equal(result.failedPairIds.length, 0, "Incomplete reviews must not be reported as completed quality comparisons");
      const replayStart = events.length, replayTime = performance.now();
      const replay = await extractor().canonicalizeDocuments(documents, document, {retrieval: {}, sourceContext: "prefetch"});
      assert.deepEqual(replay.applied, result.applied);
      metrics.replay = {elapsedMs: performance.now() - replayTime, usage: usage(replayStart)};
      assert.equal(metrics.replay.usage.chatCalls, 0, "Valid pair decisions should survive reviewer restart");
      assert.equal(metrics.replay.usage.embeddingCalls, 0);
      report.arms[arm] = metrics;
      await persist("report.json", report);
    } });
    return report;
  } catch (error) {await persist("failure.json", {error: error.message, usage: usage(0), report});
    await persist("events.json", events); throw error;}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options: Object.fromEntries(["suite", "source", "settings", "endpoint", "index", "output"].map(name => [name, {type: "string"}]))});
  try {console.log(JSON.stringify(await runSourceReconciliationBenchmark(values), null, 2));}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
