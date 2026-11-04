import { describe, expect, it } from "vitest";
import { ExperimentalMarkdownSyntaxTextSplitter } from "../src/processors/experimentalMarkdownSyntaxTextSplitter.ts";

describe("ExperimentalMarkdownSyntaxTextSplitter", () => {
  it("retains the correct parent headings as sections change", () => {
    const splitter = new ExperimentalMarkdownSyntaxTextSplitter();

    const documents = splitter.splitText(
      "# Alpha\nFirst paragraph\n## Details\nSecond paragraph\n# Beta\nThird paragraph",
    );

    expect(documents.map(({ pageContent, metadata }) => ({
      text: pageContent.trim(),
      metadata,
    }))).toEqual([
      { text: "First paragraph", metadata: { "Header 1": "Alpha" } },
      {
        text: "Second paragraph",
        metadata: { "Header 1": "Alpha", "Header 2": "Details" },
      },
      { text: "Third paragraph", metadata: { "Header 1": "Beta" } },
    ]);
  });

  it("keeps heading-like text inside a fenced code block", () => {
    const splitter = new ExperimentalMarkdownSyntaxTextSplitter();

    const documents = splitter.splitText(
      "# Guide\nIntro\n```ts\n# literal heading\nconst x = 1\n```\nAfter",
    );

    expect(documents).toHaveLength(3);
    expect(documents[1].pageContent).toContain("# literal heading");
    expect(documents[1].metadata).toEqual({
      "Header 1": "Guide",
      Code: "```",
    });
    expect(documents[2].metadata).toEqual({ "Header 1": "Guide" });
  });
});
