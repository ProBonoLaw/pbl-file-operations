import { Document } from "@langchain/core/documents";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { describe, expect, it } from "vitest";
import { EventDateResponseSchema, validateEventDateDecision } from "../src/processors/evidence/evidenceEventDates.ts";
import { formatEvidenceContent } from "../src/processors/evidence/evidenceContent.ts";
import { deduplicateEvidenceDocuments } from "../src/processors/evidence/evidenceDeduplication.ts";
import { findCanonicalizationPairs } from "../src/processors/evidence/evidenceCanonicalization.ts";

const empty = () => ({ year: "", month: "", day: "", season: "", quarter: "" });
const bounded = () => ({ candidateId: "a", status: "dated" as const, relation: "bounded" as const,
  start: {...empty(),year:"2025",month:"7",day:"18"}, end:{...empty(),year:"2025",month:"8",day:"21"},
  qualifier: "During one of the two sessions", explanation: "The exact session is unstated.",
  supportingQuotes: [{pageNumber:1,quote:"Sessions were July 18 and August 21, 2025."}] });

describe("focused event dates", () => {
  it("uses a reference-free native response format", () => {
    const schema = toJsonSchema(EventDateResponseSchema);
    expect(JSON.stringify(schema)).not.toContain('"$ref"');
    expect(Object.keys((schema.properties as any).decisions.items.properties)).not.toContain("what");
  });

  it.each([
    () => ({...bounded(), start:{...empty(),year:"2025",month:"2",day:"30"}}),
    () => ({...bounded(), start:{...empty(),year:"2026",month:"1",day:"1"}}),
    () => ({...bounded(), qualifier:""}),
    () => ({...bounded(), supportingQuotes:[]}),
    () => ({...bounded(), status:"unknown"}),
    () => ({...bounded(), what:"Rewrite the event"}),
  ])("rejects invalid dates, lost uncertainty, unsupported results and evidence rewrites", make => {
    expect(() => validateEventDateDecision(make())).toThrow();
  });

  it("keeps partial precision and explicit approximate wording", () => {
    const result = validateEventDateDecision({...bounded(),relation:"approximate",start:{...empty(),year:"2025",month:"3"},end:empty(),qualifier:"About March"});
    expect(result.start.day).toBe("");
  });

  it.each([
    ["duration", "three to four months"],
    ["unknown", "the last few weeks of school"],
    ["approximate", "about two weeks after the incident"],
  ])("retains cited relative timing without assigning calendar dates: %s", (relation, qualifier) => {
    const result=validateEventDateDecision({...bounded(),status:"unknown",relation,start:empty(),end:empty(),qualifier});
    const text=formatEvidenceContent({what:"Casey received therapy.",tags:["event"],whenStarted:null,whenEnded:null,
      eventDateResolution:result,sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:"Casey received therapy."}]});
    expect(result.start.year).toBe("");
    expect(text).toContain(`Relative timing (calendar date unknown): ${qualifier}`);
    expect(text).not.toContain("Event start date:");
  });

  it.each([
    {relation:"point",qualifier:""},
    {relation:"bounded",qualifier:"Between two sessions"},
    {relation:"duration",qualifier:""},
    {relation:"unknown",qualifier:"The last few weeks of school",supportingQuotes:[]},
  ])("rejects unsupported relative timing or invented calendar relationships", overrides => {
    expect(()=>validateEventDateDecision({...bounded(),status:"unknown",relation:"unknown",start:empty(),end:empty(),
      qualifier:"",...overrides})).toThrow();
  });

  it("renders bounds distinctly and protects them from duplicate merging", () => {
    const resolution = validateEventDateDecision(bounded());
    const quote = "Casey completed the assessment.";
    const metadata = {what:quote,tags:["event","eventType:assessment"],pages:[1],sourceOffset:0,sourceQuote:quote,
      sourceId:"one",sourceContentHash:"hash",sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:quote}],
      whenStarted:null,whenEnded:null,eventDateResolution:resolution};
    const boundedText = formatEvidenceContent(metadata);
    expect(boundedText).toContain("Earliest possible occurrence: 18 July 2025");
    expect(boundedText).toContain("Latest possible occurrence: 21 August 2025");
    expect(boundedText).not.toContain("Event start date:");
    const other = {...metadata,eventDateResolution:{...resolution,relation:"duration" as const,qualifier:""}};
    const docs = [new Document({metadata,pageContent:boundedText}),new Document({metadata:other,pageContent:formatEvidenceContent(other)})];
    expect(deduplicateEvidenceDocuments(docs)).toHaveLength(2);
    expect(findCanonicalizationPairs(docs)).toHaveLength(0);
  });
});
