import {Document} from "@langchain/core/documents";
import {describe, expect, it} from "vitest";
import {findCanonicalizationPairs, applyCanonicalizationDecisions} from "../src/processors/evidence/evidenceCanonicalization.ts";
import {compatibleIdentityDetail, identityMaterialDetails} from "../src/processors/evidence/evidenceAtomicity.ts";
import {partitionIdentityDecisions} from "../src/processors/evidence/evidenceIdentityReview.ts";

const sourceQuote = "The goal of this time is to create a warm, safe environment, and so parents should set aside expectations that might make these activities tenser.";
function recommendation(what: string, overrides: Record<string, unknown> = {}) {
  return new Document({pageContent: what, metadata: {accountId: "account", sourceId: "source", sourceContentHash: "hash",
    claimType: "opinion", claimant: "Jordan Lane, Ph.D.", claimPolarity: "asserts", tags: ["claim", "claimType:opinion"],
    what, who: ["Casey", "Casey's parents"], where: "Unknown", why: "Unknown", pages: [14], sourceQuote, sourceOffset: 0,
    sourceSpans: [{pageNumber: 14, sourceOffset: 0, sourceQuote}], ...overrides}});
}
const purpose = "because the goal is to create a warm, safe environment";
const richer = () => recommendation(`Jordan Lane recommends that Casey's parents set aside expectations that could make one-on-one activities tenser, ${purpose}.`);
const shorter = () => recommendation("Jordan Lane recommends that Casey's parents set aside expectations that might make their one-on-one activities with him tenser.");

