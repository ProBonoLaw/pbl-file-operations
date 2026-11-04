import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { DefaultAzureCredential } from "@azure/identity";
import { SearchClient, SearchIndexClient } from "@azure/search-documents";
import { AzureOpenAIEmbeddings } from "@langchain/openai";
import { prepareEvidenceContentUpdate, applyEvidenceContentUpdate } from "../dist/src/processors/evidence/evidenceBackfill.js";
import { ensureEvidenceSearchFields } from "../dist/src/processors/evidence/evidenceSearchSchema.js";
import { evidenceRetrievalFields } from "../dist/src/processors/evidence/evidenceSearchProjection.js";

const { values } = parseArgs({ options: {
  settings: { type: "string" },
  endpoint: { type: "string" },
  index: { type: "string" },
  "source-id": { type: "string" },
  output: { type: "string", default: "../../.local/evidence-date-backfill-report.json" },
  limit: { type: "string" },
  apply: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} });

if (values.help) {
  console.log(`Usage: bun run backfill:evidence-dates --settings FILE --endpoint URL --index NAME --source-id ID [--apply] [--limit N] [--output FILE]

Defaults to a read-only preview; no embeddings or index updates are requested.
--apply adds evidence retrieval/asOf fields and reclassifies undated events as cited facts.
Vectors are regenerated only when the formatted evidence content changes.
Run with ingestion/removal paused for the selected source. Rerunning skips completed records.
--limit bounds the number of planned updates, allowing migration in batches.
Use the same embedding deployment and resource settings as the index's ingestion service.`);
} else {
  await run();
}

async function run() {
  for (const name of ["settings", "endpoint", "index", "source-id"]) assert.ok(values[name], `--${name} is required`);
  const endpoint = new URL(values.endpoint);
  assert.equal(endpoint.protocol, "https:", "Search endpoint must use HTTPS");
  assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, "Use a Search resource URL without credentials or query parameters");
  const limit = values.limit ? Number(values.limit) : Infinity;
  assert.ok(limit === Infinity || Number.isSafeInteger(limit) && limit > 0, "--limit must be a positive integer");
  const settings = JSON.parse(await readFile(resolve(values.settings), "utf8"));
  const report = { mode: values.apply ? "apply" : "preview", endpoint: endpoint.origin,
    index: values.index, sourceId: values["source-id"], scanned: 0, planned: 0,
    reclassifiedUndatedEvents: 0, embeddingRequired: 0, embedded: 0, updated: 0, current: 0, unsupported: 0,
    unsupportedIds: [], asOfSchemaPresent: false, errors: [] };
  const credential = new DefaultAzureCredential();
  const indexClient = new SearchIndexClient(endpoint.origin, credential);
  const client = new SearchClient(endpoint.origin, values.index, credential);
  let embeddings;
  let recordId;
  try {
    const index = values.apply ? await ensureEvidenceSearchFields(indexClient, values.index)
      : await indexClient.getIndex(values.index);
    report.asOfSchemaPresent = index.fields.some(field => field.name === "asOf");
    const retrievalFields = evidenceRetrievalFields().map(field => field.name);
    report.retrievalSchemaPresent = retrievalFields.every(name => index.fields.some(field => field.name === name));
    const selectedFields = ["id", "content", "metadata", "tags", "whenStarted", "whenEnded", ...(report.asOfSchemaPresent ? ["asOf"] : []),
      ...retrievalFields.filter(name => index.fields.some(field => field.name === name))];
    const dimensions = index.fields.find(field => field.name === "content_vector")?.vectorSearchDimensions;
    assert.ok(Number.isInteger(dimensions) && dimensions > 0, "Index must define content_vector dimensions");
    const filter = `sourceId eq '${values["source-id"].replace(/'/g, "''")}' and tags/any(t: t eq 'event' or t eq 'fact' or t eq 'claim')`;
    // Writes can reorder Search results even when records remain in the filter.
    // Finish paging before merging anything so every candidate is visited once.
    const pendingUpdates = [];
    const results = await client.search("*", { filter,
      select: selectedFields });
    for await (const { document } of results.results) {
      recordId = document.id;
      report.scanned++;
      const update = prepareEvidenceContentUpdate(document);
      if (update.status === "current") report.current++;
      else if (update.status === "unsupported") {
        report.unsupported++;
        report.unsupportedIds.push(document.id);
      }
      else {
        report.planned++;
        if (update.reclassifiedUndatedEvent) report.reclassifiedUndatedEvents++;
        if (update.needsEmbedding) report.embeddingRequired++;
        if (values.apply) pendingUpdates.push(update);
        if (report.planned >= limit) break;
      }
      if (report.scanned % 25 === 0) console.log(JSON.stringify({ scanned: report.scanned, planned: report.planned, updated: report.updated }));
    }
    for (const update of pendingUpdates) {
      recordId = update.document.id;
      await applyEvidenceContentUpdate(update, {
        dimensions,
        async embed(content) {
          if (!embeddings) {
            assert.ok(settings.AZURE_OPENAI_CUSTOM_ENDPOINT && settings.AZURE_OPENAI_API_KEY,
              "Settings require the ingestion embedding endpoint and key");
            const deployment = settings.TEXT_EMBEDDING_LARGE_DEPLOYMENT_NAME || "text-embedding-3-large";
            embeddings = new AzureOpenAIEmbeddings({
              azureOpenAIApiCompletionsDeploymentName: deployment,
              azureOpenAIApiDeploymentName: deployment,
              azureOpenAIBasePath: settings.AZURE_OPENAI_CUSTOM_ENDPOINT,
              azureOpenAIApiKey: settings.AZURE_OPENAI_API_KEY,
              azureOpenAIApiInstanceName: new URL(settings.AZURE_OPENAI_CUSTOM_ENDPOINT).hostname.split(".")[0],
              azureOpenAIApiVersion: "2024-12-01-preview", model: "text-embedding-3-large", dimensions,
              maxRetries: 3, timeout: 180_000,
            });
          }
          const vector = await embeddings.embedQuery(content);
          report.embedded++;
          return vector;
        },
        read: id => client.getDocument(id, { selectedFields }),
        async merge(document) {
          const result = await client.mergeDocuments([document]);
          if (result.results.length !== 1 || result.results[0].key !== document.id || !result.results[0].succeeded) {
            throw new Error(`Search merge failed for ${document.id}: ${result.results[0]?.errorMessage ?? "missing result"}`);
          }
        },
      });
      report.updated++;
      if (report.updated % 25 === 0) console.log(JSON.stringify({ scanned: report.scanned, planned: report.planned, updated: report.updated }));
    }
  } catch (error) {
    report.errors.push({ id: recordId ?? null, message: error.message });
    process.exitCode = 1;
  } finally {
    await mkdir(dirname(resolve(values.output)), { recursive: true });
    await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  }
}
