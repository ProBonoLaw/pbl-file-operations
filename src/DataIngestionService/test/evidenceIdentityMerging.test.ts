import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { deduplicateEvidenceDocuments } from "../src/processors/evidence/evidenceDeduplication.ts";
import { applyCanonicalizationDecisions, findCanonicalizationPairs } from "../src/processors/evidence/evidenceCanonicalization.ts";
import { partitionIdentityDecisions } from "../src/processors/evidence/evidenceIdentityReview.ts";
import { formatEvidenceContent } from "../src/processors/evidence/evidenceContent.ts";
import { evidenceSearchValues } from "../src/processors/evidence/evidenceSearchProjection.ts";
import { evidencePrimarySpan } from "../src/processors/evidence/evidencePageIdentity.ts";

type Kind = "event" | "fact" | "claim";
const date = { year: "2025", month: "3", day: "5" };
function entry(kind: Kind, overrides: Record<string, unknown> = {}) {
  const quote = "Casey paid 250 dollars on March 5, 2025.";
  const metadata = {
    accountId: "account-1", sourceId: "307", sourceContentHash: "source-hash", evidenceSchemaVersion: "3",
    what: "Casey paid 250 dollars.", who: ["Casey"], where: "Unknown", why: "Unknown",
    whenStarted: kind === "event" ? date : null, whenEnded: null,
    sourceQuote: quote, sourceOffset: 0, pages: [56],
    sourceSpans: [{pageNumber: 56, sourceOffset: 0, sourceQuote: quote}], extractedBy: [kind + ":extractor"],
    ...(kind === "event" ? {eventType: "payment", tags: ["fact", "event", "eventType:payment"]}
      : kind === "fact" ? {factType: "recordedValue", subject: ["Casey"], reportedBy: [], asOf: null,
        tags: ["fact", "factType:recordedValue", "facet:financial:payment"]}
        : {claimType: "factualAssertion", claimant: "Casey", claimPolarity: "asserts",
          tags: ["claim", "claimType:factualAssertion", "claimPolarity:asserts"]}),
    ...overrides,
  };
  return new Document({metadata, pageContent: formatEvidenceContent(metadata)});
}

const orders: Kind[][] = [["event", "fact", "claim"], ["event", "claim", "fact"],
  ["fact", "event", "claim"], ["fact", "claim", "event"], ["claim", "event", "fact"], ["claim", "fact", "event"]];

