import {Document} from "@langchain/core/documents";
import {describe, expect, it} from "vitest";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.ts";
import {unreportedContainmentDetails} from "../src/processors/evidence/evidenceAtomicity.ts";
import {applyCanonicalizationDecisions, findCanonicalizationPairs} from "../src/processors/evidence/evidenceCanonicalization.ts";
import {partitionIdentityDecisions} from "../src/processors/evidence/evidenceIdentityReview.ts";

const quote = "Casey was tested and interviewed during two sessions (7/18/18, 8/21/18).";
const header = "Examiner: Jordan Lane.";
function fixture(subset = false) {
  const source = new EvidenceSource(new Document({pageContent:quote + "\n\n" + header,metadata:{pages:[1]}}));
  const primary = {pageNumber:1,sourceOffset:0,sourceQuote:quote};
  const context = {pageNumber:1,sourceOffset:quote.length + 2,sourceQuote:header};
  const docs = ["Casey was interviewed during a session.",
    "Casey was interviewed during an evaluation session on July 18, 2018."].map(what => new Document({pageContent:what,
    metadata:{accountId:"account",sourceId:"report",sourceContentHash:source.contentHash,what,who:["Casey"],
      where:"Unknown",why:"Unknown",whenStarted:{year:"2018",month:"7",day:"18"},whenEnded:null,
      eventType:"communication",tags:["event","fact"],pages:[1],sourceQuote:quote,sourceOffset:0,sourceSpans:[primary]}}));
  if (subset) docs[1].metadata.sourceSpans.push(context);
  return {source,docs};
}

describe("same occurrence with matching or subset source citations", () => {
  it.each([[false,false],[false,true],[true,false],[true,true]])(
    "retains the dated wording and every citation (subset=%s, reverse=%s)", (subset,reverse) => {
      const {source,docs} = fixture(subset);
      const richer = docs[1], originalSpans = docs.flatMap(doc => doc.metadata.sourceSpans);
      if (reverse) docs.reverse();
      const pairs = findCanonicalizationPairs(docs,{source});
      expect(pairs).toHaveLength(1);
      const side = reverse ? "left" : "right";
      const decision = {pairId:pairs[0].id,relation:"same_assertion",reason:"The same interview with matching structured dates.",
        leftOnlyDetails:reverse ? ["on July 18, 2018"] : [],rightOnlyDetails:reverse ? [] : ["on July 18, 2018"],
        semanticAssessment:{relationship:reverse ? "left_entails_right" : "right_entails_left",contextualDetails:[{
          side,detail:"on July 18, 2018",kind:"occasion",sourceQuote:quote,explanation:"The already dated interview occasion."}]}};
      const partition = partitionIdentityDecisions(pairs,[decision],docs,source);
      expect(partition.errors.size).toBe(0);
      expect(partition.valid[0]).toMatchObject({verdict:"duplicate",survivor:side});
      const accepted = partition.valid.flatMap(row => row.survivor === "none" ? [] : [{...row,survivor:row.survivor}]);
      const merged = applyCanonicalizationDecisions(docs,pairs,accepted,source);
      expect(merged.documents).toHaveLength(1);
      expect(merged.documents[0].metadata.what).toBe(richer.metadata.what);
      expect(merged.documents[0].metadata.sourceSpans).toEqual(expect.arrayContaining(originalSpans));
      expect(merged.documents[0].metadata.whenStarted).toMatchObject({year:"2018",month:"7",day:"18"});
    });

  it.each(["independent_assertions","uncertain"])("does not merge on a citation subset with a %s assessment", relation => {
    const {source,docs} = fixture(true), pairs = findCanonicalizationPairs(docs,{source});
    expect(applyCanonicalizationDecisions(docs,pairs,[],source).applied).toEqual([]);
    const partition = partitionIdentityDecisions(pairs,[{pairId:pairs[0].id,relation,
      reason:"The source does not establish the same occurrence.",leftOnlyDetails:[],rightOnlyDetails:[]}],docs,source);
    expect(partition.valid[0].verdict).not.toBe("duplicate");
  });

  it("keeps different structured interview dates separate despite identical wording and citations", () => {
    const {source,docs} = fixture(true);
    docs[1].metadata.what = docs[0].metadata.what;
    docs[1].metadata.whenStarted = {year:"2018",month:"8",day:"21"};
    expect(findCanonicalizationPairs(docs,{source})).toEqual([]);
  });

  it.each(["July 18, 2018","July 18 2018","18 July 2018","07/18/2018","August 21, 2018"])(
    "does not treat formatting inside %s as an added clause", date => {
      expect(unreportedContainmentDetails({what:"Casey was interviewed during a session."},
        {what:`Casey was interviewed during an evaluation session on ${date}.`},[],[`on ${date}`])).toEqual([]);
    });

  it.each([", passed an examination", " and passed an examination", "; passed an examination"])(
    "still detects an omitted outcome after a date: %s", addition => {
      expect(unreportedContainmentDetails({what:"Casey attended training."},
        {what:`Casey attended training on July 18, 2018${addition}.`},[],["on July 18, 2018"])
        .some(issue => issue.includes("passed"))).toBe(true);
    });
});
