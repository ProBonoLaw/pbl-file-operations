import { Document } from "@langchain/core/documents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatheringLimits, planGatheringWindows, resolveGatheringUnit, splitGatheringWindow } from "../src/processors/evidence/evidenceGathering.js";
import { parseGatheringStructure } from "../src/processors/evidence/evidenceGatheringSections.js";
import { EvidenceSource, type EvidenceWindow } from "../src/processors/evidence/evidenceSource.js";

afterEach(() => vi.unstubAllEnvs());
const limits = {maxChars:1500, maxUnits:8, overlapChars:150};
const target = (text: string): EvidenceWindow => ({pageNumber:24, startOffset:0, text, before:"Previous page.", after:"Next page."});

function assertCoverage(window: EvidenceWindow, page: string, segments: EvidenceWindow[], maximum: number) {
  const covered = new Uint8Array(window.text.length);
  for (const segment of segments) {
    expect(segment.text.length).toBeGreaterThan(0);
    expect(segment.text.length).toBeLessThanOrEqual(maximum);
    expect(segment.text.isWellFormed()).toBe(true);
    expect(segment.pageNumber).toBe(window.pageNumber);
    expect(segment.text).toBe(page.slice(segment.startOffset, segment.startOffset + segment.text.length));
    covered.fill(1, segment.startOffset - window.startOffset, segment.startOffset - window.startOffset + segment.text.length);
  }
  expect(covered.every(value => value === 1)).toBe(true);
  expect(segments[0].before).toBe(window.before);
  expect(segments.at(-1)!.after).toBe(window.after);
}

describe("deterministic gathering plans", () => {
  it("also respects titles before the larger logical source windows are created", () => {
    const first = "## History\n\n" + "History body. ".repeat(310) + "\n\n";
    const next = "## Examination\n\n" + "Examination body. ".repeat(100);
    const source = new EvidenceSource(new Document({pageContent:first + next, metadata:{pages:[24]}}));
    const windows = source.windows();
    expect(windows).toHaveLength(2);
    expect(windows[0].text).toBe(first);
    expect(windows[1].text).toContain(next);
  });

  it("keeps Unicode intact at both logical and gathering window boundaries", () => {
    const text = "x" + "😀".repeat(4000);
    const source = new EvidenceSource(new Document({pageContent:text, metadata:{pages:[24]}}));
    for (const window of source.windows()) {
      expect(window.text.isWellFormed()).toBe(true);
      assertCoverage(window, text, planGatheringWindows(window, text, limits), limits.maxChars);
    }
  });

  it("groups short sections intact and splits between titles when the work budget is reached", () => {
    const first = "# Hospital report\n\n## History\n\nFirst observation.\n\n";
    const second = "## Examination\n\nSecond observation.\n";
    const window = target(first + second);
    const segments = planGatheringWindows(window, window.text, limits);
    expect(segments.map(segment => segment.text)).toEqual([first + second]);
    expect(planGatheringWindows(window, window.text, {...limits, maxUnits:1}).map(segment => segment.text)).toEqual([first, second]);
    assertCoverage(window, window.text, segments, limits.maxChars);
  });

  it("uses the Markdown AST for setext, escaped titles, fenced code, blockquotes, and bold OCR titles", () => {
    const text = "Title\r\n=====\r\n\r\nBody.\r\n\r\n```md\r\n# Not a section\r\n```\r\n\r\n"
      + "> # Quoted heading\r\n\r\n\\# Escaped heading\r\n\r\n**Findings**\r\n\r\nObservation.\r\n";
    const parsed = parseGatheringStructure(text);
    expect(parsed.headings.map(heading => text.slice(heading.start, heading.end)))
      .toEqual(["Title\r\n=====", "**Findings**"]);
    expect(planGatheringWindows(target(text), text, {maxChars:5000, maxUnits:100, overlapChars:150})).toHaveLength(1);
  });

  it("retains every character and UTF-16 offset in oversized sections with overlapping edges", () => {
    const prefix = "Prior source. ".repeat(55);
    const body = "## Observations\r\n\r\n" + "中文 😀 a long passage without a sentence boundary ".repeat(130);
    const window = {...target(body), startOffset:prefix.length, before:prefix.slice(-700)};
    const page = prefix + body;
    const segments = planGatheringWindows(window, page, limits);
    expect(segments.length).toBeGreaterThan(3);
    assertCoverage(window, page, segments, limits.maxChars);
    expect(segments[1].startOffset).toBeLessThan(segments[0].startOffset + segments[0].text.length);
    expect(planGatheringWindows(window, page, limits)).toEqual(segments);
  });

  it("bounds dense rows without merging the following titled section", () => {
    const table = "## Measurements\n\n| Test | Value |\n| --- | --- |\n"
      + Array.from({length:40}, (_, i) => `| Item ${i} | ${i} |\n`).join("");
    const next = "\n## Plan\n\nFollow up next month.\n";
    const window = target(table + next);
    const segments = planGatheringWindows(window, window.text, limits);
    expect(segments.length).toBeGreaterThan(4);
    expect(segments.at(-1)!.text).toContain("## Plan");
    expect(segments.filter(segment => segment.text.includes("Follow up"))).toHaveLength(1);
    assertCoverage(window, window.text, segments, limits.maxChars);
  });

  it("validates queued unit boundaries including bounded timeout recovery children", () => {
    const window = target("word ".repeat(450));
    const segment = planGatheringWindows(window, window.text, limits)[0];
    const unit = {stage:"independent" as const, startOffset:segment.startOffset, characterCount:segment.text.length, depth:0};
    expect(resolveGatheringUnit(window, window.text, limits, unit)).toEqual(segment);
    expect(() => resolveGatheringUnit(window, window.text, limits, {...unit, startOffset:1})).toThrow("source plan");
    expect(() => resolveGatheringUnit(window, window.text, limits, {...unit, depth:3})).toThrow("depth");
    const child = splitGatheringWindow(segment, 0, window.text)![1];
    expect(resolveGatheringUnit(window, window.text, limits, {...unit, startOffset:child.startOffset,
      characterCount:child.text.length, depth:1})).toEqual(child);
  });

  it.each([
    ["EVIDENCE_GATHER_PRIMARY_MAX_CHARS", "0"], ["EVIDENCE_GATHER_INDEPENDENT_MAX_CHARS", "5001"],
    ["EVIDENCE_GATHER_PRIMARY_MAX_UNITS", "1.5"], ["EVIDENCE_GATHER_INDEPENDENT_MAX_UNITS", "-1"],
    ["EVIDENCE_GATHER_OVERLAP_CHARS", "501"],
  ])("rejects invalid appsettings %s=%s", (name, value) => {
    vi.stubEnv(name, value);
    expect(gatheringLimits).toThrow(name);
  });

  it("allows appsettings to change the plan without changing source content", () => {
    vi.stubEnv("EVIDENCE_GATHER_INDEPENDENT_MAX_CHARS", "750");
    vi.stubEnv("EVIDENCE_GATHER_INDEPENDENT_MAX_UNITS", "3");
    vi.stubEnv("EVIDENCE_GATHER_OVERLAP_CHARS", "0");
    const window = target("A recorded observation.\n".repeat(30));
    const configured = gatheringLimits().independent;
    expect(configured).toEqual({maxChars:750, maxUnits:3, overlapChars:0});
    const segments = planGatheringWindows(window, window.text, configured);
    expect(segments.map(segment => segment.text).join("")).toBe(window.text);
    expect(segments.every(segment => (segment.text.match(/\n/g) ?? []).length <= 3)).toBe(true);
  });
});

