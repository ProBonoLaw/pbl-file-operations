import { describe, expect, it, vi } from "vitest";
import { Document } from "@langchain/core/documents";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { CandidateSnapshotSchema, evidenceCandidateSchemas } from "../src/processors/evidence/evidenceExtractor.ts";
import { analyzerDefinition, layoutSource, normalizeCandidates, validateSnapshots, combineSnapshots,
  gradeJudgments, documentMetrics, priceUsage, pipelineMeasurements, combineCosts } from "../scripts/content-understanding-benchmark.mjs";
import { ContentUnderstandingClient } from "../scripts/content-understanding-client.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

vi.mock("../src/processors/appInsights.js", () => ({ telemetryClient: { trackEvent: vi.fn(), trackException: vi.fn() } }));

const source = (text: string) => new EvidenceSource(new Document({ pageContent: text, metadata: {} }));
const field = (value: any): any => Array.isArray(value) ? { type: "array", valueArray: value.map(field) }
  : value && typeof value === "object" ? { type: "object", valueObject: Object.fromEntries(Object.entries(value).map(([key, value]) => [key, field(value)])) }
    : { type: typeof value, [typeof value === "string" ? "valueString" : "valueNumber"]: value };
function response(quote = "Riley scored 97.", markdown = `😀 Header\n${quote}`) {
  const fact = field({ what: "Riley's recorded score was 97.", subject: ["Riley"], reportedBy: [], where: "Unknown",
    factType: "assessmentResult", facets: [], sourceQuote: quote, supportingQuotes: [] });
  fact.valueObject.sourceQuote.spans = [{ offset: markdown.indexOf(quote), length: quote.length }];
  fact.valueObject.sourceQuote.confidence = 0.98;
  return { status: "Succeeded", result: { analyzerId: "test", stringEncoding: "utf16", contents: [{ markdown,
    fields: { Events: field([]), Facts: { type: "array", valueArray: [fact] }, Claims: field([]) } }] } };
}
const options = { stringEncoding: "utf16", analyzerId: "test" };

