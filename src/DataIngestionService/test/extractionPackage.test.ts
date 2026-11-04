import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { get_encoding } from "tiktoken";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { attachEvidenceLocations, extractionChunks, legacyChunks, legacySourcePages, literalDocument, parseExtractionPackage } from "../src/processors/extractionPackage.ts";

function fixture(mediaType = "document") {
  const text = "Literal source text.";
  const timing = mediaType === "document" ? { startTimeMs: null, endTimeMs: null, speaker: null }
    : { startTimeMs: 1000, endTimeMs: 4000, speaker: "Speaker 1" };
  const location = { pages: mediaType === "document" ? [7] : [], regions: mediaType === "document" ? ["D(7,0,0,1,1)"] : [], ...timing };
  return { version: 1, accountId: "account", sourceId: "source", mediaType, provider: "content-understanding",
    analyzerId: "test", apiVersion: "2025-11-01", analysisId: "one", configurationHash: "a".repeat(64),
    sourceSha256: "b".repeat(64), stringEncoding: "utf16", literalMarkdown: text,
    literalPages: [{ pageNumber: 7, text, locationKind: mediaType === "document" ? "physical-page" : "media" }],
    blocks: [{ id: "literal", kind: mediaType === "document" ? "paragraph" : "transcript", origin: "extracted", text, ...location, serviceSpans: [] },
      { id: "generated", kind: "summary", origin: "generated", text: "Generated summary.", ...location, serviceSpans: [] }],
    evidenceLocations: [{ pageNumber: 7, offset: 0, length: text.length, blockId: "literal", ...location }],
    rawResponse: {}, usage: null, warnings: [] };
}

describe("versioned CU extraction package", () => {
  it("keeps generated enrichments out of the literal evidence source and separates retrieval chunks", () => {
    const pkg = parseExtractionPackage(fixture());
    expect(literalDocument(pkg).pageContent).toBe("Literal source text.");
    const chunks = extractionChunks(pkg);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].pageContent).toContain("AI-generated summary");
    expect(chunks.map(chunk => chunk.metadata.contentOrigin)).toEqual(["extracted", "generated"]);
    expect(chunks[0].metadata.pages).toEqual([7]);
  });

  it("carries retained image references with related retrieval chunks and evidence citations", () => {
    const value = fixture();
    const image = { id: "figure:1", kind: "figure", containerName: "results", containerPath: "cu-assets/figure.jpg",
      url: "https://storage.blob.core.windows.net/results/cu-assets/figure.jpg", contentType: "image/jpeg",
      sha256: "c".repeat(64), sizeBytes: 1234, serviceFilePath: "figures/1.1", blockIds: ["literal", "generated"],
      pages: [7], regions: ["D(7,0,0,1,1)"], timeMs: null };
    const pkg = parseExtractionPackage({ ...value, assets: [image] });
    const chunks = extractionChunks(pkg);
    expect(chunks[1].metadata.images).toEqual([image]);
    expect(literalDocument(pkg).pageContent).not.toContain("figure.jpg");
    const evidence = new Document({ pageContent: "Source page: 7", metadata: {
      sourceSpans: [{ pageNumber: 7, sourceOffset: 0, sourceQuote: value.literalMarkdown }],
    } });
    expect(attachEvidenceLocations([evidence], pkg)[0].metadata.images).toEqual([image]);
    expect(() => parseExtractionPackage({ ...value, assets: [{ ...image, url: image.url + "?sig=secret" }] })).toThrow();
    expect(() => parseExtractionPackage({ ...value, assets: [{ ...image, blockIds: ["missing"] }] })).toThrow("unknown source block");
  });

  it("rejects invented quote mappings and generated blocks used as quotation sources", () => {
    const value = fixture();
    value.evidenceLocations[0].blockId = "generated";
    expect(() => parseExtractionPackage(value)).toThrow("literal block");
    const incorrect = fixture();
    incorrect.evidenceLocations[0].pages = [8];
    expect(() => parseExtractionPackage(incorrect)).toThrow("differs");
  });

  it("maps canonical evidence quotations to original media times without indexing a fictitious page", () => {
    const pkg = parseExtractionPackage(fixture("audio"));
    const evidence = new Document({ pageContent: "Fact: source text\nSource page: 7\nSource quote: Literal source text.",
      metadata: { sourceSpans: [{ pageNumber: 7, sourceOffset: 0, sourceQuote: "Literal source text." }] } });
    const [mapped] = attachEvidenceLocations([evidence], pkg);
    expect(mapped.metadata.pages).toEqual([]);
    expect(mapped.metadata.startTimeMs).toBe(1000);
    expect(mapped.pageContent).toContain("Source time (milliseconds): 1000–4000");
    expect(mapped.pageContent).not.toContain("Source page");
    const source = new EvidenceSource(literalDocument(pkg));
    const prompt = JSON.parse(source.prompt(source.windows()[0]));
    expect(prompt.transcriptAttribution.locations[0].speaker).toBe("Speaker 1");
    expect(prompt.target.text).toBe(pkg.literalMarkdown);
  });

  it("bounds unbroken Unicode text and oversized table rows while retaining provenance", () => {
    const pkg = parseExtractionPackage(fixture());
    for (const kind of ["paragraph", "table"]) {
      const text = kind === "table" ? `<table><tr><td>${"😀中文".repeat(300)}</td></tr></table>` : "😀中文".repeat(300);
      const value = { ...pkg, blocks: [{ ...pkg.blocks[0], kind, text }] };
      const chunks = extractionChunks(value, 100);
      const encoding = get_encoding("cl100k_base");
      try {
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.map(chunk => chunk.pageContent).join("")).toBe(text);
        for (const chunk of chunks) {
          expect(encoding.encode(chunk.pageContent).length).toBeLessThanOrEqual(100);
          expect(chunk.pageContent).not.toContain("�");
          expect(chunk.metadata.pages).toEqual([7]);
        }
      } finally { encoding.free(); }
    }
  });

  it("counts trailing page separators without creating an extra page or assigning the next page to a chunk", () => {
    const text = "# One\nPage one.\n<!-- PageBreak -->\n# Two\nPage two.\n<!-- PageBreak -->";
    expect(legacySourcePages(text)).toHaveLength(2);
    expect(legacyChunks(text).map(chunk => chunk.metadata.pages)).toEqual([[1], [2]]);
  });
});
