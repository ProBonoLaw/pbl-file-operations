import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Document } from "@langchain/core/documents";
import { EvidenceSource } from "../dist/src/processors/evidence/evidenceSource.js";
import { findCanonicalizationPairs, canonicalizationReviewBatches } from "../dist/src/processors/evidence/evidenceCanonicalization.js";
import { measureCanonicalizationPlan } from "../dist/src/processors/evidence/evidenceCanonicalizationPrompt.js";

export async function benchmarkDedupPlanning(values) {
  for (const name of ["input", "source", "output"]) assert.ok(values[name], `--${name} is required`);
  const saved = JSON.parse(await readFile(resolve(values.input), "utf8"));
  const documents = (Array.isArray(saved) ? saved : saved.documents).map(value => new Document(value));
  assert.ok(documents.length, "Input must contain evidence documents");
  const sourceId = documents[0].metadata.sourceId, accountId = documents[0].metadata.accountId;
  const content = await readFile(resolve(values.source), "utf8");
  const source = new EvidenceSource(new Document({pageContent: content, metadata: {sourceId,
    pages: content.split("<!-- PageBreak -->").map((_, index) => index + 1)}}));
  for (const document of documents) {
    assert.equal(document.metadata.sourceContentHash, source.contentHash, "Source hash mismatch");
    assert.equal(document.metadata.sourceId, sourceId, "Source ID mismatch");
    assert.equal(document.metadata.accountId, accountId, "Account mismatch");
    for (const span of document.metadata.sourceSpans) assert.equal(source.pages.find(page => page.pageNumber === span.pageNumber)
      ?.text.slice(span.sourceOffset, span.sourceOffset + span.sourceQuote.length), span.sourceQuote, "Unverified citation");
  }
  const started = performance.now();
  const pairs = findCanonicalizationPairs(documents, {source});
  const candidatePlanningMs = performance.now() - started;
  assert.deepEqual(canonicalizationReviewBatches(pairs, true).flat().map(pair => pair.id).sort(), pairs.map(pair => pair.id).sort());
  const measurements = measureCanonicalizationPlan(pairs, documents, source, {accountId, sourceId, contentHash: source.contentHash});
  const report = {sourceHash: source.contentHash, records: documents.length, ...measurements, candidatePlanningMs,
    payloadTokenReductionVsUncompacted: measurements.sequentialPayloadTokens - measurements.groupedCompactPayloadTokens,
    payloadTokenReductionVsExistingCompaction: measurements.sequentialCompactPayloadTokens - measurements.groupedCompactPayloadTokens,
    elapsedMs: performance.now() - started, comparisonSetUnchanged: true, modelCalls: 0, newEmbeddingCalls: 0,
    limitation: "Offline lexical candidate planning and payload estimates only. No Search retrieval, live model runtime, recall, output-token or dollar savings measured."};
  const output = resolve(values.output);
  await mkdir(dirname(output), {recursive: true, mode: 0o700});
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", {flag: "wx", mode: 0o600});
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options: {input: {type: "string"}, source: {type: "string"}, output: {type: "string"}}});
  console.log(JSON.stringify(await benchmarkDedupPlanning(values), null, 2));
}