describe("one evidence identity across extraction classifications", () => {
  it("requires review for shortened participant labels on an identical cited assertion", () => {
    const short = entry("claim", {claimant: "Jordan Lane"});
    const full = entry("claim", {who: ["Casey Morgan"], claimant: "Jordan Lane, Ph.D.",
      sourceSpans: [...short.metadata.sourceSpans,
        {pageNumber: 56, sourceOffset: 100, sourceQuote: "Casey is Casey Morgan. The reporter is Jordan Lane, Ph.D."}]});
    expect(deduplicateEvidenceDocuments([short, full])).toHaveLength(2);
    const pairs = findCanonicalizationPairs([short, full]);
    expect(pairs).toHaveLength(1);
    expect(applyCanonicalizationDecisions([short, full], pairs, []).documents).toHaveLength(2);
    const result = applyCanonicalizationDecisions([short, full], pairs, [{pairId: pairs[0].id,
      survivor: "right", leftOnlyDetails: [], rightOnlyDetails: [], reason: "The citation establishes the shortened name and same reporter."}]);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.who).toEqual(expect.arrayContaining(["Casey", "Casey Morgan"]));
    expect(result.documents[0].metadata.sourceSpans).toEqual(expect.arrayContaining(full.metadata.sourceSpans));
    expect(result.documents[0].metadata.evidenceClassifications).toHaveLength(2);
  });

  it("does not equate different full names, relatives, or aliases on different citations", () => {
    const full = entry("claim", {who: ["Casey Morgan"]});
    for (const who of [["Casey Brown"], ["Casey's mother"], ["Morgan Casey"]]) {
      expect(findCanonicalizationPairs([full, entry("claim", {who})])).toHaveLength(0);
    }
    const otherCitation = entry("claim", {sourceOffset: 100,
      sourceSpans: [{pageNumber: 56, sourceOffset: 100, sourceQuote: full.metadata.sourceQuote}]});
    expect(findCanonicalizationPairs([full, otherCitation])).toHaveLength(0);
    // Paraphrases citing the same occurrence now reach review even when a
    // participant label is shortened. Retrieval alone cannot remove either.
    const paraphrases = [full, entry("claim", {what: "Casey made a payment of 250 dollars."})];
    const candidates = findCanonicalizationPairs(paraphrases);
    expect(candidates).toHaveLength(1);
    expect(applyCanonicalizationDecisions(paraphrases, candidates, []).documents).toHaveLength(2);
    expect(findCanonicalizationPairs([entry("claim", {claimant: "Jordan Lane"}),
      entry("claim", {claimant: "Jordan West"})])).toHaveLength(0);
  });

  it("does not join different full names transitively through a shared short label", () => {
    const documents = [entry("claim"), entry("claim", {who: ["Casey Brown"]}),
      entry("claim", {who: ["Casey Morgan"]})];
    const pairs = findCanonicalizationPairs(documents);
    expect(pairs).toHaveLength(2);
    const result = applyCanonicalizationDecisions(documents, pairs, pairs.map(pair => ({pairId: pair.id,
      survivor: "left" as const, leftOnlyDetails: [], rightOnlyDetails: [], reason: "A proposed short-name match."})));
    expect(result.documents).toHaveLength(2);
    expect(result.documents.every(doc => !(doc.metadata.who.includes("Casey Brown")
      && doc.metadata.who.includes("Casey Morgan")))).toBe(true);
  });

  it.each(orders.map(order => [order.join(","), order] as const))("retains event > fact > claim in order %s", (_name, order) => {
    const documents = order.map(kind => entry(kind, kind === "claim" ? {claimant: "Unknown"} : {}));
    const original = JSON.stringify(documents);
    const result = deduplicateEvidenceDocuments(documents);
    expect(result).toHaveLength(1);
    const merged = result[0];
    expect(evidenceSearchValues(merged.metadata).evidenceKind).toBe("event");
    expect(merged.metadata.whenStarted).toMatchObject(date);
    expect(merged.metadata.tags).toEqual(expect.arrayContaining(documents.flatMap(d => d.metadata.tags)));
    expect(merged.metadata.evidenceClassifications.map((value: {kind: string}) => value.kind).sort())
      .toEqual(["claim", "event", "fact"]);
    expect(merged.metadata.claimant).toBe("Unknown");
    expect(merged.metadata.extractedBy).toHaveLength(3);
    expect(merged.pageContent).toContain("Event start date: 5 March 2025");
    expect(merged.pageContent).toBe(formatEvidenceContent(merged.metadata));
    expect(deduplicateEvidenceDocuments(result)).toEqual(result);
    expect(JSON.stringify(documents)).toBe(original);
  });

  it.each([false, true])("retains facts over claims and preserves an other fact type (reverse=%s)", reverse => {
    const documents = [entry("fact", {factType: "other", tags: ["fact", "factType:other"]}), entry("claim", {claimant: "Unknown"})];
    const result = deduplicateEvidenceDocuments(reverse ? documents.reverse() : documents);
    expect(result).toHaveLength(1);
    expect(evidenceSearchValues(result[0].metadata).evidenceKind).toBe("fact");
    expect(result[0].metadata.factType).toBe("other");
    expect(result[0].metadata.tags).toContain("claim");
    expect(result[0].metadata.reportedBy).toEqual([]);
  });

  it.each([
    {accountId: "account-2"}, {sourceId: "308"}, {sourceContentHash: "another-version"},
    {pages: [57], sourceSpans: [{pageNumber: 57, sourceOffset: 0, sourceQuote: "Casey paid 250 dollars on March 5, 2025."}]},
    {whenStarted: {...date, day: "6"}}, {what: "Casey paid 350 dollars."},
    {what: "Casey did not pay 250 dollars."}, {claimPolarity: "uncertain"}, {claimPolarity: "denies"},
  ])("preserves scope and material differences: %j", overrides => {
    const documents = [entry("event"), entry("claim", overrides)];
    expect(deduplicateEvidenceDocuments(documents)).toHaveLength(2);
    expect(findCanonicalizationPairs(documents)).toHaveLength(0);
    // A supplied approval cannot bypass the same scope and compatibility guards.
    const pairs = [{id: "0:1", leftIndex: 0, rightIndex: 1, similarity: 1, allowedSurvivors: ["left" as const]}];
    expect(applyCanonicalizationDecisions(documents, pairs, [{pairId: "0:1", survivor: "left",
      leftOnlyDetails: [], rightOnlyDetails: [], reason: "Supposed duplicate"}]).documents).toHaveLength(2);
  });

  it("does not let a preferred representation hide conflicting claimants on a later merge", () => {
    const first = deduplicateEvidenceDocuments([entry("event"), entry("claim")]);
    expect(first).toHaveLength(2);
    expect(deduplicateEvidenceDocuments([...first, entry("claim", {claimant: "Jordan"})])).toHaveLength(3);
  });

  it("rejects a supplied reviewed merge that would hide an attributed claim", () => {
    const documents = [entry("event"), entry("claim")];
    expect(findCanonicalizationPairs(documents)).toHaveLength(0);
    const pairs = [{id: "0:1", leftIndex: 0, rightIndex: 1, similarity: 1, allowedSurvivors: ["left" as const]}];
    expect(applyCanonicalizationDecisions(documents, pairs, [{pairId: "0:1", survivor: "left",
      leftOnlyDetails: [], rightOnlyDetails: [], reason: "Fault injection: drop the reporting frame."}]).documents).toHaveLength(2);
  });

  it("merges independently anchored extractions on one page and retains all citations", () => {
    const fact = entry("fact", {sourceOffset: 100,
      sourceSpans: [{pageNumber: 56, sourceOffset: 100, sourceQuote: "Casey paid 250 dollars on March 5, 2025."}]});
    const event = entry("event");
    const result = deduplicateEvidenceDocuments([fact, event]);
    expect(result).toHaveLength(1);
    expect(result[0].metadata.sourceOffset).toBe(0);
    expect(result[0].metadata.sourceSpans).toEqual([...event.metadata.sourceSpans, ...fact.metadata.sourceSpans]);
  });

  it("reviews paraphrases across kinds and separate quotations, then keeps the preferred representation", () => {
    const documents = [entry("event"), entry("fact", {what: "Casey paid 250 dollars as a payment.", sourceOffset: 100,
      sourceSpans: [{pageNumber: 56, sourceOffset: 100, sourceQuote: "Casey paid 250 dollars on March 5, 2025."}]})];
    expect(deduplicateEvidenceDocuments(documents)).toHaveLength(2);
    const pairs = findCanonicalizationPairs(documents);
    expect(pairs).toHaveLength(1);
    expect(applyCanonicalizationDecisions(documents, pairs, []).documents).toHaveLength(2);
    const result = applyCanonicalizationDecisions(documents, pairs, [{pairId: pairs[0].id, survivor: "right",
      leftOnlyDetails: [], rightOnlyDetails: [], reason: "The source verifies one payment."}]);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.what).toBe(documents[1].metadata.what);
    expect(evidenceSearchValues(result.documents[0].metadata).evidenceKind).toBe("event");
    expect(result.documents[0].metadata.sourceOffset).toBe(100);
    expect(evidencePrimarySpan(result.documents[0].metadata)).toEqual(documents[1].metadata.sourceSpans[0]);
    expect(result.documents[0].metadata.sourceSpans).toEqual([
      ...documents[1].metadata.sourceSpans, ...documents[0].metadata.sourceSpans,
    ]);
    expect(result.documents[0].metadata.tags).toEqual(expect.arrayContaining(["event", "factType:recordedValue"]));
  });

  it("consolidates the Source 307 page-56 example through the general identity review", () => {
    const person = "Casey Marlowe Reyes", reporter = "Riley Ann Hart, Ph.D.";
    const sourceQuote = "Date of birth: 11/04/1990";
    const primary = {pageNumber: 56, sourceOffset: 237, sourceQuote};
    const support = {pageNumber: 56, sourceOffset: 70, sourceQuote: `${reporter} Clinical Psychology`};
    const common = {what: `${person}'s date of birth is November 4, 1990.`, who: [person], subject: [person],
      sourceQuote, sourceOffset: 237, sourceSpans: [primary]};
    const documents = [entry("fact", {...common, factType: "attribute", who: [person, reporter],
      reportedBy: [reporter], sourceSpans: [primary, support]}),
    entry("fact", {...common, factType: "attribute", what: `${person}'s recorded date of birth is November 4, 1990.`}),
    entry("event", {...common, eventType: "lifeEvent", whenStarted: {year: "1990", month: "11", day: "4"}})];
    const repeatedPages = [87, 91].map(page => entry("fact", {...common, pages: [page],
      sourceSpans: [{...primary, pageNumber: page}]}));
    const unique = deduplicateEvidenceDocuments([...documents, ...repeatedPages]);
    expect(unique).toHaveLength(4);
    const pairs = findCanonicalizationPairs(unique);
    expect(pairs).toHaveLength(1);
    const review = partitionIdentityDecisions(pairs, [{pairId: pairs[0].id, relation: "same_assertion",
      leftOnlyDetails: [], rightOnlyDetails: [], reason: "Both describe the same recorded value in the cited passage."}], unique);
    expect(review.valid[0].verdict).toBe("duplicate");
    const decision = review.valid[0];
    if (decision.survivor === "none") throw new Error("Expected an approved survivor");
    const result = applyCanonicalizationDecisions(unique, pairs, [{...decision, survivor: decision.survivor}]);
    expect(result.documents).toHaveLength(3);
    const merged = result.documents.find(d => d.metadata.pages[0] === 56)!;
    expect(evidenceSearchValues(merged.metadata).evidenceKind).toBe("event");
    expect(merged.metadata.whenStarted).toMatchObject({year: "1990", month: "11", day: "4"});
    expect(merged.metadata.sourceSpans).toContainEqual(support);
    expect(merged.metadata.reportedBy).toContain(reporter);
  });

  it.each(["Jordan Q. Sample was born on March 22, 1985.", "Jordan Q. Sample's date of birth is 03/22/1985."])(
    "retains the fact for Source 766 page 2 despite a factualAssertion copy: %s", what => {
    const sourceQuote = "Date of Birth: 03/22/1985";
    const common = {sourceId: "766", pages: [2], sourceQuote, sourceOffset: 706, who: ["Jordan Q. Sample"],
      sourceSpans: [{pageNumber: 2, sourceOffset: 706, sourceQuote}]};
    const documents = [entry("claim", {...common, claimant: "Unknown",
      what: "Jordan Q. Sample's date of birth is March 22, 1985.", whenStarted: {year: "1985", month: "3", day: "22"}}),
    entry("fact", {...common, what, subject: ["Jordan Q. Sample"], factType: "attribute",
      asOf: {year: "1985", month: "3", day: "22"}})];
    const pairs = findCanonicalizationPairs(documents);
    expect(pairs).toHaveLength(1);
    const review = partitionIdentityDecisions(pairs, [{pairId: pairs[0].id, relation: "same_assertion",
      leftOnlyDetails: [], rightOnlyDetails: [], reason: "One form field supports the same recorded identity."}], documents);
    expect(review.valid[0]).toMatchObject({verdict: "duplicate", survivor: "right"});
    const result = applyCanonicalizationDecisions(documents, pairs, [{...review.valid[0], survivor: "right"}]);
    expect(result.documents).toHaveLength(1);
    expect(evidenceSearchValues(result.documents[0].metadata).evidenceKind).toBe("fact");
    expect(result.documents[0].metadata.claimType).toBeUndefined();
    expect(result.documents[0].metadata.tags).toEqual(expect.arrayContaining(["fact", "claim", "claimType:factualAssertion"]));
  });

  it("recognizes date formatting variants for any assertion without accepting different or ambiguous dates", () => {
    const documents = [entry("event", {what: "Casey made the payment on June 15, 2025."}),
      entry("fact", {what: "Casey made the payment on 06/15/2025."})];
    expect(findCanonicalizationPairs(documents)).toHaveLength(1);
    for (const [left, right] of [["June 15, 2025", "06/16/2025"], ["April 5, 2025", "04/05/2025"],
      ["March 1, 2025", "02/29/2025"]]) {
      expect(findCanonicalizationPairs([entry("event", {what: `Casey made the payment on ${left}.`}),
        entry("fact", {what: `Casey made the payment on ${right}.`})])).toHaveLength(0);
    }
  });
});
