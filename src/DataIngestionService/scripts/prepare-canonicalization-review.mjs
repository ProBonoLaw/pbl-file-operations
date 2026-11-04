import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PAGE_BREAK = "<!-- PageBreak -->";
const columns = [
  "reviewKey", "status", "runsAndPairIds", "kind", "page", "offset", "similarity",
  "leftWhat", "rightWhat", "leftType", "rightType", "leftPeople", "rightPeople",
  "leftClaimant", "rightClaimant", "leftPolarity", "rightPolarity", "leftDates",
  "rightDates", "leftFacets", "rightFacets", "leftQuote", "rightQuote",
  "sourceContext", "modelReason", "fieldDifferences", "humanLabel", "reviewNotes",
];

function argumentsForReview() {
  const runs = [];
  let outputDirectory;
  for (let index = 2; index < process.argv.length;) {
    const option = process.argv[index++];
    if (option === "--run") {
      const [name, before, after] = process.argv.slice(index, index + 3);
      if (!name || !before || !after || !/^[a-z0-9_-]+$/i.test(name)) {
        throw new Error("--run requires a name, a pre-canonicalization result, and a canonicalization result");
      }
      runs.push({ name, before: resolve(before), after: resolve(after) });
      index += 3;
    } else if (option === "--output-dir") {
      outputDirectory = process.argv[index++];
    } else {
      throw new Error(`Unknown review option: ${option}`);
    }
  }
  if (!runs.length || !outputDirectory || new Set(runs.map(run => run.name)).size !== runs.length) {
    throw new Error("Supply distinct --run NAME BEFORE AFTER entries and --output-dir DIRECTORY");
  }
  return { runs, outputDirectory: resolve(outputDirectory) };
}

const hash = value => createHash("sha256").update(value).digest("hex");
const normal = value => String(value ?? "").normalize("NFKC").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const stable = value => JSON.stringify(value ?? null);
const list = value => Array.isArray(value) ? [...new Set(value.map(normal))].sort() : [];
const tags = metadata => Array.isArray(metadata.tags) ? metadata.tags : [];
const facets = metadata => tags(metadata).filter(value => value.startsWith("facet:")).map(normal).sort();
const kind = metadata => metadata.claimType ? "claim" : metadata.factType ? "fact"
  : tags(metadata).includes("event") ? "event" : "unknown";
const type = metadata => metadata.claimType ?? metadata.factType
  ?? tags(metadata).find(value => value.startsWith("eventType:")) ?? "";
const people = metadata => ({ who: list(metadata.who), subject: list(metadata.subject),
  reportedBy: list(metadata.reportedBy) });
const dates = metadata => ({ whenStarted: metadata.whenStarted ?? null,
  whenEnded: metadata.whenEnded ?? null, asOf: metadata.asOf ?? null });
const primary = metadata => {
  const span = metadata.sourceSpans?.[0];
  assert.ok(span && Number.isInteger(span.pageNumber) && Number.isInteger(span.sourceOffset));
  return span;
};

function recordIdentity(metadata) {
  const span = primary(metadata);
  return stable([normal(metadata.what), kind(metadata), normal(type(metadata)),
    normal(metadata.claimant), normal(metadata.claimPolarity), people(metadata), dates(metadata),
    facets(metadata), normal(metadata.where), normal(metadata.why),
    span.pageNumber, span.sourceOffset, normal(span.sourceQuote)]);
}

function sourceContext(pages, metadata) {
  const span = primary(metadata);
  const page = pages[span.pageNumber - 1];
  assert.ok(page, "Citation page must exist in the frozen source");
  assert.equal(page.slice(span.sourceOffset, span.sourceOffset + span.sourceQuote.length), span.sourceQuote,
    "Citation must resolve before it enters the review queue");
  return page.slice(Math.max(0, span.sourceOffset - 160),
    Math.min(page.length, span.sourceOffset + span.sourceQuote.length + 160));
}

function fieldDifferences(left, right) {
  const reasons = [];
  if (kind(left) !== kind(right)) reasons.push("evidence_kind");
  if (normal(type(left)) !== normal(type(right))) reasons.push("classification");
  if (normal(left.claimant) !== normal(right.claimant)) {
    reasons.push([left.claimant, right.claimant].some(value => !value || /^unknown\b/i.test(value))
      ? "missing_attribution" : "different_claimant");
  }
  if (normal(left.claimPolarity) !== normal(right.claimPolarity)) reasons.push("polarity");
  for (const field of ["who", "subject", "reportedBy"]) {
    if (stable(list(left[field])) !== stable(list(right[field]))) reasons.push(field);
  }
  if (stable(facets(left)) !== stable(facets(right))) reasons.push("facets");
  if (normal(left.where) !== normal(right.where)) reasons.push("location");
  if (normal(left.why) !== normal(right.why)) reasons.push("cause");
  return reasons.length ? reasons : ["none_of_listed_fields"];
}

