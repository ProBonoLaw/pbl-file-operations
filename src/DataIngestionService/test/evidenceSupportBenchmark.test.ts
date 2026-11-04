import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { eventCitationId, resolveEventStructure } from "../src/processors/evidence/evidenceEventStructure.ts";
import { validateSupportSuite, supportCaseInput, gradeSupportCase, gradeSupportSuite, summarizeSupportRun } from "../scripts/evidence-support-benchmark.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/evidence-support.json", import.meta.url), "utf8"));
const suite = validateSupportSuite(fixture);
const qualitySuite = validateSupportSuite(JSON.parse(readFileSync(
  new URL("./fixtures/evidence-quality-regressions.json", import.meta.url), "utf8")));
const linked = suite.cases.find(item => item.id === "cross-page-speaker-link")!;
const prediction = () => ({caseId: linked.id, availableEvidenceIds: linked.evidence.map(unit => unit.id), documents: [{metadata: {
  what: "Jordan left the building.", claimant: "Morgan Vale", tags: ["claim"],
  sourceSpans: [linked.evidence[0], linked.evidence[2]].map(unit => ({
    pageNumber: unit.page, sourceOffset: linked.pages[unit.page - 1].indexOf(unit.quote), sourceQuote: unit.quote,
  })),
}}]});

