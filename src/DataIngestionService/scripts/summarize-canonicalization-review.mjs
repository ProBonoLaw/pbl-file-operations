import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const input = process.argv[2];
if (!input || process.argv.length !== 3) {
  throw new Error("Usage: bun run summarize:canonicalization-review REVIEWED_CSV");
}

function parseCsv(contents) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < contents.length; index++) {
    const character = contents[index];
    if (quoted) {
      if (character === '"' && contents[index + 1] === '"') {
        field += '"';
        index++;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && !field) quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") field += character;
  }
  assert.ok(!quoted, "CSV has an unterminated quoted field");
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

const [header, ...data] = parseCsv(await readFile(resolve(input), "utf8"));
assert.ok(header, "Review CSV is empty");
const statusIndex = header.indexOf("status");
const labelIndex = header.indexOf("humanLabel");
const keyIndex = header.indexOf("reviewKey");
assert.ok(statusIndex >= 0 && labelIndex >= 0 && keyIndex >= 0, "Review CSV is missing required columns");
const counts = Object.fromEntries(["applied_merge", "residual_exact", "residual_paraphrase"].map(status =>
  [status, { same: 0, distinct: 0, uncertain: 0, unreviewed: 0 }]));
const seen = new Set();
for (const row of data) {
  assert.equal(row.length, header.length, "Review CSV has an incomplete row");
  const status = row[statusIndex];
  const label = row[labelIndex].trim().toLowerCase() || "unreviewed";
  const key = row[keyIndex];
  assert.ok(counts[status], `Unknown review status: ${status}`);
  assert.ok(Object.hasOwn(counts[status], label), `Unknown humanLabel: ${label}`);
  assert.ok(key && !seen.has(key), "Review keys must be present and unique");
  seen.add(key);
  counts[status][label]++;
}
const rate = (numerator, denominator) => denominator ? numerator / denominator : null;
const applied = counts.applied_merge;
const residual = [counts.residual_exact, counts.residual_paraphrase];
const report = {
  input: resolve(input), totalRows: data.length, byStatus: counts,
  appliedFalseMergeRate: rate(applied.distinct, applied.same + applied.distinct),
  appliedReviewCount: applied.same + applied.distinct,
  residualMissedDuplicateRate: rate(residual.reduce((total, item) => total + item.same, 0),
    residual.reduce((total, item) => total + item.same + item.distinct, 0)),
  residualReviewCount: residual.reduce((total, item) => total + item.same + item.distinct, 0),
};
console.log(JSON.stringify(report, null, 2));