function lexicalSimilarity(left, right) {
  const bigrams = value => {
    const words = normal(value).split(" ").filter(Boolean);
    return words.length < 3 ? words : words.slice(0, -1).map((word, index) => word + " " + words[index + 1]);
  };
  const first = bigrams(left);
  const second = bigrams(right);
  if (!first.length || !second.length) return 0;
  const remaining = [...second];
  let common = 0;
  for (const value of first) {
    const index = remaining.indexOf(value);
    if (index >= 0) {
      common++;
      remaining.splice(index, 1);
    }
  }
  return 2 * common / (first.length + second.length);
}

function makeRow(status, run, pairId, left, right, pages, options = {}) {
  const span = primary(left);
  const identities = [recordIdentity(left), recordIdentity(right)].sort();
  const reviewKey = hash(stable([status, left.sourceContentHash, identities]));
  return {
    reviewKey, status, runsAndPairIds: `${run}:${pairId}`,
    kind: `${kind(left)}${kind(left) === kind(right) ? "" : ` / ${kind(right)}`}`,
    page: span.pageNumber, offset: span.sourceOffset, similarity: options.similarity ?? "",
    leftWhat: left.what, rightWhat: right.what,
    leftType: type(left), rightType: type(right),
    leftPeople: stable(people(left)), rightPeople: stable(people(right)),
    leftClaimant: left.claimant ?? "", rightClaimant: right.claimant ?? "",
    leftPolarity: left.claimPolarity ?? "", rightPolarity: right.claimPolarity ?? "",
    leftDates: stable(dates(left)), rightDates: stable(dates(right)),
    leftFacets: stable(facets(left)), rightFacets: stable(facets(right)),
    leftQuote: primary(left).sourceQuote, rightQuote: primary(right).sourceQuote,
    sourceContext: sourceContext(pages, left), modelReason: options.reason ?? "",
    fieldDifferences: options.fieldDifferences?.join("; ") ?? "", humanLabel: "", reviewNotes: "",
  };
}

function residualGroups(documents, includeStatement) {
  const groups = new Map();
  documents.forEach((document, index) => {
    const metadata = document.metadata;
    const span = primary(metadata);
    const key = stable([metadata.sourceContentHash, span.pageNumber, span.sourceOffset,
      normal(span.sourceQuote), dates(metadata), ...(includeStatement ? [normal(metadata.what)] : [])]);
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  });
  return [...groups.values()].filter(group => group.length > 1);
}

function addRow(rows, row) {
  const prior = rows.get(row.reviewKey);
  if (!prior) {
    rows.set(row.reviewKey, row);
    return;
  }
  prior.runsAndPairIds += `; ${row.runsAndPairIds}`;
  if (row.modelReason && !prior.modelReason.includes(row.modelReason)) {
    prior.modelReason += `${prior.modelReason ? "; " : ""}${row.modelReason}`;
  }
}

const csvCell = value => {
  const contents = String(value ?? "");
  // Spreadsheet programs can interpret source text beginning with these characters as a formula.
  const safe = /^\s*[=+@-]/.test(contents) ? "'" + contents : contents;
  return `"${safe.replaceAll('"', '""')}"`;
};
const csv = rows => [columns.join(","), ...rows.map(row => columns.map(column => csvCell(row[column])).join(","))].join("\n") + "\n";
const reviewOrder = (left, right) => left.status.localeCompare(right.status)
  || left.kind.localeCompare(right.kind) || Number(left.page) - Number(right.page)
  || Number(left.offset) - Number(right.offset) || left.reviewKey.localeCompare(right.reviewKey);

