import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";

describe("document context", () => {
  it("keeps email subject topics out of reserved participant context", () => {
    const source = new EvidenceSource(new Document({pageContent:
      ["Subject: Re: invoice 4412", "Subject: Meeting Update", "Subject: Assessment Request",
        "Subject: Invoice Followup", "**Patient:** Casey Morgan.", "Mother: Avery Morgan."]
        .join("\n\n")}));
    const identities = source.context.participantIdentities(1);
    expect(identities.map(p => p.sourceQuote)).toEqual(["**Patient:** Casey Morgan.", "Mother: Avery Morgan."]);
    for (const passage of identities) expect(source.pages[0].text.slice(passage.sourceOffset,
      passage.sourceOffset + passage.sourceQuote.length)).toBe(passage.sourceQuote);
  });

  it("accepts person names and explicit identity fields under a Subject label", () => {
    const source = new EvidenceSource(new Document({pageContent:
      "Subject: Casey Morgan.\n\nSubject: Name: Riley Chen; DOB: 2001-02-03."}));
    expect(source.context.participantIdentities(1)).toHaveLength(2);
  });

  it("supplies an earlier encounter header for continued care without assigning its facility", () => {
    const source = new EvidenceSource(new Document({pageContent:
      "NORTHSHORE MEDICAL CENTER\nEMERGENCY PROVIDER REPORT\nEncounter: January 5, 2026."
      + "<!-- PageBreak -->Re-examination: abdomen soft and non-tender."
      + "<!-- PageBreak -->Discharge instructions: seek help if symptoms worsen."}));
    const prompt = JSON.parse(source.prompt(source.windows()[1]));
    expect(prompt.locationContext).toHaveLength(1);
    expect(prompt.locationContext[0]).toMatchObject({pageNumber: 1, sourceOffset: 0});
    expect(prompt.locationContext[0].sourceQuote).toContain("NORTHSHORE MEDICAL CENTER");
    expect(prompt).not.toHaveProperty("where");
    expect(prompt.locationContext[0]).not.toHaveProperty("where");
    const passage = prompt.locationContext[0];
    expect(source.pages[0].text.slice(passage.sourceOffset, passage.sourceOffset + passage.sourceQuote.length))
      .toBe(passage.sourceQuote);
  });

  it("prioritizes preceding facility evidence while preserving competing reports for source review", () => {
    const source = new EvidenceSource(new Document({pageContent:
      "Northshore Hospital\nEncounter A.<!-- PageBreak -->Care continued."
      + "<!-- PageBreak -->South Bay Medical Centre\nEncounter B.<!-- PageBreak -->Care continued."}));
    expect(source.context.locations(2).map(passage => passage.pageNumber)).toEqual([1, 3]);
    expect(source.context.locations(4).map(passage => passage.pageNumber)).toEqual([3, 1]);
    expect(source.context.locations(4, 1)).toHaveLength(1);
  });

  it("recognizes explicit encounter labels and keeps documents without facility evidence unassigned", () => {
    const source = new EvidenceSource(new Document({pageContent:
      "**Place of service:** Northshore ED.<!-- PageBreak -->Recorded vital signs."}));
    expect(source.context.locations(2)[0].sourceQuote).toBe("**Place of service:** Northshore ED.");
    const unrelated = new EvidenceSource(new Document({pageContent: "A historical incident at home was reported."}));
    expect(JSON.parse(unrelated.prompt(unrelated.windows()[0])).locationContext).toEqual([]);
  });

  it("reserves explicit identity passages even when descriptive paragraphs dominate lexical matches", () => {
    const repeated=Array.from({length:12},()=>"The mother reported Casey needs extra time on tasks.").join("\n\n");
    const source=new EvidenceSource(new Document({pageContent:"**Examiner:** Dr. North.\n\n"+repeated
      +"<!-- PageBreak --># Recommendations\n\nCasey needs extra time."}));
    const prompt=JSON.parse(source.prompt(source.windows()[1]));
    expect(prompt.attributionContext).toHaveLength(1);
    expect(prompt.attributionContext[0].sourceQuote).toBe("**Examiner:** Dr. North.");
    expect(prompt.attributionContext[0]).not.toHaveProperty("claimant");
  });

  it("retains competing identity passages without assigning a global author", () => {
    const source=new EvidenceSource(new Document({pageContent:"# Report A\n\nAuthor: Alice.<!-- PageBreak --># Report B\n\nAuthor: Bob."}));
    expect(source.context.identities(2).map(p=>p.sourceQuote)).toEqual(["Author: Bob.","Author: Alice."]);
  });

  it("retrieves exact cross-page attribution passages without assigning a claimant", async () => {
    const source = new EvidenceSource(new Document({ pageContent:
      "# Report\n\nAuthor: Dr. North.\n\nMother reported that Casey was tired.<!-- PageBreak -->Casey completed the test in March 2025." }));
    const context = source.context.lookup(2, "Casey was tired", "attribution");
    expect(context.some(passage => passage.sourceQuote.includes("Mother reported"))).toBe(true);
    for (const passage of context) {
      const text = source.pages.find(page => page.pageNumber === passage.pageNumber)!.text;
      expect(text.slice(passage.sourceOffset, passage.sourceOffset + passage.sourceQuote.length)).toBe(passage.sourceQuote);
      expect(passage).not.toHaveProperty("claimant");
    }
    expect(source.context.lookup(2, "Casey was tired", "attribution")).toEqual(context);
    expect(source.context.cacheHits).toBe(1);
    const tool = source.contextSearchTool();
    const result = JSON.parse(await tool.invoke({ pageNumber: 2, query: "Casey test", purpose: "dates" }));
    expect(result.passages.some((p: {sourceQuote: string}) => p.sourceQuote.includes("March 2025"))).toBe(true);
  });

  it("keeps changed and unrelated documents isolated, including unsuccessful searches", () => {
    const first = new EvidenceSource(new Document({pageContent: "Nothing temporal here."}));
    expect(first.context.lookup(1, "test", "dates")).toEqual([]);
    const second = new EvidenceSource(new Document({pageContent: "Test completed in April 2026."}));
    expect(second.context.lookup(1, "test", "dates")).toHaveLength(1);
    expect(second.context.cacheHits).toBe(0);
  });

  it("retrieves short participant identifiers without requiring an author or witness cue", () => {
    const source = new EvidenceSource(new Document({pageContent:
      "Payer register: W-17 is Morgan Vale.<!-- PageBreak -->W-17 paid Casey."}));
    expect(source.context.lookup(2, "W-17", "review").some(passage => passage.pageNumber === 1)).toBe(true);
  });
});
