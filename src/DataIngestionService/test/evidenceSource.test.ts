import { Document } from "@langchain/core/documents";
import { describe, expect, it, vi } from "vitest";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";

describe("EvidenceSource", () => {
  it("covers every character of every nonempty page with bounded windows", () => {
    const text = "A long source paragraph.\n".repeat(700);
    const source = new EvidenceSource(new Document({
      pageContent: text + "<!-- PageBreak --><!-- PageBreak -->Last page.", metadata: { pages: [4, 7, 9] },
    }));
    const windows = source.windows();
    const coverage = new Uint8Array(text.length);
    for (const window of windows.filter(window => window.pageNumber === 4)) {
      expect(window.text.length).toBeLessThanOrEqual(5000);
      expect(text.slice(window.startOffset, window.startOffset + window.text.length)).toBe(window.text);
      coverage.fill(1, window.startOffset, window.startOffset + window.text.length);
    }
    expect(coverage.every(value => value === 1)).toBe(true);
    expect(windows.some(window => window.pageNumber === 7)).toBe(false);
    expect(windows.at(-1)).toMatchObject({ pageNumber: 9, text: "Last page." });
  });

  it("resolves exact source offsets across pages and rejects ambiguous quotations", () => {
    const source = new EvidenceSource(new Document({
      pageContent: "Register:\nMorgan   Hale is W-17.<!-- PageBreak -->Repeated. Repeated. Distinct denial.",
      metadata: { pages: [1, 3] },
    }));
    expect(source.locateSupporting(1, "Morgan Hale is W-17.")).toEqual({
      pageNumber: 1, sourceOffset: 10, sourceQuote: "Morgan   Hale is W-17.",
    });
    const target = source.windows()[1];
    expect(source.locate(target, "Repeated.")).toBeNull();
    expect(source.matchInWindow(target, "Repeated.").map(match => match.sourceOffset)).toEqual([0, 10]);
    expect(source.quoteContext(source.matchInWindow(target, "Repeated.")[0])).toEqual({
      before: "", after: " Repeated. Distinct denial.",
    });
    expect(source.locate(target, "Distinct denial.")).toEqual({ pageNumber: 3, sourceOffset: 20, sourceQuote: "Distinct denial." });
    expect(source.locateSupporting(99, "Distinct denial.")).toBeNull();
  });

  it("bounds context reads and gives each independent invocation a fresh budget", async () => {
    const source = new EvidenceSource(new Document({ pageContent: "x".repeat(12000), metadata: { pages: [1] } }));
    const reader = source.contextTool();
    const request = { pageNumber: 1, startOffset: 0 };
    const first = JSON.parse(await reader.invoke(request));
    expect(first.text).toHaveLength(10000);
    expect(first.nextOffset).toBe(10000);
    for (let i = 1; i < 6; i++) await reader.invoke(request);
    expect(JSON.parse(await reader.invoke(request)).error).toContain("budget exhausted");
    expect(JSON.parse(await source.contextTool().invoke({ pageNumber: 1, startOffset: 10000 })).text).toHaveLength(2000);
  });

  it("observes failed reads and a shared read/search budget without logging source text", async () => {
    const source = new EvidenceSource(new Document({pageContent: "Witness W-17 is Morgan Vale."}));
    const budget = {reads: 0};
    const observe = vi.fn();
    const reader = source.contextTool(budget, observe);
    const search = source.contextSearchTool(budget, observe);
    await reader.invoke({pageNumber: 99, startOffset: 0});
    expect(observe).toHaveBeenLastCalledWith({operation: "read", outcome: "invalid-location", reads: 1, passageCount: 0});
    await reader.invoke({pageNumber: 1, startOffset: 0});
    expect(observe).toHaveBeenLastCalledWith({operation: "read", outcome: "returned", reads: 2, passageCount: 1});
    vi.spyOn(source.context, "lookup").mockReturnValue([]);
    for (let i = 0; i < 4; i++) await search.invoke({pageNumber: 1, query: "unmentioned matter", purpose: "review"});
    expect(observe).toHaveBeenLastCalledWith({operation: "search", outcome: "empty", reads: 6, passageCount: 0});
    const exhausted = JSON.parse(await search.invoke({pageNumber: 1, query: "W-17", purpose: "review"}));
    expect(exhausted.error).toContain("do not prove absence");
    expect(observe).toHaveBeenLastCalledWith({operation: "search", outcome: "budget-exhausted", reads: 7, passageCount: 0});
    expect(JSON.stringify(observe.mock.calls)).not.toContain("Morgan");
    await source.contextTool({reads: 0}, observe).invoke({pageNumber: 1, startOffset: 0});
    expect(observe).toHaveBeenLastCalledWith({operation: "read", outcome: "returned", reads: 1, passageCount: 1});
  });
});