describe("source support benchmark grading (no model calls)", () => {
  it("freezes the new failures and rejects bundled recommendation/capability coverage", async () => {
    expect(qualitySuite.cases).toHaveLength(6);
    for (const item of qualitySuite.cases) {
      const {document,store} = supportCaseInput(item);
      const source = new EvidenceSource(document);
      const snapshot = await store.get(source.windows()[0]);
      expect(snapshot.candidates).toHaveLength(item.candidates.length);
      expect(snapshot).not.toHaveProperty("expected");
      if (item.dimension !== "atomicity") continue;
      const bundled = {caseId:item.id,availableEvidenceIds:["source"],documents:[{metadata:{
        what:item.pages[0],tags:["claim"],claimType:"opinion",sourceSpans:[{
          pageNumber:1,sourceOffset:0,sourceQuote:item.pages[0],
        }],
      }}]};
      expect(gradeSupportCase(item,bundled)).toMatchObject({passed:false,category:"semantic",
        outputCount:1,expectedCount:4});
    }
  });

  it("accepts either complete self-reading coverage while rejecting missing settings", () => {
    const item = qualitySuite.cases.find(item => item.id === "reading-enumeration-coverage")!;
    const prediction = (statements: string[]) => ({caseId:item.id,availableEvidenceIds:["source"],
      documents:statements.map(what => ({metadata:{what,tags:["claim"],claimType:"opinion",
        sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:item.pages[0]}]}}))});
    const common = ["Continue special education pull-out reading support.","Continue after-school tutoring.","Continue parent reading."];
    expect(gradeSupportCase(item,prediction([...common,"Continue self-reading with an adult present and alone."])).passed).toBe(true);
    expect(gradeSupportCase(item,prediction([...common,"Continue self-reading with an adult present.","Continue self-reading alone."])).passed).toBe(true);
    expect(gradeSupportCase(item,prediction([...common,"Continue self-reading with an adult present."])).passed).toBe(false);
  });
  it("validates every annotated fixture and builds replay input without gold annotations", async () => {
    expect(suite.cases).toHaveLength(14);
    for (const item of suite.cases) {
      const {document, store} = supportCaseInput(item);
      const source = new EvidenceSource(document);
      for (const window of source.windows()) {
        const snapshot = await store.get(window);
        expect(snapshot.sourceContentHash).toBe(source.contentHash);
        expect(snapshot.candidates).toHaveLength(window.pageNumber === item.targetPage ? item.candidates.length : 0);
        expect(snapshot).not.toHaveProperty("expected");
        expect(snapshot).not.toHaveProperty("evidenceSets");
        expect(JSON.stringify({document, snapshot})).not.toContain(item.id);
        for (const candidate of snapshot.candidates) {
          expect(candidate).not.toHaveProperty("candidateSupport");
          expect(candidate).not.toHaveProperty("feedback");
        }
      }
      const window = source.windows().find(window => window.pageNumber === item.targetPage)!;
      const prompt = JSON.parse(source.prompt(window));
      expect(item.evidence.every(unit => [prompt.target, prompt.precedingContext, prompt.followingContext]
        .some(passage => passage.pageNumber === unit.page && passage.text.includes(unit.quote)))).toBe(true);
      await expect(store.put()).rejects.toThrow("must not capture");
    }
  });

  it("requires a complete evidence set and accepts an alternative complete set", () => {
    const result = prediction();
    expect(gradeSupportCase(linked, result).passed).toBe(true);
    result.documents[0].metadata.sourceSpans.shift();
    expect(gradeSupportCase(linked, result)).toMatchObject({passed: false, semanticPass: true, category: "evidence-selection"});
    const alternative = linked.evidence[1];
    result.documents[0].metadata.sourceSpans.push({pageNumber: 1,
      sourceOffset: linked.pages[0].indexOf(alternative.quote), sourceQuote: alternative.quote});
    expect(gradeSupportCase(linked, result).passed).toBe(true);
  });

  it("checks exact source offsets and accepts a larger sufficient quotation", () => {
    const result = prediction();
    result.documents[0].metadata.sourceSpans[0] = {pageNumber: 1, sourceOffset: 0, sourceQuote: linked.pages[0]};
    expect(gradeSupportCase(linked, result).passed).toBe(true);
    result.documents[0].metadata.sourceSpans[0].sourceOffset = 1;
    expect(gradeSupportCase(linked, result)).toMatchObject({passed: false, category: "citation"});
  });

  it("separates wrong interpretation with available evidence from limited or unknown retrieval", () => {
    const result = prediction();
    result.documents[0].metadata.claimant = "Dr. Sam Reed";
    expect(gradeSupportCase(linked, result)).toMatchObject({passed: false, category: "semantic"});
    // A retrieval-limited diagnostic requires observed input coverage; it is not inferred from output citations.
    result.availableEvidenceIds = ["statement"];
    expect(gradeSupportCase(linked, result).category).toBe("retrieval-limited");
    expect(gradeSupportCase(linked, {...result, availableEvidenceIds: null}).category).toBe("unclassified-context");
  });

  it("keeps schema and invocation failures separate from source support", () => {
    expect(gradeSupportCase(linked, {...prediction(), documents: {}}).category).toBe("schema");
    expect(gradeSupportCase(linked, {...prediction(), failure: "invocation"}).category).toBe("invocation");
    expect(gradeSupportCase(linked, {...prediction(), failure: "schema"}).category).toBe("schema");
    expect(gradeSupportCase(linked, {...prediction(), availableEvidenceIds: ["invented"]}).category).toBe("schema");
  });

  it("does not reuse one record for two expected claims or ignore extra output", () => {
    const duplicateGold = {...linked, expected: [linked.expected[0], linked.expected[0]]};
    const result = prediction();
    result.documents.push({metadata: {...result.documents[0].metadata, claimant: "Another speaker"}});
    expect(gradeSupportCase(duplicateGold, result).passed).toBe(false);
    expect(gradeSupportCase(linked, result).passed).toBe(false);
  });

  it("counts absent predictions as failures and refuses unknown or duplicate cases", () => {
    expect(gradeSupportSuite(suite, [])).toMatchObject({total: 14, passed: 0, failures: {"missing-prediction": 14}});
    expect(() => gradeSupportSuite(suite, [prediction(), prediction()])).toThrow("Duplicate prediction");
    expect(() => gradeSupportSuite(suite, [{caseId: "unknown"}])).toThrow("unknown");
  });

  it("rejects corrupt benchmark annotations", () => {
    const missingQuote = structuredClone(fixture);
    missingQuote.cases[0].evidence[0].quote = "Invented quotation.";
    expect(() => validateSupportSuite(missingQuote)).toThrow("Gold quote missing");
    const unknownId = structuredClone(fixture);
    unknownId.cases[0].expected[0].evidenceSets = [["invented"]];
    expect(() => validateSupportSuite(unknownId)).toThrow("Unknown evidence ID");
    const duplicate = structuredClone(fixture);
    duplicate.cases.push(duplicate.cases[0]);
    expect(() => validateSupportSuite(duplicate)).toThrow("Duplicate case ID");
  });

  it("summarizes output usage without counting reasoning or request aggregates twice", () => {
    const call = {name: "llm.call.token_usage", properties: {model: "synthetic-model", stage: "reconciliation"},
      measurements: {inputTokens: 100, outputTokens: 40, reasoningTokens: 30, cachedInputTokens: 20}};
    const result = summarizeSupportRun([{elapsedMs: 10, events: [call, {...call, name: "llm.request.token_usage"}]}]);
    expect(result).toMatchObject({calls: 1, inputTokens: 100, outputTokens: 40, reasoningTokens: 30,
      cachedInputTokens: 20, caseElapsedMs: 10, callsReportingCachedInput: 1});
    expect(result.byModelAndStage).toHaveLength(1);
    expect(summarizeSupportRun([prediction()])).toMatchObject({calls: 0, outputTokens: null, cachedInputTokens: null, caseElapsedMs: null});
  });

  it("requires the role itself to cite its identity link, even when the record has that passage", () => {
    const events = validateSupportSuite(JSON.parse(readFileSync(new URL("./fixtures/evidence-event-structure.json", import.meta.url), "utf8")));
    expect(events.cases).toHaveLength(8);
    const item = events.cases.find(item => item.id === "distant-participant-identity")!;
    const spans = [item.evidence[1], item.evidence[0]].map(unit => ({pageNumber: unit.page, sourceOffset: 0, sourceQuote: unit.quote}));
    const structure = resolveEventStructure({who: ["Morgan Vale", "Casey"], eventStructure: {trigger: "paid", roles: [
      {role: "payer", participant: 0, citations: [0]}, {role: "payee", participant: 1, citations: [0]},
    ]}}, spans)!;
    const result = {caseId: item.id, availableEvidenceIds: null, documents: [{metadata: {
      what: "Morgan Vale paid Casey 500 dollars.", tags: ["event"], sourceSpans: spans, eventStructure: structure,
    }}]};
    expect(gradeSupportCase(item, result)).toMatchObject({passed: false, semanticPass: true, category: "evidence-selection"});
    structure.roles[0].citationIds.push(eventCitationId(spans[1]));
    expect(gradeSupportCase(item, result).passed).toBe(true);
  });

  it("runs the offline CLI and fails incomplete reports without loading models", () => {
    const directory = mkdtempSync(join(tmpdir(), "evidence-support-"));
    try {
      const input = join(directory, "predictions.json");
      const output = join(directory, "report.json");
      const script = fileURLToPath(new URL("../scripts/test-evidence-support.mjs", import.meta.url));
      // Simulated output tests the evaluator; this is not a measured model result.
      writeFileSync(input, JSON.stringify([prediction()]));
      const args = [script, "--predictions", input, "--output", output];
      const one = spawnSync(process.execPath, [...args, "--case", linked.id], {encoding: "utf8"});
      expect(one.status, one.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8")).report).toMatchObject({total: 1, passed: 1});
      const all = spawnSync(process.execPath, args, {encoding: "utf8"});
      expect(all.status, all.stderr).toBe(1);
      expect(JSON.parse(readFileSync(output, "utf8")).report).toMatchObject({total: 14, passed: 1,
        failures: {"missing-prediction": 13}});
    } finally { rmSync(directory, {recursive: true, force: true}); }
  });
});
