import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import {
  applyCanonicalizationDecisions, findCanonicalizationPairs, type CanonicalizationPair,
} from "../src/processors/evidence/evidenceCanonicalization.ts";
import { formatEvidenceContent } from "../src/processors/evidence/evidenceContent.ts";

const date = (day: string | null = "5") => ({ year: "2025", month: "3", day, season: null, quarter: null });
const quote = "Casey paid 250 dollars for invoice 17.";
function event(overrides: Record<string, unknown> = {}): Document {
  const metadata = {
    what: "Casey paid 250 dollars.", who: ["Casey"], where: "Unknown", why: "Unknown",
    whenStarted: date(), whenEnded: null,
    tags: ["fact", "event", "eventType:payment", "facet:financial:invoice"],
    accountId: "account-1", sourceId: "source-1", sourceContentHash: "source-hash", evidenceSchemaVersion: "3",
    pages: [1], sourceOffset: 0, sourceQuote: quote,
    sourceSpans: [{ pageNumber: 1, sourceOffset: 0, sourceQuote: quote }],
    extractedBy: ["primary:example"], ...overrides,
  };
  return new Document({ metadata, pageContent: formatEvidenceContent(metadata) });
}

describe("document-level evidence canonicalization", () => {
  it("keeps the richer paraphrase and all citations and extractor provenance", () => {
    const first = event();
    const second = event({ what: "Casey paid 250 dollars for invoice 17.", why: "Invoice 17",
      sourceSpans: [...first.metadata.sourceSpans,
        { pageNumber: 2, sourceOffset: 5, sourceQuote: "Invoice 17 was due." }],
      pages: [1, 2], extractedBy: ["independent:example"] });
    const before = JSON.stringify([first, second]);
    const pairs = findCanonicalizationPairs([first, second]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].allowedSurvivors).toEqual(["right"]);
    const result = applyCanonicalizationDecisions([first, second], pairs,
      [{ pairId: pairs[0].id, survivor: "right", leftOnlyDetails:[],rightOnlyDetails:[],reason: "Same payment; richer invoice detail." }]);

    expect(result.documents).toHaveLength(1);
    expect(result.applied).toHaveLength(1);
    expect(result.documents[0].metadata.what).toBe(second.metadata.what);
    expect(result.documents[0].metadata.sourceSpans).toEqual(second.metadata.sourceSpans);
    expect(result.documents[0].metadata.extractedBy).toEqual(["independent:example", "primary:example"]);
    expect(result.documents[0].pageContent).toBe(formatEvidenceContent(result.documents[0].metadata));
    expect(JSON.stringify([first, second])).toBe(before);
  });

  it("lets a detail-rich record dominate a partial paraphrase and unions compatible fields", () => {
    const sourceQuote = "On March 10, 2025, Morgan emailed the payment record to Dana Fox.";
    const sourceSpan = { pageNumber: 1, sourceOffset: 0, sourceQuote };
    const exactDate = date("10");
    const rich = event({ what: "Morgan emailed the payment record to Dana Fox.",
      who: ["Morgan", "Dana Fox"], whenStarted: exactDate,
      sourceQuote, sourceOffset: 0, pages: [1], sourceSpans: [sourceSpan] });
    const partial = event({ what: "Morgan emailed the payment record.",
      who: ["Morgan"], whenStarted: { year: null, month: null, day: null, season: null, quarter: null },
      sourceQuote, sourceOffset: 0, pages: [1], sourceSpans: [sourceSpan] });

    const pairs = findCanonicalizationPairs([rich, partial]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].allowedSurvivors).toEqual(["left"]);
    const result = applyCanonicalizationDecisions([rich, partial], pairs, [{ pairId: pairs[0].id,
      survivor: "left", leftOnlyDetails: ["to Dana Fox"], rightOnlyDetails: [], reason: "Same email; the retained record preserves its recipient." }]);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.what).toBe(rich.metadata.what);
    expect(result.documents[0].metadata.who).toEqual(["Morgan", "Dana Fox"]);
    expect(result.documents[0].metadata.whenStarted).toEqual(exactDate);
    expect(result.documents[0].metadata.sourceSpans).toEqual([sourceSpan]);
  });

  it("reviews a short communication description against a fuller statement at the same utterance", () => {
    const sourceQuote = 'On March 12, W-17 told investigator Dana, "I saw Avery remove the folder."';
    const short = event({what:"Morgan spoke to investigator Dana.",who:["Morgan","Dana"],
      tags:["fact","event","eventType:communication"],sourceQuote:sourceQuote.slice(0, 43),
      sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:sourceQuote.slice(0,43)}]});
    const full = event({what:"Morgan told investigator Dana that Morgan saw Avery remove the folder.",
      who:["Morgan","Dana","Avery"],tags:["fact","event","eventType:communication"],
      sourceQuote,sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote}]});
    const pairs = findCanonicalizationPairs([short,full]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].allowedSurvivors).toEqual(["right"]);
  });

  it("reviews a bare communication against a fuller denial of the utterance content", () => {
    const sourceQuote = 'Riley told investigator Dana, "Avery did not remove the folder."';
    const short = event({what:"Riley spoke to investigator Dana.",who:["Riley","Dana"],
      tags:["fact","event","eventType:communication"],sourceQuote:sourceQuote.slice(0, 28),
      sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:sourceQuote.slice(0,28)}]});
    const full = event({what:"Riley told investigator Dana that Avery did not remove the folder.",
      who:["Riley","Dana","Avery"],tags:["fact","event","eventType:communication"],
      sourceQuote,sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote}]});
    const pairs = findCanonicalizationPairs([short,full]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].allowedSurvivors).toEqual(["right"]);
  });

  it("retains the source-defined witness code when merging two versions of one utterance", () => {
    const sourceQuote = 'W-17 told investigator Dana Fox, "I saw Avery Patel remove the folder."';
    const support = {pageNumber:2,sourceOffset:0,sourceQuote:"Witness code W-17 identifies Morgan Hale."};
    const common = {tags:["fact","event","eventType:communication"],sourceQuote,
      sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote},support],pages:[1,2]};
    const documents = [
      event({...common,what:"Morgan Hale told investigator Dana Fox that Morgan saw Avery Patel remove the folder.",
        who:["Morgan Hale","Dana Fox","Avery Patel"]}),
      event({...common,what:"Morgan Hale (W-17) told investigator Dana Fox that Morgan saw Avery Patel remove the folder.",
        who:["Morgan Hale","Dana Fox","Avery Patel"]}),
    ];
    const pairs = findCanonicalizationPairs(documents);
    expect(pairs).toHaveLength(1);
    const applied = applyCanonicalizationDecisions(documents,pairs,[{pairId:pairs[0].id,survivor:"right",
      leftOnlyDetails:[],rightOnlyDetails:["(W-17)"],reason:"One cited communication; the code identifies Morgan."}]);
    expect(applied.documents).toHaveLength(1);
    expect(applied.documents[0].metadata.what).toBe(documents[1].metadata.what);
  });

  it("merges a bare speaking record into its content-rich occurrence without absorbing a second action", () => {
    const sourceQuote = 'W-22 told investigator Dana Fox, "Avery Patel did not remove the folder."';
    const common = {tags:["fact","event","eventType:communication"],sourceQuote,
      sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote}]};
    const short = event({...common,what:"Riley Chen spoke to investigator Dana Fox.",who:["Riley Chen","Dana Fox"]});
    const full = event({...common,
      what:"Riley Chen told investigator Dana Fox that Avery Patel did not remove the folder.",
      who:["Riley Chen","Dana Fox","Avery Patel"]});
    const pairs = findCanonicalizationPairs([short,full]);
    expect(pairs).toHaveLength(1);
    expect(applyCanonicalizationDecisions([short,full],pairs,[{pairId:pairs[0].id,survivor:"right",
      leftOnlyDetails:[],rightOnlyDetails:["Avery Patel did not remove the folder."],
      reason:"The single cited utterance contains this denial."}]).documents).toHaveLength(1);

    const compound = event({...common,
      what:"Riley Chen told investigator Dana Fox that Avery Patel did not remove the folder and mailed a letter.",
      who:["Riley Chen","Dana Fox","Avery Patel"]});
    const supplied: CanonicalizationPair[] = [{id:"0:1",leftIndex:0,rightIndex:1,similarity:0.8,
      allowedSurvivors:["right"]}];
    expect(applyCanonicalizationDecisions([short,compound],supplied,[{pairId:"0:1",survivor:"right",
      leftOnlyDetails:[],rightOnlyDetails:["Avery Patel did not remove the folder and mailed a letter"],
      reason:"Reviewer claimed this was one action."}]).documents).toHaveLength(2);
  });

  it("does not propose a paraphrase merge when partial dates contradict", () => {
    const march = event({whenStarted:{year:"2025",month:"3",day:null,quarter:null}});
    const fourthQuarter = event({what:"A payment of 250 dollars was made by Casey.",
      whenStarted:{year:"2025",month:null,day:null,quarter:"Q4"}});
    expect(findCanonicalizationPairs([march, fourthQuarter])).toEqual([]);
  });

  it("retains separate dates, amounts, people, locations, accounts and pages", () => {
    const base = event();
    const variants = [
      event({ whenStarted: date("6") }),
      event({ what: "Casey paid 350 dollars for invoice 17." }),
      event({ what: "Casey may have paid 250 dollars." }),
      event({ what: "Casey did not pay 250 dollars." }),
      event({ who: ["Jordan"] }),
      event({ accountId: "account-2" }),
      event({ pages: [2], sourceOffset: 0, sourceSpans: [{ pageNumber: 2, sourceOffset: 0, sourceQuote: quote }] }),
    ];
    for (const variant of variants) expect(findCanonicalizationPairs([base, variant])).toHaveLength(0);
    expect(findCanonicalizationPairs([event({ where: "School" }), event({ where: "Office" })])).toHaveLength(0);
  });

  it("never proposes merges across conflicting claimants or polarity", () => {
    const base = { tags: ["claim"], claimType: "allegation", claimant: "Casey", claimPolarity: "asserts",
      who: ["Jordan"] };
    const first = event(base);
    const variants = [
      event({ ...base, claimant: "Jordan" }),
      event({ ...base, claimPolarity: "denies" }),
    ];
    for (const variant of variants) expect(findCanonicalizationPairs([first, variant])).toHaveLength(0);
  });

  it("does not merge a high-similarity pair without an affirmative review", () => {
    const first = event({ what: "Casey's reading score was 97." });
    const second = event({ what: "Casey's writing score was 97." });
    const pairs = findCanonicalizationPairs([first, second]);
    expect(pairs).toHaveLength(1);
    expect(applyCanonicalizationDecisions([first, second], pairs, []).documents).toHaveLength(2);
  });

  it.each([
    "Casey attended the course and passed the examination.",
    "Casey attended the course; Casey passed the examination.",
    "Casey attended the course. Casey passed the examination.",
    "Casey attended the course, but Casey failed the examination.",
  ])("blocks atomic-to-compound merges at application even with forged approvals: %s", compound => {
    const documents = [event({what:"Casey attended the course."}), event({what:compound})];
    const pairs: CanonicalizationPair[] = [{id:"0:1",leftIndex:0,rightIndex:1,similarity:0.9,allowedSurvivors:["left","right"]}];
    for (const survivor of ["left","right"] as const) {
      const result = applyCanonicalizationDecisions(documents,pairs,[{pairId:"0:1",survivor,leftOnlyDetails:[],rightOnlyDetails:[],reason:"Contains the same words."}]);
      expect(result.applied).toEqual([]);
      expect(result.documents).toEqual(documents);
    }
  });

  it("still merges an identical compound record and same-result numeric enrichment", () => {
    for (const statements of [["Casey attended and passed the course.","Casey attended and passed the course."],
      ["Casey's reading score was 97.","Casey's reading score was 97, percentile 42, classified as average."]]) {
      const assessment = statements[0].includes("score");
      const documents = statements.map(what => event({what,...(assessment ? {factType:"assessmentResult"} : {})}));
      const pairs = findCanonicalizationPairs(documents);
      const result = applyCanonicalizationDecisions(documents,pairs,[{pairId:"0:1",survivor:"right",leftOnlyDetails:[],
        rightOnlyDetails:assessment ? ["percentile 42","classified as average"] : [],reason:"Same assertion, all details retained."}]);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.what).toBe(statements[1]);
    }
  });

  it("reviews differing facet sets and preserves every facet only after approval", () => {
    const first = event({tags:["fact","event","eventType:payment","facet:financial:invoice"]});
    const second = event({what:"Casey paid 250 dollars as a payment.",
      tags:["fact","event","eventType:payment","facet:procedural:paymentRecorded"]});
    const pairs = findCanonicalizationPairs([first,second]);
    expect(pairs).toHaveLength(1);
    expect(applyCanonicalizationDecisions([first,second],pairs,[]).documents).toHaveLength(2);
    const merged = applyCanonicalizationDecisions([first,second],pairs,[{
      pairId:pairs[0].id,survivor:"left",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Same cited payment; both indexing facets apply."}]);
    expect(merged.documents).toHaveLength(1);
    expect(merged.documents[0].metadata.tags).toEqual(expect.arrayContaining([
      "facet:financial:invoice","facet:procedural:paymentRecorded"]));
    expect(merged.documents[0].pageContent).toBe(formatEvidenceContent(merged.documents[0].metadata));
    const otherType = event({...second.metadata,tags:["fact","event","eventType:refund"]});
    expect(findCanonicalizationPairs([first,otherType])).toHaveLength(1);
    for (const overrides of [{who:["Jordan"]},{whenStarted:date("6")},
      {what:"Casey may have paid 250 dollars."}]) {
      const different = event({...second.metadata,...overrides});
      expect(findCanonicalizationPairs([first,different])).toHaveLength(0);
    }
  });

  it("rejects a reviewer's incompatible survivor and incomplete transitive cluster", () => {
    const documents = [event(), event({ what: "Casey made a payment of 250 dollars." }),
      event({ what: "A payment of 250 dollars was made by Casey." })];
    const pairs: CanonicalizationPair[] = [
      { id: "0:1", leftIndex: 0, rightIndex: 1, similarity: 0.9, allowedSurvivors: ["left", "right"] },
      { id: "1:2", leftIndex: 1, rightIndex: 2, similarity: 0.8, allowedSurvivors: ["left", "right"] },
    ];
    const result = applyCanonicalizationDecisions(documents, pairs, [
      { pairId: "0:1", survivor: "left", leftOnlyDetails:[],rightOnlyDetails:[],reason: "Same payment." },
      { pairId: "1:2", survivor: "left", leftOnlyDetails:[],rightOnlyDetails:[],reason: "Same payment." },
    ]);
    expect(result.documents).toHaveLength(2);
    expect(result.applied).toHaveLength(1);

    const incompatible = findCanonicalizationPairs([event(), event({ what: "Casey paid 250 dollars for invoice 17.",
      why: "Invoice 17" })]);
    expect(incompatible[0].allowedSurvivors).toEqual(["right"]);
    expect(applyCanonicalizationDecisions([event(), event({ what: "Casey paid 250 dollars for invoice 17.",
      why: "Invoice 17" })], incompatible,
    [{ pairId: incompatible[0].id, survivor: "left", leftOnlyDetails:[],rightOnlyDetails:[],reason: "Wrong direction." }]).documents).toHaveLength(2);
  });

  it("requires every cluster member to approve the actual surviving statement", () => {
    const documents = [event({what:"Casey completed the report."}),event({what:"Casey finished the report."}),
      event({what:"Casey completed the report for the board."})];
    const pairs: CanonicalizationPair[] = [
      {id:"0:1",leftIndex:0,rightIndex:1,similarity:0.9,allowedSurvivors:["left","right"]},
      {id:"1:2",leftIndex:1,rightIndex:2,similarity:0.8,allowedSurvivors:["left","right"]},
      {id:"0:2",leftIndex:0,rightIndex:2,similarity:0.7,allowedSurvivors:["right"]},
    ];
    const result = applyCanonicalizationDecisions(documents,pairs,[
      {pairId:"0:1",survivor:"left",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Same report."},
      {pairId:"1:2",survivor:"left",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Reviewer approved this direction."},
      {pairId:"0:2",survivor:"right",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Only right retains the recipient."},
    ]);
    expect(result.applied).toEqual([{pairId:"0:1",survivorIndex:0,removedIndex:1}]);
    expect(result.documents.map(document => document.metadata.what)).toEqual([
      "Casey completed the report.","Casey completed the report for the board."]);
  });
});