describe("Content Understanding benchmark grounding and candidate isolation", () => {
  it("derives custom arrays, dates, enumerations and quote extraction from production schemas", () => {
    const analyzer = analyzerDefinition(evidenceCandidateSchemas, "gpt-5.2");
    expect(Object.keys(analyzer.fieldSchema.fields)).toEqual(["Events", "Facts", "Claims"]);
    const fields = analyzer.fieldSchema.fields.Events.items.properties;
    expect(fields.sourceQuote).toMatchObject({ method: "extract", estimateSourceAndConfidence: true });
    expect(fields.whenStartedYear.type).toBe("string");
    expect(fields.eventType.enum).toContain("communication");
    expect(JSON.stringify(analyzer)).not.toContain("$ref");
    expect(analyzer.config).not.toHaveProperty("workflow");
  });

  it("remaps UTF-16 quotes to exact canonical page-local offsets, preserving cross-page support", () => {
    const canonical = source("Canonical header\nRiley scored 97.<!-- PageBreak -->The examiner was Morgan.");
    const result = response("Riley scored 97.", "😀\nRiley scored 97.\nThe examiner was Morgan.");
    const support = field({ pageNumber: 99, quote: "The examiner was Morgan." });
    support.valueObject.quote.spans = [{ offset: result.result.contents[0].markdown.indexOf("The examiner"), length: 24 }];
    result.result.contents[0].fields.Facts.valueArray[0].valueObject.supportingQuotes = { type: "array", valueArray: [support] };
    const normalized = normalizeCandidates(result, canonical, evidenceCandidateSchemas, options);
    expect(normalized.rejected).toEqual([]);
    expect(normalized.accepted[0].primary.sourceOffset).toBe(17);
    expect(normalized.accepted[0].primary.service.spans[0].offset).toBe(3);
    expect(normalized.snapshots[0].candidates[0].item.supportingQuotes).toEqual([{ pageNumber: 2, quote: "The examiner was Morgan." }]);
    expect(normalized.snapshots[0].candidates[0].item.asOfYear).toBeNull();
    expect(validateSnapshots(normalized.snapshots, canonical, CandidateSnapshotSchema)).toHaveLength(2);
  });

  it("accepts only reversible whitespace matching and retains canonical text", () => {
    const canonical = source("Riley\nscored 97.");
    const normalized = normalizeCandidates(response(), canonical, evidenceCandidateSchemas, options);
    expect(normalized.accepted).toHaveLength(1);
    expect(normalized.snapshots[0].candidates[0].item.sourceQuote).toBe("Riley\nscored 97.");
    expect(normalizeCandidates(response(), source("Riley scored 98."), evidenceCandidateSchemas, options).rejected[0].reason).toMatch(/absent/);
  });

  it("quarantines ambiguous source quotes and bad service grounding instead of choosing the first match", () => {
    const ambiguous = source("Riley scored 97.<!-- PageBreak -->Riley scored 97.");
    expect(normalizeCandidates(response(), ambiguous, evidenceCandidateSchemas, options).rejected[0].reason).toMatch(/ambiguous/);
    const altered = response();
    altered.result.contents[0].fields.Facts.valueArray[0].valueObject.sourceQuote.spans[0].offset--;
    expect(normalizeCandidates(altered, source("Riley scored 97."), evidenceCandidateSchemas, options).accepted).toHaveLength(0);
    altered.result.stringEncoding = "codePoint";
    expect(() => normalizeCandidates(altered, ambiguous, evidenceCandidateSchemas, options)).toThrow(/encoding/);
  });

  it("reports missing categories, invalid classifications and unsupported primary anchors", () => {
    const incomplete: any = response();
    delete incomplete.result.contents[0].fields.Claims;
    incomplete.result.contents[0].fields.Facts.valueArray[0].valueObject.factType.valueString = "inventedType";
    const normalized = normalizeCandidates(incomplete, source("Riley scored 97."), evidenceCandidateSchemas, options);
    expect(normalized.missingCategories).toEqual(["Claims"]);
    expect(normalized.accepted).toHaveLength(0);
    expect(normalized.rejected).toHaveLength(1);
    const long = "Riley scored 97. " + "Long source sentence. ".repeat(350);
    expect(normalizeCandidates(response(long, long), source(long), evidenceCandidateSchemas, options).rejected[0].reason).toMatch(/window boundary/);
  });

  it("freezes window identities, preserves original candidates and rejects ID collisions", () => {
    const canonical = source("Riley scored 97.");
    const { snapshots } = normalizeCandidates(response(), canonical, evidenceCandidateSchemas, options);
    const baseline = structuredClone(snapshots);
    baseline[0].candidates[0].id = "original";
    const frozen = JSON.stringify(baseline), combined = combineSnapshots(baseline, snapshots);
    expect(combined[0].candidates).toHaveLength(2);
    expect(JSON.stringify(baseline)).toBe(frozen);
    expect(() => combineSnapshots(snapshots, snapshots)).toThrow(/collision/);
    const changed = structuredClone(snapshots); changed[0].textHash = "different";
    expect(() => validateSnapshots(changed, canonical, CandidateSnapshotSchema)).toThrow(/textHash/);
  });

  it("constructs layout pages from service spans and rejects dropped, overlapping or unassigned text", () => {
    const result: any = { status: "Succeeded", result: { stringEncoding: "utf16", contents: [{ markdown: "😀first\nsecond",
      pages: [{ pageNumber: 1, spans: [{ offset: 0, length: 8 }] }, { pageNumber: 2, spans: [{ offset: 8, length: 6 }] }] }] } };
    expect(layoutSource(result, "utf16")).toBe("😀first\n<!-- PageBreak -->second");
    result.result.contents[0].pages[1].spans[0] = { offset: 9, length: 5 };
    expect(() => layoutSource(result, "utf16")).toThrow(/Unassigned/);
    result.result.contents[0].pages[1].spans[0] = { offset: 7, length: 6 };
    expect(() => layoutSource(result, "utf16")).toThrow(/Overlapping/);
  });
});

