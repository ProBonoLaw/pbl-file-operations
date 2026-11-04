import {Document} from "@langchain/core/documents";
import {describe, expect, it} from "vitest";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.ts";
import {selectSourcePartitionHits, sourceLookupCitations, sourceRerankerCutoff} from "../src/processors/evidence/evidenceSourceRanking.ts";
import type {SourcePartitionHit} from "../src/processors/evidence/sourcePartitionSearch.ts";

const source = new EvidenceSource(new Document({pageContent: "Morgan scored 42.<!-- PageBreak -->The report was signed on May 3.",
  metadata: {pages: [1, 2], accountId: "account", sourceId: "source"}}));
const hit = (id: string, score?: number, page = 1): SourcePartitionHit => ({id, sourceId: "source", tags: [],
  content: source.pages[page - 1].text, metadata: "{}", pages: [page], contentOrigin: "extracted", rerankerScore: score});

describe("source reranker cutoff", () => {
  it.each(["", "off", "  off  "])("keeps the cutoff disabled for %j", value => expect(sourceRerankerCutoff(value)).toBeNull());
  it.each(["0", "2", "2.5", "4"])("accepts %s", value => expect(sourceRerankerCutoff(value)).toBe(Number(value)));
  it.each(["-1", "4.1", "NaN", "Infinity", "two"])("rejects %s", value => expect(() => sourceRerankerCutoff(value)).toThrow("0 to 4"));

  it("preserves order and missing scores, treats zero as a score, and includes the boundary", () => {
    const hits = [hit("zero", 0), hit("below", 1.99), hit("boundary", 2), hit("missing"), hit("high", 3)];
    expect(selectSourcePartitionHits(source, hits, null).hits).toEqual(hits);
    expect(selectSourcePartitionHits(source, hits, 2).hits.map(row => row.id)).toEqual(["boundary", "missing", "high"]);
  });

  it("protects verified primary and supporting quotations with normalized whitespace", () => {
    const primary = {...hit("primary", 0.5), content: "Morgan   scored 42."}, supporting = hit("support", 1, 2);
    const citations = [{pageNumber: 1, sourceOffset: 0, sourceQuote: "Morgan scored 42."},
      {pageNumber: 2, sourceQuote: "The report was signed on May 3."}];
    expect(selectSourcePartitionHits(source, [primary, supporting], 2, citations)).toEqual({hits: [primary, supporting], protectedHits: 2});
  });

  it("does not protect fabricated citations, wrong offsets/pages, or generated text", () => {
    const low = hit("low", 1);
    for (const citation of [
      {pageNumber: 1, sourceQuote: "Morgan scored 99."},
      {pageNumber: 1, sourceOffset: 5, sourceQuote: "Morgan scored 42."},
      {pageNumber: 2, sourceQuote: "Morgan scored 42."},
    ]) expect(selectSourcePartitionHits(source, [low], 2, [citation]).hits).toEqual([]);
    expect(selectSourcePartitionHits(source, [{...low, contentOrigin: "generated"}, {...low, pages: [2]}], 2,
      [{pageNumber: 1, sourceQuote: "Morgan scored 42."}]).hits).toEqual([]);
  });

  it("does not protect a partition that maps to another occurrence of the cited quotation", () => {
    const repeated = new EvidenceSource(new Document({
      pageContent: "Morgan scored 42. Then left.\n\nFiller paragraph.\n\nMorgan scored 42. Then won.",
      metadata: {pages: [1], accountId: "account", sourceId: "source"}}));
    const base = {sourceId: "source", tags: [], metadata: "{}", pages: [1], contentOrigin: "extracted" as const, rerankerScore: 1};
    const wrong = {...base, id: "wrong", content: "Morgan scored 42. Then left."};
    const cited = {...base, id: "cited", content: "Morgan scored 42. Then won."};
    const citation = {pageNumber: 1, sourceOffset: repeated.pages[0].text.lastIndexOf("Morgan"), sourceQuote: "Morgan scored 42."};
    expect(selectSourcePartitionHits(repeated, [wrong, cited], 2, [citation])).toEqual({hits: [cited], protectedHits: 1});
  });

  it("extracts original prompt citations while excluding retrieved and generated context", () => {
    const primary = {pageNumber: 1, sourceOffset: 0, sourceQuote: "Morgan scored 42."};
    const supporting = {pageNumber: 2, sourceQuote: "The report was signed on May 3."};
    expect(sourceLookupCitations(JSON.stringify({pairs: [{left: {evidenceContext: {primary, supportingQuotes: [supporting]}}}],
      retrievedContext: [{passages: [{pageNumber: 1, sourceQuote: "retrieved"}]}],
      unverifiedContext: [{pageNumber: 1, sourceQuote: "generated"}]}))).toEqual([primary, supporting]);
    expect(sourceLookupCitations("plain text")).toEqual([]);
  });
});
