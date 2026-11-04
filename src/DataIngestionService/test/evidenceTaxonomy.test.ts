import { describe, expect, it } from "vitest";
import { eventTypeField, facetTags, facetsField, summarizeEvidenceTaxonomy } from "../src/processors/evidence/evidenceTaxonomy.ts";

describe("evidence taxonomy", () => {
  it("enforces event categories and facet namespaces while permitting new specific facet values", () => {
    expect(eventTypeField().safeParse("email").success).toBe(false);
    expect(eventTypeField().parse("documentExecution")).toBe("documentExecution");
    expect(facetsField().parse([{ namespace: "education", value: "executiveFunctionSupport" }]))
      .toEqual([{ namespace: "education", value: "executiveFunctionSupport" }]);
    expect(facetsField().safeParse([{ namespace: "madeUp", value: "assessment" }]).success).toBe(false);
  });

  it("normalizes spelling without collapsing a suspected diagnosis into a diagnosis", () => {
    expect(facetTags([
      { namespace: "medical", value: "Suspected Diagnosis" },
      { namespace: "medical", value: "suspectedDiagnosis" },
      { namespace: "medical", value: "diagnosis" },
    ])).toEqual(["facet:medical:suspectedDiagnosis", "facet:medical:diagnosis"]);
  });

  it("reports generic and missing classifications separately for events, facts, and claims", () => {
    const summary = summarizeEvidenceTaxonomy([
      { metadata: { tags: ["fact", "event", "eventType:other"] } },
      { metadata: { factType: "assessmentResult", tags: ["event", "fact", "factType:assessmentResult", "facet:education:academicAssessment"] } },
      { metadata: { claimType: "opinion", tags: ["event", "claim", "claimType:opinion"] } },
    ]);
    expect(summary).toEqual({
      event: { count: 1, otherTypeCount: 1, noFacetCount: 1, types: { other: 1 } },
      fact: { count: 1, otherTypeCount: 0, noFacetCount: 0, types: { assessmentResult: 1 } },
      claim: { count: 1, otherTypeCount: 0, noFacetCount: 1, types: { opinion: 1 } },
    });
  });
});