describe("benchmark reporting cannot equate counts with quality", () => {
  const reference = { exhaustive: false, humanAdjudicated: false, units: [{ id: "score", kind: "fact" }, { id: "recommendation", kind: "claim" }] };
  const records = [{ id: "a", kind: "fact" }, { id: "b", kind: "fact" }];
  const judgment = (recordId: string) => ({ recordId, supported: true, classificationCorrect: true, citationSupported: true, atomic: true, unitIds: ["score"] });

  it("counts duplicates once and distinguishes provisional reference coverage from recall", () => {
    const grade = gradeJudgments(records, reference, [judgment("a"), judgment("b")]);
    expect(grade.byKind.fact).toMatchObject({ covered: 1, referenceCoverage: 1, recall: null });
    const gold = { ...reference, exhaustive: true, humanAdjudicated: true };
    expect(gradeJudgments(records, gold, [judgment("a")]).byKind.fact.recall).toBeNull();
    expect(gradeJudgments(records, gold, [judgment("a"), judgment("b")]).byKind.fact.recall).toBe(1);
  });

  it("rejects bundled multi-unit credit, stale IDs and unfinished judgments", () => {
    expect(() => gradeJudgments(records, reference, [{ ...judgment("a"), unitIds: ["score", "recommendation"] }])).toThrow(/at most one/);
    expect(() => gradeJudgments(records, reference, [judgment("missing")])).toThrow(/unknown record/);
    expect(() => gradeJudgments(records, reference, [{ ...judgment("a"), supported: null }])).toThrow(/Missing judgment/);
    expect(gradeJudgments(records, reference, [{ ...judgment("a"), citationSupported: false }]).byKind.fact.covered).toBe(0);
  });

  it("audits every actual citation and source hash without assigning semantic support", () => {
    const canonical = source("Riley scored 97.");
    const documents = [{ metadata: { what: "Unsupported interpretation.", factType: "assessmentResult", sourceContentHash: canonical.contentHash,
      sourceSpans: [{ pageNumber: 1, sourceOffset: 0, sourceQuote: "Riley scored 97." }] } }];
    expect(documentMetrics(documents, canonical).invalidCitations).toEqual([]);
    documents[0].metadata.sourceSpans[0].sourceOffset = 1;
    expect(documentMetrics(documents, canonical).invalidCitations).toHaveLength(1);
  });

  it("reports partial pricing and avoids double-counting cached input and reasoning tokens", () => {
    const measured = pipelineMeasurements([{ events: [{ name: "llm.call.token_usage", properties: { model: "test" }, measurements: {
      inputTokens: 100, cachedInputTokens: 30, cacheWriteTokens: 10, outputTokens: 20, reasoningTokens: 15,
    } }] }]);
    expect(measured.meters.models.test).toEqual({ input: 60, cachedInput: 30, cacheWrite: 10, output: 20 });
    const rates = { currency: "USD", meters: { documentPagesBasic: { price: 1, per: 1000 } } };
    expect(priceUsage({ documentPagesBasic: 2, tokens: { "test-output": 100 } }, rates)).toMatchObject({ total: null, knownSubtotal: 0.002, missing: ["tokens.test-output"] });
    expect(priceUsage(null, rates).total).toBeNull();
    expect(priceUsage({}, rates).total).toBeNull();
    expect(combineCosts({ parser: { total: 1, currency: "USD" }, replay: null }).total).toBeNull();
  });
});

describe("bounded Content Understanding operations", () => {
  const endpoint = "https://example.cognitiveservices.azure.com";
  const operation = `${endpoint}/contentunderstanding/analyzerResults/one?api-version=2025-11-01`;
  const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });

  it("submits once, saves the operation, requests diagnostics and resumes without another POST", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 202, { "Operation-Location": operation }))
      .mockResolvedValueOnce(json({ status: "Running" })).mockResolvedValueOnce(json({ status: "Succeeded", result: { contents: [] } }));
    let now = 0, saved: any;
    const client = new ContentUnderstandingClient({ endpoint, headers: async () => ({ Authorization: "Bearer test" }), fetcher,
      now: () => now, sleep: async (ms: number) => { now += ms; }, timeoutMs: 1, pollMs: 1 });
    const args = { analyzerId: "test", input: { data: "ZGF0YQ==", mimeType: "text/markdown" }, identity: { hash: "one" },
      save: async (value: any) => { saved = structuredClone(value); } };
    await expect(client.analyze(args)).rejects.toThrow(/deadline/);
    expect(saved.phase).toBe("polling");
    await expect(client.analyze({ ...args, journal: saved })).resolves.toMatchObject({ phase: "completed" });
    expect(fetcher.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
    for (const call of fetcher.mock.calls) expect(call[1].headers["x-ms-diagnostics"]).toBe("true");
    expect(fetcher.mock.calls[0][0]).toContain("stringEncoding=utf16");
  });

  it("refuses duplicate submissions after an ambiguous network failure or changed inputs", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network"));
    let saved: any;
    const client = new ContentUnderstandingClient({ endpoint, headers: async () => ({}), fetcher });
    const args = { analyzerId: "test", input: {}, identity: { hash: "one" }, save: async (value: any) => { saved = structuredClone(value); } };
    await expect(client.analyze(args)).rejects.toThrow("network");
    await expect(client.analyze({ ...args, journal: saved })).rejects.toThrow(/unknown/);
    await expect(client.analyze({ ...args, identity: { hash: "two" }, journal: saved })).rejects.toThrow(/different inputs/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never forwards credentials to foreign operation locations or follows redirects", async () => {
    const fetcher = vi.fn();
    const client = new ContentUnderstandingClient({ endpoint, headers: async () => ({ Authorization: "secret" }), fetcher });
    await expect(client.request("https://different.example/contentunderstanding/result")).rejects.toThrow(/different origin/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds transient polling retries and retains explicit failures", async () => {
    const fetcher = vi.fn().mockImplementation(async () => json({ error: { code: "TooManyRequests" } }, 429));
    const client = new ContentUnderstandingClient({ endpoint, headers: async () => ({}), fetcher, sleep: async () => {} });
    await expect(client.poll(operation, async () => {})).rejects.toThrow(/429/);
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockReset().mockResolvedValue(json({ status: "Failed", error: { code: "InvalidInput" } }));
    const save = vi.fn();
    await expect(client.poll(operation, save)).rejects.toThrow(/failed/);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ status: "Failed" }));
  });

  it("creates only new analyzers and refuses to overwrite an existing different definition", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ error: { code: "NotFound" } }, 404))
      .mockResolvedValueOnce(json({ status: "ready" }, 201)).mockResolvedValueOnce(json({ status: "ready", description: "test" }));
    const client = new ContentUnderstandingClient({ endpoint, headers: async () => ({}), fetcher });
    await client.ensureAnalyzer("test", { description: "test" });
    expect(fetcher.mock.calls[1][0]).toContain("allowReplace=false");
    fetcher.mockReset().mockResolvedValue(json({ status: "ready", description: "different" }));
    await expect(client.ensureAnalyzer("test", { description: "test" })).rejects.toThrow(/differs/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses request mappings when Azure returns DefaultsNotSet, without hiding other failures", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ error: { code: "InvalidRequest", innererror: {
      code: "DefaultsNotSet", message: "Defaults have not yet been set. Call PATCH first.",
    } } }, 400)).mockResolvedValueOnce(json({ modelDeployments: { "gpt-5.2": "old", embedding: "existing" } }))
      .mockResolvedValueOnce(json({ error: { code: "PermissionDenied" } }, 403));
    const client = new ContentUnderstandingClient({ endpoint, headers: async () => ({}), fetcher });
    await expect(client.modelDeployments({ "gpt-5.2": "benchmark" })).resolves.toEqual({ "gpt-5.2": "benchmark" });
    await expect(client.modelDeployments({ "gpt-5.2": "benchmark" })).resolves.toEqual({ "gpt-5.2": "benchmark", embedding: "existing" });
    await expect(client.modelDeployments({ "gpt-5.2": "benchmark" })).rejects.toThrow(/403/);
    expect(fetcher.mock.calls.every(call => call[1].method === "GET")).toBe(true);
  });
});

