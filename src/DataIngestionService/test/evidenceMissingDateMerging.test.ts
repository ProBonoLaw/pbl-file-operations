import {Document} from "@langchain/core/documents";
import {describe, expect, it} from "vitest";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.ts";
import {applyCanonicalizationDecisions, findCanonicalizationPairs, hasAddedAssertionBoundary} from "../src/processors/evidence/evidenceCanonicalization.ts";
import {partitionIdentityDecisions} from "../src/processors/evidence/evidenceIdentityReview.ts";
import {missingDateComparison} from "../src/processors/evidence/evidenceMissingDate.ts";

const plain = "Casey was evaluated by a doctor.";
const detail = "the date of the evaluation is unstated";
const annotated = `Casey was evaluated by a doctor; ${detail}.`;
const quote = "Casey was evaluated by a doctor and received a recommendation for tutoring.";
function fixture(what = annotated, citation = quote) {
  const source = new EvidenceSource(new Document({pageContent:citation,metadata:{pages:[1]}}));
  const docs = [plain,what].map((what,index) => new Document({pageContent:what,metadata:{
    accountId:"account",sourceId:"report",sourceContentHash:source.contentHash,what,who:["Casey","doctor"],
    subject:["Casey"],reportedBy:[],factType:"undatedOccurrence",tags:["fact",`facet:context${index}`],
    where:"Unknown",why:"Unknown",whenStarted:{year:null,month:null,day:null,season:null,quarter:null},whenEnded:null,
    asOf:null,pages:[1],sourceQuote:citation,sourceOffset:0,sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:citation}],
  }}));
  return {docs,source};
}
function review(docs: Document[], source: EvidenceSource, inventories: string[][] = [[],[]], relation = "same_assertion") {
  const pairs = findCanonicalizationPairs(docs,{source});
  const rows = pairs.map(pair => ({pairId:pair.id,relation,reason:"Same cited evaluation, with no timing in either record.",
    leftOnlyDetails:inventories[0],rightOnlyDetails:inventories[1],
    semanticAssessment:{relationship:"equivalent",contextualDetails:[]},metadataResolutions:[]}));
  const partition = partitionIdentityDecisions(pairs,rows,docs,source);
  const accepted = partition.valid.flatMap(row => row.survivor === "none" ? [] : [{...row,survivor:row.survivor}]);
  return {pairs,rows,partition,merged:applyCanonicalizationDecisions(docs,pairs,accepted,source)};
}

