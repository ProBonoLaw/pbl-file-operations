import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Document } from "@langchain/core/documents";
import { EvidenceSource } from "../dist/src/processors/evidence/evidenceSource.js";
import { gatheringLimits, planGatheringWindows } from "../dist/src/processors/evidence/evidenceGathering.js";

if (process.argv.length !== 3) throw new Error("Usage: bun scripts/plan-evidence-gathering.mjs path/to/source.md");
const input = await readFile(process.argv[2], "utf8");
const source = new EvidenceSource(new Document({pageContent:input, metadata:{}}));
const windows = source.windows(), limits = gatheringLimits();
const counts = {primary:{units:0, targetCharacters:0, largestTarget:0}, independent:{units:0, targetCharacters:0, largestTarget:0}};
const started = performance.now();
for (const window of windows) {
  const page = source.pages.find(page => page.pageNumber === window.pageNumber);
  for (const role of ["primary", "independent"]) {
    const segments = planGatheringWindows(window, page.text, limits[role], source.gatheringStructure(window.pageNumber));
    const coverage = new Uint8Array(window.text.length);
    for (const segment of segments) {
      if (segment.text !== page.text.slice(segment.startOffset, segment.startOffset + segment.text.length))
        throw new Error("Gathering changed source text or offsets");
      coverage.fill(1, segment.startOffset - window.startOffset, segment.startOffset - window.startOffset + segment.text.length);
      counts[role].units++;
      counts[role].targetCharacters += segment.text.length;
      counts[role].largestTarget = Math.max(counts[role].largestTarget, segment.text.length);
    }
    if (!coverage.every(value => value === 1)) throw new Error("Gathering omitted source characters");
  }
}
// Counts and a content hash only: never print source passages or model credentials.
console.log(JSON.stringify({sourceHash:createHash("sha256").update(input).digest("hex"), pages:source.pages.length,
  windows:windows.length, limits, ...counts, modelCallsWithoutSubdivision:windows.length * 4,
  plannedInitialModelCalls:counts.primary.units * 3 + counts.independent.units,
  allTargetCharactersCovered:true, planningMs:Math.round(performance.now() - started)}, null, 2));
