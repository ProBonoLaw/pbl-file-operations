import assert from "node:assert/strict";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";
import {DefaultAzureCredential} from "@azure/identity";
import {SearchClient} from "@azure/search-documents";
import {SourcePartitionSearch} from "../dist/src/processors/evidence/sourcePartitionSearch.js";

export async function runSourcePartitionSearch(values, dependencies = {}) {
  for (const key of ["endpoint", "index", "account-id", "source-id", "output"]) assert.ok(values[key], `--${key} is required`);
  const endpoint = new URL(values.endpoint);
  assert.ok(endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
  const queries = values.queries ? JSON.parse(await readFile(resolve(values.queries), "utf8")) : {
    accountId: values["account-id"], sourceId: values["source-id"], queries: []};
  assert.equal(queries.accountId, values["account-id"]); assert.equal(queries.sourceId, values["source-id"]);
  assert.ok(Array.isArray(queries.queries));
  const output = resolve(values.output);
  await mkdir(dirname(output), {recursive: true, mode: 0o700});
  await mkdir(output, {mode: 0o700});
  const persist = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + "\n", {mode: 0o600});
  const lookup = dependencies.lookup ?? new SourcePartitionSearch(
    new SearchClient(endpoint.origin, values.index, new DefaultAzureCredential()), values["account-id"], values["source-id"], {
      maxRecords: Number(values["max-records"] ?? 2000), maxQueries: Number(values["max-queries"] ?? 100),
      topK: Number(values["top-k"] ?? 8), semanticConfiguration: values["semantic-configuration"]});
  const started = performance.now();
  try {
    const snapshot = await lookup.snapshot();
    await persist("snapshot.json", snapshot);
    const results = await lookup.lookup(snapshot, queries.queries);
    await persist("results.json", results);
    const origins = {};
    for (const row of snapshot.records) {
      const origin = row.contentOrigin ?? "unknown";
      origins[origin] = (origins[origin] ?? 0) + 1;
    }
    const report = {accountId: values["account-id"], sourceId: values["source-id"], filter: lookup.filter,
      records: snapshot.records.length, origins, queryCount: queries.queries.length,
      snapshotFingerprint: snapshot.fingerprint, searchStats: lookup.stats, elapsedMs: performance.now() - started,
      indexChanged: false, chatModelCalls: 0, newEmbeddingCalls: 0, reconstructedSource: false};
    await persist("report.json", report);
    return report;
  } catch (error) {
    await persist("failure.json", {error: error instanceof Error ? error.message : String(error), searchStats: lookup.stats, indexChanged: false});
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = ["endpoint", "index", "account-id", "source-id", "output", "queries", "top-k", "max-records", "max-queries", "semantic-configuration"];
  const {values} = parseArgs({options: Object.fromEntries(names.map(name => [name, {type: "string"}]))});
  try { console.log(JSON.stringify(await runSourcePartitionSearch(values), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
