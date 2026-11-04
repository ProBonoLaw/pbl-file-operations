import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { duplicateEmbeddingInputs, findDocumentDuplicateCandidates } from "../src/processors/evidence/evidenceDocumentDeduplication.ts";
import { applyCanonicalizationDecisions, findCanonicalizationPairs } from "../src/processors/evidence/evidenceCanonicalization.ts";
import { partitionIdentityDecisions } from "../src/processors/evidence/evidenceIdentityReview.ts";

const quote = "During Casey's birth, his mother went into shock.";
function record(what: string, overrides: Record<string, unknown> = {}) {
  return new Document({pageContent: what, metadata: {accountId: "account", sourceId: "source", sourceContentHash: "hash",
    what, who: ["Casey's mother"], subject: ["Casey's mother"], reportedBy: [], factType: "attribute",
    where: "Unknown", why: "Unknown", tags: ["fact"], pages: [1], sourceQuote: quote, sourceOffset: 0,
    sourceSpans: [{pageNumber: 1, sourceQuote: quote, sourceOffset: 0}], ...overrides}});
}
const context = {side: "right", detail: "at his birth", kind: "occasion", sourceQuote: quote,
  explanation: "The cited birth is the occasion of the same maternal shock, not a second occurrence."};
function assess(documents: Document[], changes: Record<string, unknown> = {}) {
  const pairs = findCanonicalizationPairs(documents);
  const rows = pairs.map(pair => ({pairId: pair.id, relation: "same_assertion",
    leftOnlyDetails: [], rightOnlyDetails: ["at his birth"], reason: "Same maternal shock; retain the cited occasion.",
    semanticAssessment: {relationship: "right_entails_left", contextualDetails: [context]}, ...changes}));
  const partition = partitionIdentityDecisions(pairs, rows, documents);
  const decisions = partition.valid.flatMap(row => row.verdict === "duplicate" && row.survivor !== "none" ? [{...row, survivor: row.survivor}] : []);
  return {...applyCanonicalizationDecisions(documents, pairs, decisions), partition, pairs, decisions};
}
const occurrence = () => [record("Casey's mother went into shock."), record("Casey's mother went into shock at his birth.")];

describe("semantic duplicate retrieval", () => {
  const paraphrases = () => [record("The company terminated Casey."), record("Casey was fired by the employer.", {
    sourceOffset: 100, sourceQuote: "The employer fired Casey.", sourceSpans: [{pageNumber: 1, sourceOffset: 100, sourceQuote: "The employer fired Casey."}]})];
  it("adds embedding-only paraphrases without merging on cosine similarity", () => {
    const documents = paraphrases();
    expect(findDocumentDuplicateCandidates(documents)).toHaveLength(0);
    const candidates = findDocumentDuplicateCandidates(documents, {vectors: [[1, 0], [0.96, 0.04]]});
    expect(candidates).toHaveLength(1);
    expect(candidates[0].matchReasons).toEqual(["embedding"]);
    const pairs = findCanonicalizationPairs(documents, {vectors: [[1, 0], [0.96, 0.04]]});
    expect(pairs).toHaveLength(1);
    expect(applyCanonicalizationDecisions(documents, pairs, []).documents).toHaveLength(2);
  });
  it("embeds assertions without classification tags or extraneous quotation content", () => {
    const documents = paraphrases();
    documents[0].metadata.tags.push("claim", "facet:secret:label");
    expect(duplicateEmbeddingInputs(documents)).toEqual(documents.map(doc => doc.metadata.what));
  });
  it.each([{accountId: "other"}, {sourceId: "other"}, {sourceContentHash: "other"},
    {pages: [2, 1], sourceSpans: [{pageNumber: 2, sourceOffset: 0, sourceQuote: quote}]}])(
    "keeps cosine candidates within account/source/revision/primary page: %j", change => {
      const documents = paraphrases(); Object.assign(documents[1].metadata, change);
      expect(findDocumentDuplicateCandidates(documents, {vectors: [[1, 0], [1, 0]]})).toHaveLength(0);
    });
  it.each([null, [0, 0], [NaN, 1], [Infinity, 1]])("retains lexical candidates when a vector is unusable: %j", vector => {
    expect(findDocumentDuplicateCandidates(occurrence(), {vectors: [[1, 0], vector]})).toHaveLength(1);
    expect(findDocumentDuplicateCandidates(paraphrases(), {vectors: [[1, 0], vector]})).toHaveLength(0);
  });
  it("validates vector alignment and dimensions", () => {
    expect(() => findDocumentDuplicateCandidates(paraphrases(), {vectors: [[1]]})).toThrow(/align/);
    expect(() => findDocumentDuplicateCandidates(paraphrases(), {vectors: [[1], [1, 0]]})).toThrow(/dimensions/);
  });
  it("bounds semantic neighbors without removing lexical candidates", () => {
    const documents = ["alpha", "beta", "gamma", "delta"].map((word, i) => record(word, {
      sourceQuote: word, sourceOffset: i * 100, sourceSpans: [{pageNumber: 1, sourceOffset: i * 100, sourceQuote: word}]}));
    const pairs = findDocumentDuplicateCandidates(documents, {vectors: [[1, 0], [0.99, 0.01], [0.8, 0.2], [0.7, 0.3]], embeddingTopK: 1});
    expect(pairs.map(pair => pair.id).sort()).toEqual(["0:1", "2:3"]);
  });
  it("uses deterministic bounded neighbors for a dense page with 3072-dimensional vectors", () => {
    const documents = Array.from({length: 24}, (_, index) => record(`word${index}`, {
      sourceQuote: `quote${index}`, sourceOffset: index * 100,
      sourceSpans: [{pageNumber: 1, sourceOffset: index * 100, sourceQuote: `quote${index}`}],
    }));
    const vectors = documents.map(() => Array(3072).fill(1));
    const expected = new Set<string>();
    for (let index = 0; index < documents.length; index++) {
      const neighbors = documents.flatMap((_, other) => other === index ? []
        : [`${Math.min(index, other)}:${Math.max(index, other)}`]).sort((a, b) => a.localeCompare(b));
      neighbors.slice(0, 2).forEach(id => expected.add(id));
    }
    const pairs = findDocumentDuplicateCandidates(documents, {vectors, embeddingTopK: 2});
    expect(pairs.map(pair => pair.id).sort()).toEqual([...expected].sort());
    expect(pairs.every(pair => pair.embeddingSimilarity! <= 1)).toBe(true);
    expect(vectors[0]).toEqual(Array(3072).fill(1));
  });
});

