import { describe, expect, it } from "vitest";
import { evidenceKind, identityText, knownIdentityLabels, knownMetadataText,
  unionMetadataStrings } from "../src/processors/evidence/evidenceMetadataValues.ts";
import { metadataConflictFields } from "../src/processors/evidence/evidenceMetadataReview.ts";
import { mergeEvidenceMetadata } from "../src/processors/evidence/evidenceDeduplication.ts";

describe("shared evidence metadata labels", () => {
  it.each([undefined, null, "", " unknown ", "NULL", "n/a", "Not Applicable"])(
    "treats missing annotation %s consistently in comparisons", value => {
      expect(knownMetadataText(value)).toBeNull();
      expect(knownIdentityLabels([value, "Casey Morgan", "Ｃａｓｅｙ Morgan"])).toEqual(["casey morgan"]);
      expect(metadataConflictFields({who: [value, "Casey Morgan"]}, {who: ["Casey Morgan"]})).toEqual([]);
      const base = {accountId: "account", sourceId: "source", sourceContentHash: "hash",
        what: "Casey Morgan paid.", pages: [1], sourceOffset: 0, sourceQuote: "Casey Morgan paid.",
        sourceSpans: [{pageNumber: 1, sourceOffset: 0, sourceQuote: "Casey Morgan paid."}],
        tags: ["event"], who: ["Casey Morgan"], where: "Unknown", why: "Unknown"};
      expect(mergeEvidenceMetadata({...base, who: [value, "Casey Morgan"]}, base)?.who).toEqual(["Casey Morgan"]);
    });

  it("normalizes participant identity without rewriting retained tags and provenance", () => {
    expect(identityText("  Casey’s\n mother ")).toBe("casey's mother");
    expect(unionMetadataStrings(["Unknown", "claim", "event"], ["claim", "n/a"])).toEqual([
      "Unknown", "claim", "event", "n/a",
    ]);
    expect(evidenceKind({claimType: "allegation", factType: "attribute"})).toBe("claim");
  });
});