const { runs, outputDirectory } = argumentsForReview();
const rows = new Map();
const runSummaries = [];
for (const run of runs) {
  const before = JSON.parse(await readFile(run.before, "utf8"));
  const after = JSON.parse(await readFile(run.after, "utf8"));
  const sourceText = await readFile(before.input, "utf8");
  const sourceHash = hash(sourceText);
  assert.equal(before.inputHash, sourceHash, "Frozen source must match the extraction result");
  assert.equal(after.sourceHash, sourceHash, "Canonicalization must use the same source");
  assert.equal(resolve(after.inputFile), run.before, "Canonicalization must use the supplied extraction result");
  assert.equal(after.originalCount, before.documents.length);
  assert.equal(after.finalCount, after.documents.length);
  assert.equal(after.originalCount - after.finalCount, after.applied.length);
  assert.equal(after.failedBatches, 0, "Review only complete canonicalization runs");
  const pages = sourceText.split(PAGE_BREAK);
  const pairs = new Map(after.pairs.map(pair => [pair.id, pair]));
  const decisions = new Map(after.decisions.map(decision => [decision.pairId, decision]));
  for (const applied of after.applied) {
    const pair = pairs.get(applied.pairId);
    const decision = decisions.get(applied.pairId);
    assert.ok(pair && decision, "An applied merge needs its pair and model decision");
    const left = before.documents[pair.leftIndex].metadata;
    const right = before.documents[pair.rightIndex].metadata;
    addRow(rows, makeRow("applied_merge", run.name, pair.id, left, right, pages,
      { similarity: pair.similarity, reason: decision.reason }));
  }
  const exactGroups = residualGroups(after.documents, true);
  const anchorGroups = residualGroups(after.documents, false);
  let residualExactPairs = 0;
  let residualParaphrasePairs = 0;
  for (const group of anchorGroups) {
    for (let first = 0; first < group.length; first++) {
      for (let second = first + 1; second < group.length; second++) {
        const left = after.documents[group[first]].metadata;
        const right = after.documents[group[second]].metadata;
        const sameStatement = normal(left.what) === normal(right.what);
        const similarity = sameStatement ? 1 : lexicalSimilarity(left.what, right.what);
        if (!sameStatement && (kind(left) !== kind(right) || similarity < 0.8)) continue;
        addRow(rows, makeRow(sameStatement ? "residual_exact" : "residual_paraphrase",
          run.name, `${group[first]}:${group[second]}`, left, right, pages,
          { similarity, fieldDifferences: fieldDifferences(left, right) }));
        if (sameStatement) residualExactPairs++;
        else residualParaphrasePairs++;
      }
    }
  }
  runSummaries.push({ run: run.name, source: resolve(before.input), appliedMerges: after.applied.length,
    residualExactGroups: exactGroups.length,
    residualExactExtraRows: exactGroups.reduce((count, group) => count + group.length - 1, 0),
    residualExactPairs, residualParaphrasePairs, failedBatches: after.failedBatches });
}

const allRows = [...rows.values()].sort(reviewOrder);
const appliedRows = allRows.filter(row => row.status === "applied_merge");
const exactRows = allRows.filter(row => row.status === "residual_exact");
const paraphraseRows = allRows.filter(row => row.status === "residual_paraphrase");
const select = (items, count) => items.toSorted((left, right) =>
  hash(`review-sample:${left.reviewKey}`).localeCompare(hash(`review-sample:${right.reviewKey}`)))
  .slice(0, count);
const sample = [...select(appliedRows, 50), ...select(exactRows, 25), ...select(paraphraseRows, 25)]
  .sort(reviewOrder);
const fieldDifferenceCounts = {};
for (const row of [...exactRows, ...paraphraseRows]) {
  for (const field of row.fieldDifferences.split("; ")) {
    fieldDifferenceCounts[field] = (fieldDifferenceCounts[field] ?? 0) + 1;
  }
}
const summary = { runs: runSummaries, uniqueAppliedMerges: appliedRows.length,
  uniqueResidualExactPairs: exactRows.length, uniqueResidualParaphrasePairs: paraphraseRows.length,
  fieldDifferenceCounts,
  sampleAppliedMerges: sample.filter(row => row.status === "applied_merge").length,
  sampleResidualExactPairs: sample.filter(row => row.status === "residual_exact").length,
  sampleResidualParaphrasePairs: sample.filter(row => row.status === "residual_paraphrase").length,
  humanLabelsCompleted: 0 };
const guide = `# Source-grounded canonicalization review\n\n` +
  `The full queue contains ${appliedRows.length} unique applied merges, ${exactRows.length} exact-statement remaining pairs, ` +
  `and ${paraphraseRows.length} same-anchor paraphrase leads. ` +
  `The sample contains ${summary.sampleAppliedMerges} applied merges, ${summary.sampleResidualExactPairs} exact remaining pairs, ` +
  `and ${summary.sampleResidualParaphrasePairs} paraphrase leads.\n\n` +
  `For each row, compare both records with the quoted source and the full page in the source file. ` +
  `Enter same, distinct, or uncertain in humanLabel, then explain the decision in reviewNotes. ` +
  `Same means one atomic proposition or occurrence with no material detail lost. ` +
  `A distinct label on an applied_merge is a false merge. A same label on a residual row is a missed duplicate. ` +
  `Do not treat an unknown speaker as an alias for a named person without source support.\n\n` +
  `Field differences are review clues, not proof that the merge guards blocked a pair. ` +
  `The sample is an exploratory review set. Residual leads share an exact source anchor and date; ` +
  `applied merges may cite overlapping passages. ` +
  `No false-merge rate is available until a person labels the rows. ` +
  `Keep these files private because they contain source quotations.\n`;

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await writeFile(resolve(outputDirectory, "review-queue.csv"), csv(allRows), { flag: "wx", mode: 0o600 });
await writeFile(resolve(outputDirectory, "review-sample.csv"), csv(sample), { flag: "wx", mode: 0o600 });
await writeFile(resolve(outputDirectory, "review-summary.json"), JSON.stringify(summary, null, 2) + "\n",
  { flag: "wx", mode: 0o600 });
await writeFile(resolve(outputDirectory, "review-guide.md"), guide, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ outputDirectory, ...summary }, null, 2));