describe("source-grounded semantic enrichment", () => {
  it.each([false,true])("retains a fact's subject when fuller claim wording identifies that person in Who (reverse=%s)", reverse => {
    const sourceQuote="Casey Morgan was described as having no complications as a baby.";
    const fact=record("Casey had no complications as a baby.",{who:["Casey Morgan"],subject:["Casey Morgan"],sourceQuote,
      sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote}]});
    const claim=record("Casey was described as having no complications as a baby.",{who:["Casey"],subject:undefined,
      factType:undefined,claimType:"factualAssertion",claimPolarity:"asserts",claimant:"Unknown",tags:["claim"],sourceQuote,
      sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote}]});
    const docs=reverse?[claim,fact]:[fact,claim], side=reverse?"left":"right";
    const result=assess(docs,{leftOnlyDetails:reverse?["was described as having"]:[],rightOnlyDetails:reverse?[]:["was described as having"],
      semanticAssessment:{relationship:reverse?"left_entails_right":"right_entails_left",contextualDetails:[{side,
        detail:"was described as having",kind:"attribution",sourceQuote,explanation:"The same source-reported condition, preserving the reporting frame."}]}});
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.what).toBe(claim.metadata.what);
    expect(result.documents[0].metadata).toMatchObject({factType:"attribute",subject:["Casey Morgan"],tags:expect.arrayContaining(["claim","fact"])});
  });

  it("does not fill a claim's missing subject from a different person", () => {
    const docs=[record("Casey had no complications.",{who:["Casey Morgan"],subject:["Casey Morgan"]}),
      record("Riley was described as having no complications.",{who:["Riley Morgan"],subject:undefined,factType:undefined,
        claimType:"factualAssertion",claimant:"Unknown",claimPolarity:"asserts",tags:["claim"]})];
    expect(findCanonicalizationPairs(docs)).toHaveLength(0);
  });

  it("merges fuller wording of the same assertion with a cited contextual assessment", () => {
    const result = assess(occurrence());
    expect(result.partition.errors.size).toBe(0);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.what).toBe(occurrence()[1].metadata.what);
    expect(result.decisions[0].semanticAssessment?.contextualDetails).toEqual([context]);
  });
  it("preserves the old conservative behavior without contextual proof", () => {
    expect(assess(occurrence(), {semanticAssessment: undefined}).documents).toHaveLength(2);
  });
  it.each(["contradictory", "related", "unrelated", "uncertain", "equivalent", "left_entails_right"])(
    "does not merge incompatible semantic outcomes or directions: %s", relationship => {
      expect(assess(occurrence(), {semanticAssessment: {relationship, contextualDetails: [context]}}).documents).toHaveLength(2);
    });
  it.each([{sourceQuote: "An invented quote."}, {detail: "at a later birth"}, {side: "left"}, {explanation: ""}])(
    "requires contextual evidence tied to the actual detail and side: %j", change => {
      expect(assess(occurrence(), {semanticAssessment: {relationship: "right_entails_left",
        contextualDetails: [{...context, ...change}]}}).documents).toHaveLength(2);
    });
  it("does not turn entailment of a component into atomic identity", () => {
    const documents = [record("Casey attended training."), record("Casey attended training and passed the exam.")];
    const result = assess(documents, {relation: "independent_assertions", rightOnlyDetails: ["passed the exam"],
      semanticAssessment: {relationship: "right_entails_left", contextualDetails: []}});
    expect(result.documents).toHaveLength(2);
    expect(result.partition.valid[0].verdict).toBe("distinct");
  });
  it("revalidates contextual proof and atomic identity when applying saved decisions", () => {
    const documents = occurrence(), valid = assess(documents);
    expect(valid.decisions).toHaveLength(1);
    const decision = valid.decisions[0];
    expect(applyCanonicalizationDecisions(documents, valid.pairs, [{...decision, relation: "independent_assertions"}]).documents).toHaveLength(2);
    expect(applyCanonicalizationDecisions(documents, valid.pairs, [{...decision, semanticAssessment: {
      relationship: "right_entails_left", contextualDetails: [{...decision.semanticAssessment!.contextualDetails[0], sourceQuote: "Invented"}]}}]).documents).toHaveLength(2);
  });
  it("does not use contextual justification to override a separate clause", () => {
    const documents = [record("Casey attended training."), record("Casey attended training and passed the exam.")];
    expect(assess(documents, {rightOnlyDetails: ["passed the exam"], semanticAssessment: {
      relationship: "right_entails_left", contextualDetails: [{...context, detail: "passed the exam"}]}}).documents).toHaveLength(2);
  });
});
