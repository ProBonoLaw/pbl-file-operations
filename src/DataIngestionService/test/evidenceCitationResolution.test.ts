import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { expandCitationChoices, prepareEvidenceCitations } from "../src/processors/evidence/evidenceCitationResolution.ts";

const text = "## Discussed\n\n- Daily reading.\n\n## Agreed Upon\n\n- Daily reading.";
const source = new EvidenceSource(new Document({ pageContent: text, metadata: { pages: [1] } }));
const window = source.windows()[0];

describe("evidence citation resolution", () => {
  it("resolves a repeated bullet only to the section explicitly cited by the item", () => {
    const prepared = prepareEvidenceCitations({ sourceQuote: "- Daily reading.",
      supportingQuotes: [{ pageNumber: 1, quote: "## Agreed Upon" }] }, source, window);
    const span = source.locate(window, prepared.item.sourceQuote)!;
    expect(span).not.toBeNull();
    expect(span.sourceOffset + span.sourceQuote.lastIndexOf("- Daily reading.")).toBe(text.lastIndexOf("- Daily reading."));
    expect(prepared.choices).toEqual([]);
    expect(prepared.item.supportingQuotes[0].quote).toBe("## Agreed Upon");
  });

  it("offers explicit choices without guessing when no section or conflicting sections are cited", () => {
    for (const supportingQuotes of [[], [{ pageNumber: 1, quote: "## Discussed" }, { pageNumber: 1, quote: "## Agreed Upon" }]]) {
      const prepared = prepareEvidenceCitations({ sourceQuote: "- Daily reading.", supportingQuotes }, source, window);
      expect(prepared.item.sourceQuote).toBe("- Daily reading.");
      expect(prepared.choices).toHaveLength(2);
      for (const choice of prepared.choices) expect(source.locate(window, choice.sourceQuote)).toMatchObject({sourceOffset: choice.sourceOffset});
      const selected = expandCitationChoices({...prepared.item, sourceQuote: prepared.choices[1].id}, prepared.choices);
      expect(source.locate(window, selected.sourceQuote)).toEqual(expect.objectContaining({sourceOffset: prepared.choices[1].sourceOffset}));
    }
  });

  it("uses only the target window for primary choices and keeps cross-page supporting choices separate", () => {
    const document = new Document({pageContent: "An action.<!-- PageBreak -->"+text,metadata:{pages:[1,2]}});
    const pages = new EvidenceSource(document);
    const prepared = prepareEvidenceCitations({sourceQuote:"An action.",supportingQuotes:[{pageNumber:2,quote:"- Daily reading."}]},pages,pages.windows()[0]);
    expect(prepared.choices).toHaveLength(2);
    const selected=expandCitationChoices({...prepared.item,supportingQuotes:[{pageNumber:2,quote:prepared.choices[1].id}]},prepared.choices);
    expect(pages.locateSupporting(2,selected.supportingQuotes[0].quote)).not.toBeNull();
    expect(()=>expandCitationChoices({...prepared.item,sourceQuote:prepared.choices[0].id},prepared.choices)).toThrow("Invalid citation choice");
    expect(()=>expandCitationChoices({...prepared.item,supportingQuotes:[{pageNumber:1,quote:prepared.choices[0].id}]},prepared.choices)).toThrow("Invalid citation choice");
    expect(()=>expandCitationChoices({...prepared.item,sourceQuote:"cite:primary:99"},prepared.choices)).toThrow("Invalid citation choice");
    expect(prepareEvidenceCitations({sourceQuote:"- Daily reading.",supportingQuotes:[]},pages,pages.windows()[0]).choices).toEqual([]);
  });

  it("leaves missing text and unique citations intact", () => {
    const original={sourceQuote:"Not in the document",supportingQuotes:[{pageNumber:1,quote:"## Discussed"}]};
    expect(prepareEvidenceCitations(original,source,window)).toEqual({item:original,choices:[]});
  });

  it("offers source-verified line choices for a stitched section quotation", () => {
    const text = ["Session number: 5", "Date and Time: June 3", "Description: She arrived anxious.",
      "Additional narrative between the session description and examination.",
      "Mental status: Dysphoric mood; quite anxious.", "Billing & payments: Making deductible payments.",
      "Session number: 6", "Mental status: Dysphoric mood; quite anxious.",
      "Billing & payments: Making deductible payments."].join("\n\n");
    const pages = new EvidenceSource(new Document({pageContent:text,metadata:{pages:[4]}}));
    const window = pages.windows()[0];
    const original = {sourceQuote:"Session number: 5\n\nDate and Time: June 3\n\n"
      + "Description: She arrived anxious.\n\nMental status: Dysphoric mood; quite anxious.\n\n"
      + "Billing & payments: Making deductible payments.", supportingQuotes:[]};
    const prepared = prepareEvidenceCitations(original,pages,window);
    expect(prepared.item).toEqual(original);
    expect(prepared.choices.length).toBeGreaterThan(0);
    expect(prepared.choices.some(choice => choice.sourceQuote.includes("Billing & payments"))).toBe(true);
    expect(prepared.choices.every(choice => pages.locate(window,choice.sourceQuote)?.sourceOffset === choice.sourceOffset)).toBe(true);
    const corrected = expandCitationChoices({...original,sourceQuote:prepared.choices[0].id},prepared.choices);
    expect(pages.locate(window,corrected.sourceQuote)).not.toBeNull();
  });

  it.each([
    "I asked him how he knew she lied to the court but he did not answer my question.",
    "I asked how he knew she lied to the court but he did answer my question.",
    "I asked how he knew she lied to the judge but he did not answer my question.",
  ])("offers exact source text for review without automatically correcting %s", sourceQuote => {
    const exact = "I asked how he knew she lied to the court but he did not answer my question.";
    const pages = new EvidenceSource(new Document({pageContent: "An earlier statement.\n\n" + exact, metadata: {pages: [16]}}));
    const target = pages.windows()[0];
    const original = {sourceQuote, supportingQuotes: []};
    const prepared = prepareEvidenceCitations(original, pages, target);
    expect(prepared.item).toEqual(original);
    expect(pages.locate(target, prepared.item.sourceQuote)).toBeNull();
    expect(prepared.choices).toHaveLength(1);
    expect(prepared.choices[0]).toMatchObject({sourceQuote: exact, pageNumber: 16, reason: "quotation-mismatch"});
    const selected = expandCitationChoices({...original, sourceQuote: prepared.choices[0].id}, prepared.choices);
    expect(pages.locate(target, selected.sourceQuote)).toEqual(expect.objectContaining({sourceQuote: exact}));
  });

  it("keeps nearby alternatives distinct and anchored to the requested field and page", () => {
    const quote = "The witness said that the delivery happened on Monday morning.";
    const monday = "The witness said that the delivery occurred on Monday morning.";
    const tuesday = "The witness said that the delivery happened on Tuesday morning.";
    const pages = new EvidenceSource(new Document({pageContent: "The witness was interviewed.<!-- PageBreak -->"
      + monday + "\n\nA different account follows.\n\n" + tuesday, metadata: {pages: [1, 2]}}));
    const prepared = prepareEvidenceCitations({sourceQuote: quote, supportingQuotes: [{pageNumber: 2, quote}]}, pages, pages.windows()[0]);
    expect(prepared.item.sourceQuote).toBe(quote);
    expect(prepared.choices).toHaveLength(2);
    expect(prepared.choices.map(choice => choice.sourceQuote)).toEqual([monday, tuesday]);
    expect(prepared.choices.every(choice => choice.field === "supportingQuotes" && choice.pageNumber === 2)).toBe(true);
    expect(() => expandCitationChoices({...prepared.item, sourceQuote: prepared.choices[0].id}, prepared.choices)).toThrow("Invalid citation choice");
    expect(() => expandCitationChoices({...prepared.item, supportingQuotes: [{pageNumber: 1, quote: prepared.choices[0].id}]}, prepared.choices)).toThrow("Invalid citation choice");
  });
});
