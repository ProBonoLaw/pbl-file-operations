import {describe, expect, it} from "vitest";
import {deduplicateEvidenceCandidates} from "../src/processors/evidence/evidenceCandidateDeduplication.js";

const candidate = {id:"primary-1",kind:"fact",item:{what:"Temperature was 37 °C.",sourceQuote:"Temperature: 37 °C.",
  subject:["Patient"],asOfYear:"2025",asOfMonth:"5",asOfDay:"2",where:"Hospital",supportingQuotes:[]},
  extractedBy:["primary-facts:model-a"]};

describe("candidate deduplication before source review", () => {
  it("shares review only for exact records and retains both extractors' provenance without mutating input", () => {
    const independent = {...structuredClone(candidate),id:"independent-1",extractedBy:["independent:model-b"]};
    // Object key insertion order is not a material difference.
    independent.item = Object.fromEntries(Object.entries(independent.item).reverse()) as typeof candidate.item;
    const inputs = [candidate,independent];
    const before = structuredClone(inputs);
    const result = deduplicateEvidenceCandidates(inputs, () => true);
    expect(result).toEqual([{...candidate,extractedBy:["primary-facts:model-a","independent:model-b"]}]);
    expect(inputs).toEqual(before);
  });
  it.each([
    {what:"Temperature may have been 37 °C."}, {where:"Clinic"}, {subject:["Another patient"]},
    {asOfDay:"3"}, {sourceQuote:"Temperature: 37 °C. Later."},
    {supportingQuotes:[{pageNumber:2,quote:"Additional context."}]},
  ])("preserves material field or citation differences: %j", difference => {
    const other = {...candidate,id:"other",item:{...candidate.item,...difference}};
    expect(deduplicateEvidenceCandidates([candidate,other], () => true)).toHaveLength(2);
  });
  it("retains ambiguous source occurrences and independent repairs of invalid citations", () => {
    expect(deduplicateEvidenceCandidates([candidate,{...candidate,id:"other"}], () => false)).toHaveLength(2);
  });
  it("keeps kind and repair-feedback differences separate", () => {
    expect(deduplicateEvidenceCandidates([candidate,{...candidate,kind:"claim"},{...candidate,feedback:"Check date"}], () => true)).toHaveLength(3);
  });
});
