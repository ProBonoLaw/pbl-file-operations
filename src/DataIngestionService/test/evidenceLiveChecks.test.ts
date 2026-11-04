import { describe, expect, it } from "vitest";
import { extractionSkippedOnReplay, partitionEvidenceDocuments, repeatedExactAssertionGroups } from "../scripts/evidence-live-checks.mjs";

const usage = (stage: string) => ({name:"llm.call.token_usage",properties:{stage}});

describe("live candidate replay checks", () => {
  it("allows attribution, date recovery, fallback and canonicalization without fresh extraction", () => {
    expect(extractionSkippedOnReplay("replay", ["reconciliation", "reconciliation-fallback",
      "claim-attribution", "event-date-resolution", "canonicalization"].map(usage))).toBe(true);
  });

  it.each(["primary-events", "primary-facts", "primary-claims", "independent"])("detects fresh %s calls", stage => {
    expect(extractionSkippedOnReplay("replay", [usage("claim-attribution"), usage(stage)])).toBe(false);
  });

  it("does not require extraction to be skipped outside replay mode", () => {
    expect(extractionSkippedOnReplay("none", [usage("independent")])).toBe(true);
  });
});

describe("live checks for merged evidence", () => {
  it("counts only repeated assertions with the same attribution and source occurrence", () => {
    const metadata = {accountId: "account", sourceId: "source", sourceContentHash: "hash",
      what: "John hit Bob.", claimType: "allegation", claimant: "Mother", claimPolarity: "asserts",
      sourceSpans: [{pageNumber: 1, sourceOffset: 0, sourceQuote: "Mother said John hit Bob."}]};
    const entry = (overrides: Record<string, unknown> = {}) => ({metadata: {...metadata, ...overrides}});
    expect(repeatedExactAssertionGroups([entry(), entry({what: "John  hit\nBob."})])).toBe(1);
    expect(repeatedExactAssertionGroups([entry(), entry({claimant: "Father"}),
      entry({claimPolarity: "denies"}), entry({claimType: undefined, eventType: "violence"}),
      entry({sourceSpans: [{...metadata.sourceSpans[0], sourceOffset: 100}]}),
      entry({sourceContentHash: "new-revision"})])).toBe(0);
  });

  it("validates each retained representation once despite combined type tags", () => {
    const event = {metadata: {eventType: "payment", tags: ["event", "fact", "claim"]}};
    const fact = {metadata: {factType: "attribute", tags: ["fact", "claim"]}};
    const claim = {metadata: {claimType: "factualAssertion", tags: ["claim"]}};
    expect(partitionEvidenceDocuments([event, fact, claim])).toEqual({events: [event], facts: [fact], claims: [claim]});
  });

  it("does not let inherited tags override structured classification", () => {
    const claim = {metadata: {claimType: "opinion", tags: ["fact", "event", "claim"]}};
    expect(partitionEvidenceDocuments([claim])).toEqual({events: [], facts: [], claims: [claim]});
    expect(() => partitionEvidenceDocuments([{metadata: {tags: []}}])).toThrow("Unrecognized evidence representation");
  });
});
