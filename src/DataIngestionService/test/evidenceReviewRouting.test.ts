import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { boundaryReviewContext, eventClassificationConcerns } from "../src/processors/evidence/evidenceReviewRouting.ts";

describe("evidence review routing", () => {
  it("finds exact fragments of a quotation spanning nonconsecutive source pages", () => {
    const source = new EvidenceSource(new Document({pageContent:"The score was 129 and "
      + "<!-- PageBreak -->the percentile was 97.", metadata:{pages:[7,42]}}));
    const [context] = boundaryReviewContext("The score was 129 and the percentile was 97.", source, source.windows()[1]);
    expect(context.reason).toBe("quotation-crosses-boundary");
    expect(context.target).toMatchObject({pageNumber:42,sourceOffset:0,sourceQuote:"the percentile was 97."});
    expect(context.neighboring.pageNumber).toBe(7);
    for (const span of [context.target, context.neighboring]) {
      const page = source.pages.find(page => page.pageNumber === span.pageNumber)!;
      expect(page.text.slice(span.sourceOffset,span.sourceOffset+span.sourceQuote.length)).toBe(span.sourceQuote);
    }
  });

  it("routes a quotation on the neighboring page when its unfinished sentence continues in the target", () => {
    const source = new EvidenceSource(new Document({pageContent:"Meetings should be short (about 20 minutes) and should "
      + "<!-- PageBreak -->begin and end positively. A new sentence follows."}));
    const contexts = boundaryReviewContext("Meetings should be short (about 20 minutes)",source,source.windows()[1]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({reason:"sentence-crosses-boundary",target:{sourceQuote:"begin and end positively."}});
  });

  it.each([
    ["An assessment was completed. ","An unrelated discussion follows."],
    ["An assessment was completed. A different unfinished sentence ","continues here."],
    ["An assessment was completed ","\n# New section\nUnrelated text."],
  ])("does not treat unrelated neighboring text as boundary support", (before, after) => {
    const source = new EvidenceSource(new Document({pageContent:before+"<!-- PageBreak -->"+after}));
    expect(boundaryReviewContext("An assessment was completed",source,source.windows()[1])).toEqual([]);
  });

  it("handles a following-page quotation in the same sentence and preserves a valid primary citation", () => {
    const source = new EvidenceSource(new Document({pageContent:"Meetings should begin "
      + "<!-- PageBreak -->and end positively."}));
    expect(boundaryReviewContext("and end positively",source,source.windows()[0])[0].neighboring.pageNumber).toBe(2);
    expect(boundaryReviewContext("Meetings should begin",source,source.windows()[0])).toEqual([]);
  });

  it.each([
    "When things are challenging, Casey will become frustrated and say, 'I cannot do that.'",
    "Casey usually avoids difficult tasks.",
    "The school should offer extra time.",
    "If payment is missed, the account may be closed.",
  ])("flags a possible non-event for review: %s", text => {
    expect(eventClassificationConcerns({what:text,sourceQuote:text}).length).toBeGreaterThan(0);
  });

  it("does not flag ordinary occurrences or a May date", () => {
    const text="Casey completed the assessment on May 15, 2025.";
    expect(eventClassificationConcerns({what:text,sourceQuote:text})).toEqual([]);
  });
});
