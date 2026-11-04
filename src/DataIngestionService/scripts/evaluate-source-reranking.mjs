import assert from "node:assert/strict";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";
import {get_encoding} from "tiktoken";
import {EvidenceSource} from "../dist/src/processors/evidence/evidenceSource.js";
import {sourcePartitionPassages} from "../dist/src/processors/evidence/evidenceSourceLookup.js";
import {parseExtractionPackage, literalDocument} from "../dist/src/processors/extractionPackage.js";

const normalize = text => text.replace(/\s+/gu, " ").trim();
const rawMatch = (hit, span) => hit.contentOrigin === "extracted" && hit.pages?.includes(span.pageNumber)
  && normalize(hit.content).includes(normalize(span.sourceQuote));
const contextMatch = (context, span) => context.passages.some(passage => passage.pageNumber === span.pageNumber
  && span.sourceOffset >= passage.sourceOffset
  && passage.sourceQuote.slice(span.sourceOffset - passage.sourceOffset,
    span.sourceOffset - passage.sourceOffset + span.sourceQuote.length) === span.sourceQuote);

/** Offline calibration only. Missing scores remain eligible; they are never
 * replaced with zero or with the unrelated hybrid/BM25 search score. */
export function filterRerankedHits(hits, threshold) {
  assert.ok(threshold === null || typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0 && threshold <= 4,
    "Use a reranker threshold from 0 through 4, or null for the baseline");
  return hits.filter(hit => threshold === null || hit.rerankerScore === undefined || hit.rerankerScore >= threshold);
}

export function evaluateRerankerThresholds(suite, source, queries, results, thresholds = [0, 1, 1.5, 2, 2.25, 2.5, 2.75, 3, 3.5, 4]) {
  assert.equal(suite.accountId, source.document.metadata.accountId);
  assert.equal(suite.sourceId, source.document.metadata.sourceId);
  assert.equal(suite.sourceContentHash, source.contentHash);
  assert.ok(Array.isArray(suite.cases) && suite.cases.length > 0 && suite.cases.length <= 100);
  assert.equal(new Set(suite.cases.map(entry => entry.id)).size, suite.cases.length);
  assert.ok(thresholds.length > 0 && thresholds.length <= 50 && new Set(thresholds).size === thresholds.length);
  thresholds.forEach(threshold => {assert.notEqual(threshold, null); filterRerankedHits([], threshold);});
  const inputs = suite.cases.flatMap(entry => {
    assert.equal(typeof entry.duplicate, "boolean"); assert.equal(entry.documents.length, 2);
    return entry.documents.map((document, side) => ({id: entry.id + (side === 0 ? ":left" : ":right"), document}));
  });
  const expectedIds = inputs.map(input => input.id).sort();
  assert.deepEqual(queries.map(query => query.id).sort(), expectedIds, "Query IDs must match every labelled assertion exactly once");
  assert.deepEqual(results.map(result => result.id).sort(), expectedIds, "Result IDs must match every labelled assertion exactly once");
  for (const {id, document} of inputs) {
    const metadata = document.metadata, query = queries.find(query => query.id === id);
    assert.equal(query.text, metadata.what.trim(), "Scores must belong to this assertion's query");
    assert.ok(Array.isArray(query.vector) && query.vector.length > 0 && query.vector.every(Number.isFinite) && query.vector.some(n => n !== 0),
      "Calibration requires actual hybrid query vectors");
    assert.equal(metadata.accountId, suite.accountId); assert.equal(metadata.sourceId, suite.sourceId);
    assert.equal(metadata.sourceContentHash, source.contentHash);
    assert.ok(metadata.sourceSpans?.length);
    for (const span of metadata.sourceSpans) {
      assert.ok(Number.isSafeInteger(span.sourceOffset) && span.sourceOffset >= 0 && span.sourceQuote.length > 0);
      assert.equal(source.pages.find(page => page.pageNumber === span.pageNumber)?.text
        .slice(span.sourceOffset, span.sourceOffset + span.sourceQuote.length), span.sourceQuote, "Invalid literal source citation");
    }
    const hits = results.find(result => result.id === id).hits;
    assert.ok(Array.isArray(hits) && hits.length <= 50);
    assert.equal(new Set(hits.map(hit => hit.id)).size, hits.length);
    for (const hit of hits) {
      assert.equal(hit.sourceId, suite.sourceId); assert.deepEqual(hit.tags, []);
      const indexed = JSON.parse(hit.metadata);
      if (indexed.accountId !== undefined) assert.equal(indexed.accountId, suite.accountId);
      if (indexed.sourceContentHash !== undefined) assert.equal(indexed.sourceContentHash, source.contentHash);
      for (const score of [hit.searchScore, hit.rerankerScore])
        assert.ok(score === undefined || typeof score === "number" && Number.isFinite(score), "Invalid saved score");
    }
  }
  const encoder = get_encoding("o200k_base");
  const details = inputs.map(({id, document}) => ({id, primaryPage: document.metadata.sourceSpans[0].pageNumber,
    hits: results.find(result => result.id === id).hits.map((hit, index) => ({id: hit.id, rank: index + 1,
      searchScore: hit.searchScore, rerankerScore: hit.rerankerScore, contentOrigin: hit.contentOrigin,
      primaryQuoteMatch: rawMatch(hit, document.metadata.sourceSpans[0])})), variants: []}));
  const rows = [];
  let baselineRaw, baselinePrimary, baselineSupporting;
  try {
    for (const threshold of [null, ...thresholds]) {
      const raw = new Set(), primary = new Set(), supporting = new Set(), emptyContextQueryIds = [], contexts = [];
      let keptHits = 0, passageCount = 0, unverifiedCount = 0;
      for (const [index, {id, document}] of inputs.entries()) {
        const hits = filterRerankedHits(results.find(result => result.id === id).hits, threshold);
        const spans = document.metadata.sourceSpans;
        const context = sourcePartitionPassages(source, hits, document.metadata.what);
        keptHits += hits.length; passageCount += context.passages.length; unverifiedCount += context.unverifiedContext?.length ?? 0;
        if (hits.some(hit => rawMatch(hit, spans[0]))) raw.add(id);
        if (contextMatch(context, spans[0])) primary.add(id);
        for (const [spanIndex, span] of spans.entries()) if (spanIndex > 0 && contextMatch(context, span)) supporting.add(id + ":" + spanIndex);
        if (!context.passages.length && !context.unverifiedContext?.length) emptyContextQueryIds.push(id);
        contexts.push({assertion: document.metadata.what, ...context});
        details[index].variants.push({threshold, keptHitIds: hits.map(hit => hit.id), context});
      }
      baselineRaw ??= raw; baselinePrimary ??= primary; baselineSupporting ??= supporting;
      const serialized = JSON.stringify(contexts), contextTokens = encoder.encode(serialized, [], []).length;
      const lost = (baseline, current) => [...baseline].filter(id => !current.has(id));
      rows.push({threshold, keptHits, passageCount, unverifiedCount, rawPrimaryQuoteQueries: raw.size,
        suppliedPrimaryQuoteQueries: primary.size, suppliedSupportingQuotes: supporting.size,
        lostRawPrimaryQueries: lost(baselineRaw, raw), lostSuppliedPrimaryQueries: lost(baselinePrimary, primary),
        lostSuppliedSupportingQuotes: lost(baselineSupporting, supporting), emptyContextQueryIds,
        serializedContextCharacters: serialized.length, contextTokens,
        contextTokenReductionPercent: rows.length ? 100 * (1 - contextTokens / rows[0].contextTokens) : 0});
    }
  } finally { encoder.free(); }
  const allHits = results.flatMap(result => result.hits), scored = allHits.filter(hit => hit.rerankerScore !== undefined);
  return {summary: {sourceId: suite.sourceId, sourceContentHash: source.contentHash, labelledPairs: suite.cases.length,
    labelledDuplicates: suite.cases.filter(entry => entry.duplicate).length, queries: inputs.length,
    returnedHits: allHits.length, scoredHits: scored.length, missingRerankerScores: allHits.length - scored.length,
    protocol: "Offline cutoff sweep over the same captured hybrid results. Quote coverage is a retrieval proxy, not measured merge accuracy. No production threshold is enabled.",
    tokenMeasurement: "o200k_base tokens for serialized retrievedContext, including assertions; excludes the rest of the prompt and model output. Not billed usage.",
    missingScorePolicy: "retain", rows, chatModelCalls: 0, newEmbeddingCalls: 0}, details};
}