describe("gathering source context", () => {
  it("carries enclosing titles across physical pages without assigning their meaning", () => {
    const source = new EvidenceSource(new Document({pageContent:"# Hospital report\n\n## Examination\n\nEarlier finding."
      + "<!-- PageBreak -->Later finding.", metadata:{pages:[7,24]}}));
    const prompt = JSON.parse(source.gatheringPrompt(source.windows()[1]));
    expect(prompt.target.pageNumber).toBe(24);
    expect(prompt.structuralContext.map((span: any) => [span.pageNumber, span.sourceQuote]))
      .toEqual([[7,"# Hospital report"],[7,"## Examination"]]);
    expect(prompt.structuralContextNote).toContain("do not establish a date, speaker, location");
    expect(source.gatheringStructure(7)).toBe(source.gatheringStructure(7));
  });

  it.each(["markdown", "html"])("supplies exact %s table headers beyond the neighboring-text limit", format => {
    const header = format === "markdown" ? "| Test | Result |\n| --- | --- |\n" : "<table>\n<tr><th>Test</th><th>Result</th></tr>\n";
    const rows = Array.from({length:45}, (_, i) => format === "markdown" ? `| Test ${i} | Result ${i} |\n` : `<tr><td>Test ${i}</td><td>Result ${i}</td></tr>\n`);
    const text = "## Results\n\n" + header + rows.join("") + (format === "html" ? "</table>" : "");
    const source = new EvidenceSource(new Document({pageContent:text, metadata:{pages:[24]}}));
    const startOffset = text.indexOf(rows[40]);
    const window = {...target(rows[40]), startOffset, before:text.slice(startOffset - 700, startOffset), after:""};
    const context = JSON.parse(source.gatheringPrompt(window)).structuralContext;
    expect(window.before).not.toContain("Test</th>");
    expect(context).toHaveLength(2);
    for (const span of context) expect(text.slice(span.sourceOffset, span.sourceOffset + span.sourceQuote.length)).toBe(span.sourceQuote);
    expect(context[1].sourceQuote).toContain(format === "markdown" ? "| Test | Result |" : "<th>Test</th>");
  });

  it("uses HTML parser positions for headings with inline markup and entities", () => {
    const text = "<h2 class='title'>History &amp; <em>Findings</em></h2>\n<p>A finding.</p>\n"
      + "<h2>Plan</h2>\n<p>Follow up.</p>";
    const structure = parseGatheringStructure(text);
    expect(structure.headings.map(heading => text.slice(heading.start, heading.end)))
      .toEqual(["<h2 class='title'>History &amp; <em>Findings</em></h2>", "<h2>Plan</h2>"]);
    const segments = planGatheringWindows(target(text), text, limits);
    expect(segments).toHaveLength(1);
    assertCoverage(target(text), text, segments, limits.maxChars);
  });
});