describe("standalone benchmark CLI (offline only)", () => {
  it("prepares, imports a matching receipt, reports pending scores, and rejects source drift", () => {
    const directory = mkdtempSync(join(tmpdir(), "cu-benchmark-"));
    const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
    const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
    const fixturePath = join(directory, "fixture.json"), output = join(directory, "run");
    const command = (...args: string[]) => spawnSync("bun", ["scripts/benchmark-content-understanding.mjs", "--input", fixturePath,
      "--output", output, ...args], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 30_000 });
    try {
      const markdown = "Riley scored 97.", pdf = "%PDF-test-offline-only";
      writeFileSync(join(directory, "source.md"), markdown); writeFileSync(join(directory, "source.pdf"), pdf);
      json(fixturePath, { version: 1, evaluationStatus: "development-regression",
        source: { id: "synthetic", markdown: "source.md", pdf: "source.pdf", sha256: hash(markdown), pdfSha256: hash(pdf) },
        contentUnderstanding: { completionModel: "gpt-5.2" } });
      const prepared = command("--stage", "prepare");
      expect(prepared.status, prepared.stderr).toBe(0);
      expect(prepared.stdout).toContain('"modelCalls":0');
      const manifest = read(join(output, "manifest.json"));
      const definitionHash = hash(JSON.stringify(manifest.definitions.candidates));
      const result = response(); result.result.analyzerId = `aimie-benchmark-candidates-${definitionHash.slice(0, 20)}`;
      const responsePath = join(directory, "response.json"), receiptPath = join(directory, "receipt.json");
      json(responsePath, result); json(receiptPath, { version: 1, inputHash: hash(markdown), definitionHash,
        apiVersion: "2025-11-01", stringEncoding: "utf16", responseHash: hash(JSON.stringify(result)) });
      const imported = command("--stage", "cu-candidates", "--response", responsePath, "--receipt", receiptPath, "--encoding", "utf16");
      expect(imported.status, imported.stderr).toBe(0);
      expect(read(join(output, "cu.snapshots.json"))[0].candidates).toHaveLength(1);
      const reported = command("--stage", "report");
      expect(reported.status, reported.stderr).toBe(0);
      expect(read(join(output, "report.json")).arms.baseline.status).toBe("not-run");
      expect(read(join(output, "report.json")).service.candidates.cost.total).toBeNull();
      writeFileSync(join(directory, "source.md"), "Riley scored 98.");
      const stale = command("--stage", "prepare");
      expect(stale.status).not.toBe(0); expect(stale.stderr).toContain("Canonical source changed");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 60_000);
});