export async function runRerankingEvaluation(values) {
  for (const key of ["suite", "source", "queries", "results", "snapshot", "output"]) assert.ok(values[key], `--${key} is required`);
  const read = async key => JSON.parse(await readFile(resolve(values[key]), "utf8"));
  const [suite, pkg, queries, results, snapshot] = await Promise.all(["suite", "source", "queries", "results", "snapshot"].map(read));
  assert.equal(pkg.accountId, suite.accountId); assert.equal(pkg.sourceId, suite.sourceId);
  assert.equal(queries.accountId, suite.accountId); assert.equal(queries.sourceId, suite.sourceId);
  const document = literalDocument(parseExtractionPackage(pkg));
  Object.assign(document.metadata, {accountId: suite.accountId, sourceId: suite.sourceId});
  // Scores are query metadata. All content must still be the captured snapshot's original record.
  const records = new Map(snapshot.records.map(row => [row.id, row]));
  assert.equal(records.size, snapshot.records.length);
  for (const result of results) for (const {searchScore, rerankerScore, ...hit} of result.hits) {
    void searchScore; void rerankerScore;
    assert.deepEqual(hit, records.get(hit.id), "Scored hit differs from the source snapshot");
  }
  const evaluation = evaluateRerankerThresholds(suite, new EvidenceSource(document), queries.queries, results,
    values.thresholds?.split(",").map(Number));
  evaluation.summary.snapshotFingerprint = snapshot.fingerprint;
  const output = resolve(values.output);
  await mkdir(dirname(output), {recursive: true, mode: 0o700}); await mkdir(output, {mode: 0o700});
  await writeFile(resolve(output, "report.json"), JSON.stringify(evaluation.summary, null, 2) + "\n", {mode: 0o600});
  await writeFile(resolve(output, "details.private.json"), JSON.stringify(evaluation.details, null, 2) + "\n", {mode: 0o600});
  return evaluation.summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = ["suite", "source", "queries", "results", "snapshot", "output", "thresholds"];
  const {values} = parseArgs({options: Object.fromEntries(names.map(name => [name, {type: "string"}]))});
  try { console.log(JSON.stringify(await runRerankingEvaluation(values), null, 2)); }
  catch (error) {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;}
}