describe("source-supported context of one assertion", () => {
  it.each([false, true])("merges an unattributed assessment across fact/claim labels, retaining the cited instrument (reverse=%s)", reverse => {
    const sourceQuote = "He performed comparably across both subtests.";
    const spans = [{pageNumber: 6, sourceOffset: 0, sourceQuote}, {pageNumber: 5, sourceOffset: 100,
      sourceQuote: "Casey completed the Child Learning Checklist (CLC)."}];
    const fact = recommendation("Casey performed comparably on the CLC Pattern and Picture subtests.", {
      claimType: undefined, claimant: undefined, claimPolarity: undefined, factType: "assessmentResult",
      who: ["Casey", "Jordan Lane, Ph.D."], subject: ["Casey"], reportedBy: ["Jordan Lane, Ph.D."],
      pages: [6, 5], sourceQuote, sourceSpans: spans, tags: ["fact", "factType:assessmentResult"]});
    const claim = recommendation("The source describes Casey's performance on Pattern and Picture as comparable.", {
      claimant: "Unknown", who: ["Casey"], pages: [6], sourceQuote, sourceSpans: [spans[0]]});
    const docs = reverse ? [claim, fact] : [fact, claim], pairs = findCanonicalizationPairs(docs);
    expect(pairs).toHaveLength(1);
    const side = pairs[0].leftIndex === docs.indexOf(fact) ? "left" : "right";
    const assessment = {pairId: pairs[0].id, relation: "same_assertion", leftOnlyDetails: side === "left" ? ["CLC"] : [],
      rightOnlyDetails: side === "right" ? ["CLC"] : [], reason: "Same cited result; the instrument is source-defined context."};
    const review = partitionIdentityDecisions(pairs, [assessment], docs).valid[0];
    expect(review).toMatchObject({verdict: "duplicate", survivor: side});
    const merged = applyCanonicalizationDecisions(docs, pairs, [{...review, survivor: side}]).documents;
    expect(merged).toHaveLength(1);
    expect(merged[0].metadata.what).toBe(fact.metadata.what);
    expect(merged[0].metadata.factType).toBe("assessmentResult");
    expect(merged[0].metadata.tags).toEqual(expect.arrayContaining(["fact", "claim"]));
    expect(merged[0].metadata.sourceSpans).toEqual(expect.arrayContaining(spans));
  });

  it.each(["no definition", "different passage", "different account", "different instrument"])("rejects an unverified instrument context: %s", variant => {
    const a = recommendation("Casey's CLC Pattern result was comparable.", {factType: "assessmentResult"});
    const b = recommendation("Casey's Pattern result was comparable.");
    a.metadata.sourceSpans.push({pageNumber: 5, sourceOffset: 100, sourceQuote: "Child Learning Checklist (CLC); Other Learning Checklist (OLC)."});
    if (variant === "no definition") a.metadata.sourceSpans.pop();
    if (variant === "different passage") {b.metadata.sourceOffset = 500; b.metadata.sourceSpans = [{pageNumber: 14, sourceOffset: 500, sourceQuote}];}
    if (variant === "different account") b.metadata.accountId = "other";
    if (variant === "different instrument") b.metadata.what = "Casey's OLC Pattern result was comparable.";
    expect(compatibleIdentityDetail("CLC", a.metadata, b.metadata)).toBe(false);
  });

  it.each([
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ].map(order => [order.join(","), order] as const))("merges the three recommendation variants into the one retaining its goal: %s", (_label, order) => {
    const base = recommendation("Jordan Lane recommends that parents set aside expectations that might make one-on-one activities tenser.", {
      who: ["Jordan Lane, Ph.D.", "Casey's parents"], tags: ["claim", "facet:recommendation"],
      sourceSpans: [{pageNumber: 14, sourceOffset: 0, sourceQuote}, {pageNumber: 3, sourceOffset: 100, sourceQuote: "Examiner: Jordan Lane, Ph.D."}], pages: [14, 3]});
    const originals = [base, richer(), shorter()];
    for (const doc of originals) doc.metadata.sourceSpans.push({pageNumber: 14, sourceOffset: 500,
      sourceQuote: "Parents should set aside one-on-one time with Casey."});
    const docs = order.map(i => originals[i]);
    const pairs = findCanonicalizationPairs(docs);
    expect(pairs).toHaveLength(3);
    const review = partitionIdentityDecisions(pairs, pairs.map(pair => ({pairId: pair.id, relation: "same_assertion",
      leftOnlyDetails: docs[pair.leftIndex] === originals[1] ? [purpose] : docs[pair.leftIndex] === originals[2] ? ["with him"] : [],
      rightOnlyDetails: docs[pair.rightIndex] === originals[1] ? [purpose] : docs[pair.rightIndex] === originals[2] ? ["with him"] : [],
      reason: "Same parent-child recommendation; the stated goal qualifies that action."})), docs);
    expect(review.valid.every(d => d.verdict === "duplicate"), JSON.stringify(review.valid)).toBe(true);
    const result = applyCanonicalizationDecisions(docs, pairs, review.valid.map(d => ({...d, survivor: d.survivor as "left" | "right"})));
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.what).toBe(originals[1].metadata.what);
    expect(result.documents[0].metadata.who).toEqual(expect.arrayContaining(["Casey", "Casey's parents", "Jordan Lane, Ph.D."]));
    expect(result.documents[0].metadata.pages).toEqual([14, 3]);
    expect(result.documents[0].metadata.tags).toContain("facet:recommendation");
  });

  it("keeps the purpose when the reviewer omits it from the inventory", () => {
    const docs = [shorter(), richer()], pairs = findCanonicalizationPairs(docs);
    const review = partitionIdentityDecisions(pairs, [{pairId: pairs[0].id, relation: "same_assertion",
      leftOnlyDetails: [], rightOnlyDetails: [], reason: "Fault injection: omitted the stated purpose."}], docs);
    expect(review.valid[0].survivor).toBe("right");
    expect(applyCanonicalizationDecisions(docs, pairs, [{pairId: pairs[0].id, survivor: "left",
      leftOnlyDetails: [], rightOnlyDetails: [], reason: "Fault injection: keep the shorter wording."}]).documents).toHaveLength(2);
  });

  it.each(["different partner", "different occurrence", "missing shared definition"])("does not erase an unverified activity reference: %s", variant => {
    const a = shorter(), b = richer();
    const definition = {pageNumber: 14, sourceOffset: 500, sourceQuote: "Parents should set aside one-on-one time with Casey."};
    a.metadata.sourceSpans.push(definition); b.metadata.sourceSpans.push({...definition});
    if (variant === "different partner") b.metadata.who = ["Jordan", "Jordan's parents"];
    if (variant === "different occurrence") b.metadata.sourceSpans[1].sourceOffset = 800;
    if (variant === "missing shared definition") b.metadata.sourceSpans.pop();
    // With the name retained directly in both records, require the same
    // definition. A named-parent reference is separately source-grounded.
    a.metadata.who = ["Casey"]; if (variant !== "different partner") b.metadata.who = ["Casey"];
    expect(identityMaterialDetails(a.metadata, b.metadata, ["with him"], []).leftOnlyDetails).toEqual(["with him"]);
  });

  it.each([
    "because it created a warm, safe environment", "and parents should arrange another session",
    "because the goal is to create a warm, safe environment and parents should arrange another session",
    "because the goal is to produce an unsupported outcome",
  ])("retains unverified goals, separate actions and achieved outcomes: %s", detail => {
    const a = recommendation(`Parents should set aside expectations, ${detail}.`), b = shorter();
    expect(compatibleIdentityDetail(detail, a.metadata, b.metadata)).toBe(false);
    const pairs = findCanonicalizationPairs([a, b]);
    const review = partitionIdentityDecisions(pairs, pairs.map(p => ({pairId: p.id, relation: "same_assertion",
      leftOnlyDetails: [detail], rightOnlyDetails: [], reason: "Fault injection: arbitrary same-scenario addition."})), [a, b]);
    expect(review.valid.every(d => d.verdict !== "duplicate")).toBe(true);
  });
});
