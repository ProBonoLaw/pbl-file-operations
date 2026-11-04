import {Document} from "@langchain/core/documents";
import {describe, expect, it} from "vitest";
import {partitionIdentityDecisions} from "../src/processors/evidence/evidenceIdentityReview.ts";
import type {CanonicalizationPair} from "../src/processors/evidence/evidenceCanonicalization.ts";

const pairs: CanonicalizationPair[] = [
  {id:"0:1",leftIndex:0,rightIndex:1,similarity:0.8,allowedSurvivors:["left","right"]},
  {id:"2:3",leftIndex:2,rightIndex:3,similarity:0.8,allowedSurvivors:["left"]},
];
const documents = Array.from({length:4}, () => new Document({pageContent:"",metadata:{what:"A recorded statement."}}));
const assessment = {pairId:"0:1",relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Same assertion."};
const keep = {...assessment,verdict:"duplicate",survivor:"left"};
const documentsFor = (left: string, right: string) => [left,right].map(what => new Document({pageContent:"",metadata:{what,factType:"assessmentResult"}}));

describe("individual identity assessments", () => {
  it("retains a valid decision and gives precise feedback for an invalid relation", () => {
    const result = partitionIdentityDecisions(pairs,[assessment,{...assessment,pairId:"2:3",relation:"maybe"}],documents);
    expect(result.valid).toEqual([keep]);
    expect([...result.errors.keys()]).toEqual(["2:3"]);
    expect(result.errors.get("2:3")).toContain("relation (same_assertion/independent_assertions/uncertain)");
    expect(result.errorCounts).toEqual({invalid_schema:1});
  });

  it("does not pick one of conflicting repeated rows and ignores foreign IDs", () => {
    const other = {...assessment,pairId:"2:3"};
    const result = partitionIdentityDecisions(pairs,[assessment,{...assessment,relation:"independent_assertions"},other,
      {...assessment,pairId:"4:5"},{survivor:"left"}],documents);
    expect(result.valid).toEqual([{...keep,pairId:"2:3"}]);
    expect([...result.errors.keys()]).toEqual(["0:1"]);
    expect(result.unexpectedIds).toEqual(["4:5","[missing ID]"]);
    expect(result.errorCounts).toEqual({repeated_decision:1});
  });

  it.each([
    {relation:"maybe"}, {relation:null}, {leftOnlyDetails:"detail"},
    {rightOnlyDetails:[3]}, {reason:" "}, {leftOnlyDetails:[""]},
  ])("isolates invalid rows: %j", invalid => {
    const result = partitionIdentityDecisions(pairs,[assessment,{...assessment,pairId:"2:3",...invalid}],documents);
    expect(result.valid).toEqual([keep]);
    expect([...result.errors.keys()]).toEqual(["2:3"]);
  });

  it("reports a missing pair without invalidating the returned pair", () => {
    const result = partitionIdentityDecisions(pairs,[assessment],documents);
    expect(result.valid).toEqual([keep]);
    expect(result.errors.get("2:3")).toContain("received 0");
    expect(result.errorCounts).toEqual({missing_decision:1});
  });

  it("counts validation categories without exposing assertions or rejected excerpts", () => {
    const result = partitionIdentityDecisions(pairs,[{...assessment,reason:" "},
      {...assessment,pairId:"2:3",leftOnlyDetails:["private invented detail"]}],documents);
    expect(result.errorCounts).toEqual({empty_reason:1,invalid_detail_excerpt:1});
    expect(Object.values(result.errorCounts).reduce((sum, count) => sum + count, 0)).toBe(result.errors.size);
  });

  it("preserves both when the only allowed survivor loses a classification, without retrying", () => {
    const docs = documentsFor("The assessment has no elevated results.", "No results are elevated; all results are average.");
    const pair = {...pairs[0],allowedSurvivors:["left"] as const};
    const result = partitionIdentityDecisions([{...pair,allowedSurvivors:[...pair.allowedSurvivors]}],
      [{...assessment,rightOnlyDetails:["all results are average"]}],docs);
    expect(result.errors.size).toBe(0);
    expect(result.valid[0]).toMatchObject({verdict:"distinct",survivor:"none",rightOnlyDetails:["all results are average"]});
  });

  it("preserves both when each has unique details", () => {
    const docs = documentsFor("The reading score is 101, average.", "The reading score is 101, percentile 53.");
    const result = partitionIdentityDecisions([pairs[0]],
      [{...assessment,leftOnlyDetails:["average"],rightOnlyDetails:["percentile 53"]}],docs);
    expect(result.errors.size).toBe(0);
    expect(result.valid[0]).toMatchObject({verdict:"distinct",survivor:"none"});
  });

  it.each(["left","right"])("derives the richer %s survivor instead of accepting a conflicting model direction", side => {
    const richer = "The reading score is 101, percentile 53, average.";
    const simple = "The reading score is 101.";
    const docs = side === "left" ? documentsFor(richer,simple) : documentsFor(simple,richer);
    const row = {...assessment,[side+"OnlyDetails"]:["percentile 53","average"],verdict:"distinct",survivor:"none"};
    const result = partitionIdentityDecisions([pairs[0]],[row],docs);
    expect(result.valid[0]).toMatchObject({verdict:"duplicate",survivor:side});
  });

  it.each(["independent_assertions","uncertain"])("preserves a %s assessment even with an injected duplicate verdict", relation => {
    const result = partitionIdentityDecisions([pairs[0]],[{...assessment,relation,verdict:"duplicate",survivor:"right"}],documents);
    expect(result.errors.size).toBe(0);
    expect(result.valid[0]).toMatchObject({verdict:relation === "uncertain" ? "uncertain" : "distinct",survivor:"none"});
  });

  it("catches explicit added clauses even if the reviewer reports no differences", () => {
    const docs = documentsFor("The worker attended the course.","The worker attended the course and passed the examination.");
    const result = partitionIdentityDecisions([pairs[0]],[assessment],docs);
    expect(result.valid[0]).toMatchObject({verdict:"distinct",survivor:"none",reason:expect.stringContaining("separate atomic assertion")});
  });

  it("rejects detail witnesses borrowed from a quotation or another pair", () => {
    const result = partitionIdentityDecisions([pairs[0]],[{...assessment,leftOnlyDetails:["An invented detail"]}],documents);
    expect(result.valid).toEqual([]);
    expect(result.errors.get("0:1")).toContain("exact excerpts");
    expect(result.errors.get("0:1")).toContain('Rejected excerpts: ["An invented detail"]');
    expect(result.errors.get("0:1")).toContain('The complete left.assertion.what is "A recorded statement."');
  });

  it("requires the detail inventory rather than accepting a legacy duplicate decision", () => {
    const result = partitionIdentityDecisions([pairs[0]],[{pairId:"0:1",verdict:"duplicate",survivor:"right",reason:"Same."}],documents);
    expect(result.valid).toEqual([]);
    expect(result.errors.size).toBe(1);
  });
});