describe("missing-date annotations on the same undated assertion", () => {
  it.each([[false,false],[false,true],[true,false],[true,true]])(
    "merges while preserving wording and evidence (reverse=%s, inventoried=%s)", (reverse,inventoried) => {
      const {docs,source} = fixture();
      if (reverse) docs.reverse();
      const inventories = inventoried ? (reverse ? [[detail],[]] : [[],[detail]]) : [[],[]];
      const result = review(docs,source,inventories);
      expect(result.pairs).toHaveLength(1);
      expect(result.partition.errors.size).toBe(0);
      expect(result.partition.valid[0].verdict).toBe("duplicate");
      expect(result.merged.documents).toHaveLength(1);
      expect([plain,annotated]).toContain(result.merged.documents[0].metadata.what);
      expect(result.merged.documents[0].metadata.tags).toEqual(expect.arrayContaining(docs.flatMap(doc=>doc.metadata.tags)));
      expect(result.merged.documents[0].metadata.sourceSpans).toEqual(docs[0].metadata.sourceSpans);
      expect(result.merged.documents[0].metadata.whenStarted.year).toBeNull();
    });

  it.each([
    "Casey was evaluated by a doctor. The date is unknown.",
    "Casey was evaluated by a doctor; the evaluation date was not recorded.",
    "Casey was evaluated by a doctor and the date is not specified in the report.",
    "Casey was evaluated by a doctor; the date is unspecified.",
  ])("does not treat date-absence wording as negation or another assertion: %s", text => {
    const {docs,source} = fixture(text);
    expect(review(docs,source).merged.documents).toHaveLength(1);
  });

  it("applies the same rule outside evaluation records", () => {
    const {docs,source} = fixture("Casey was interviewed; the date of the interview is unstated.","Casey was interviewed.");
    docs[0].metadata.what = "Casey was interviewed.";
    expect(review(docs,source).merged.documents).toHaveLength(1);
  });

  it.each(["independent_assertions","uncertain"])("requires occurrence identity even with matching text: %s", relation => {
    const {docs,source} = fixture();
    expect(review(docs,source,[[],[]],relation).merged.applied).toEqual([]);
  });

  it("requires a modern semantic assessment at review and application", () => {
    const {docs,source} = fixture(), {pairs,rows} = review(docs,source);
    const legacy = rows.map(({semanticAssessment:_assessment,...row})=>row);
    expect(partitionIdentityDecisions(pairs,legacy,docs,source).valid[0].verdict).not.toBe("duplicate");
    expect(applyCanonicalizationDecisions(docs,pairs,[{pairId:pairs[0].id,survivor:"left",reason:"Legacy approval",
      leftOnlyDetails:[],rightOnlyDetails:[]}],source).applied).toEqual([]);
    expect(hasAddedAssertionBoundary(plain,annotated)).toBe(true);
  });

  it.each(["whenStarted","whenEnded","asOf"])("does not waive a known %s date on either side", field => {
    for (const index of [0,1]) {
      const {docs,source} = fixture();
      docs[index].metadata[field] = {year:"2018",month:null,day:null};
      expect(missingDateComparison(docs[0].metadata,docs[1].metadata)).toBeNull();
      expect(review(docs,source).merged.applied).toEqual([]);
    }
  });

  it.each([
    {status:"dated",relation:"bounded",start:{year:"2018"},end:{year:"2019"}},
    {status:"conflict",relation:"unknown"},
    {status:"unknown",relation:"duration",qualifier:"for three months"},
  ])("preserves resolved, conflicting, and relative timing: %j", resolution => {
    const {docs} = fixture();
    docs[0].metadata.eventDateResolution = resolution;
    expect(missingDateComparison(docs[0].metadata,docs[1].metadata)).toBeNull();
  });

  it.each(["on July 18, 2018","on 04/05/2018","in 2018","on Monday","last year","after school"])(
    "does not ignore timing in the statements: %s", timing => {
      const {docs,source} = fixture(`Casey was evaluated by a doctor ${timing}; ${detail}.`);
      docs[0].metadata.what = `Casey was evaluated by a doctor ${timing}.`;
      expect(missingDateComparison(docs[0].metadata,docs[1].metadata)).toBeNull();
      expect(review(docs,source).merged.applied).toEqual([]);
    });

  it.each([
    "Casey was evaluated by a doctor; the date of the arrest is unstated.",
    "Casey was evaluated by a doctor; whether the evaluation occurred is unknown.",
    "Casey was evaluated by a doctor; the date is unknown and the doctor recommended tutoring.",
    "Casey was evaluated by a doctor and received therapy; the date is unknown.",
    "Casey was not evaluated by a doctor; the date is unknown.",
    "Casey may have been evaluated by a doctor; the date is unknown.",
  ])("does not hide another assertion, occurrence uncertainty, or changed polarity: %s", text => {
    const {docs,source} = fixture(text);
    expect(missingDateComparison(docs[0].metadata,docs[1].metadata)).toBeNull();
    expect(review(docs,source).merged.applied).toEqual([]);
  });

  it.each(["accountId","sourceId","sourceContentHash"])("requires matching %s", field => {
    const {docs,source} = fixture();
    docs[1].metadata[field] = "other";
    expect(review(docs,source).merged.applied).toEqual([]);
    expect(missingDateComparison(docs[0].metadata,docs[1].metadata)).toBeNull();
  });

  it("requires shared primary support even when the source page matches", () => {
    const {docs,source} = fixture();
    docs[1].metadata.sourceOffset = quote.length;
    docs[1].metadata.sourceSpans[0].sourceOffset = quote.length;
    expect(missingDateComparison(docs[0].metadata,docs[1].metadata)).toBeNull();
    expect(review(docs,source).merged.applied).toEqual([]);
  });
});
