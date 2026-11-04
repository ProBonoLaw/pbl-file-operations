import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { deduplicateEvidenceDocuments, mergeEvidenceMetadata } from "../src/processors/evidence/evidenceDeduplication.ts";
import { formatEvidenceContent } from "../src/processors/evidence/evidenceContent.ts";

function evidence(overrides: Record<string, unknown> = {}): Document {
  const quote = "Casey paid 250 dollars.";
  const metadata = {
    what: quote, tags: ["fact", "event", "eventType:payment"],
    who: ["Casey"], where: "Unknown", why: "Unknown",
    whenStarted: { year: "2025", month: "3", day: "5" }, whenEnded: null,
    accountId: "account-1", sourceId: "source-1", sourceContentHash: "source-hash", evidenceSchemaVersion: "3",
    pages: [1], sourceOffset: 10, sourceQuote: quote,
    sourceSpans: [{ pageNumber: 1, sourceOffset: 10, sourceQuote: quote }],
    extractedBy: ["primary:model"], ...overrides,
  };
  return new Document({ pageContent: formatEvidenceContent(metadata), metadata });
}

function propertyFact(subject: string[], overrides: Record<string, unknown> = {}): Document {
  const what = "The personal property listed as Petitioner's in the CR 2A Agreement is given to Petitioner as her separate property.";
  const sourceQuote = "The personal property listed as Petitioner's in the CR 2A Agreement described in 5 above is given to Petitioner as her separate property.";
  return evidence({what, who: subject, subject, reportedBy: [], factType: "condition",
    tags: ["fact", "factType:condition", "facet:legal:courtOrder"], whenStarted: null,
    pages: [107], sourceOffset: 579, sourceQuote,
    sourceSpans: [{pageNumber: 107, sourceOffset: 579, sourceQuote}], ...overrides});
}

describe("evidence deduplication before embedding", () => {
  it.each([false, true])("merges subset annotations of the identical cited assertion (reversed=%s)", reversed => {
    const partial = propertyFact(["Petitioner"], {extractedBy: ["independent:model"]});
    const subjects = ["Petitioner", "Petitioner's personal property", "CR 2A Agreement"];
    const fuller = propertyFact(subjects);
    const support = {pageNumber: 106, sourceOffset: 10, sourceQuote: "The court now orders:"};
    fuller.metadata.sourceSpans.push(support);
    fuller.metadata.pages.push(106);
    const documents = reversed ? [fuller, partial] : [partial, fuller];
    const original = JSON.stringify(documents);

    const result = deduplicateEvidenceDocuments(documents);

    expect(result).toHaveLength(1);
    expect(result[0].metadata.who).toEqual(subjects);
    expect(result[0].metadata.subject).toEqual(subjects);
    expect(result[0].metadata.what).toBe(partial.metadata.what);
    expect(result[0].metadata.sourceSpans).toEqual(fuller.metadata.sourceSpans);
    expect(result[0].metadata.pages).toEqual([107, 106]);
    expect(result[0].metadata.extractedBy).toEqual(expect.arrayContaining(["primary:model", "independent:model"]));
    expect(result[0].pageContent).toBe(formatEvidenceContent(result[0].metadata));
    expect(JSON.stringify(documents)).toBe(original);
    expect(deduplicateEvidenceDocuments(result)).toEqual(result);
  });

  it.each(["offset", "quote"])("requires review for unquoted subset labels with a different primary %s", difference => {
    const partial = propertyFact(["Petitioner"]);
    const fuller = propertyFact(["Petitioner", "Petitioner's personal property", "CR 2A Agreement"]);
    if (difference === "offset") fuller.metadata.sourceOffset += 200;
    else fuller.metadata.sourceQuote += " This is the final order.";
    fuller.metadata.sourceSpans = [{pageNumber: 107, sourceOffset: fuller.metadata.sourceOffset,
      sourceQuote: fuller.metadata.sourceQuote}];

    expect(deduplicateEvidenceDocuments([partial, fuller])).toHaveLength(2);
    expect(deduplicateEvidenceDocuments([fuller, partial])).toHaveLength(2);
  });

  it("preserves conflicting subjects even when the Who fields are subsets", () => {
    const petitioner = propertyFact(["Petitioner"]);
    const respondent = propertyFact(["Petitioner", "Respondent"], {subject: ["Respondent"]});
    expect(deduplicateEvidenceDocuments([petitioner, respondent])).toHaveLength(2);
    expect(deduplicateEvidenceDocuments([respondent, petitioner])).toHaveLength(2);
  });

  it("does not extend participant enrichment to an uncited additional reporter", () => {
    const first = propertyFact(["Petitioner"], {reportedBy: ["Court"]});
    const second = propertyFact(["Petitioner", "CR 2A Agreement"], {reportedBy: ["Court", "Witness"]});
    expect(deduplicateEvidenceDocuments([first, second])).toHaveLength(2);
  });

  it("retains an unasserted participant at another citation offset", () => {
    const first = evidence();
    const second = evidence({who: ["Casey", "Jordan"], sourceOffset: 100,
      sourceSpans: [{pageNumber: 1, sourceOffset: 100, sourceQuote: first.metadata.sourceQuote}]});
    expect(deduplicateEvidenceDocuments([first, second])).toHaveLength(2);
  });

  it.each([false, true])("keeps crossed participant subsets separate (reversed=%s)", reversed => {
    const first = propertyFact(["Petitioner"], {subject: ["Petitioner", "CR 2A Agreement"]});
    const second = propertyFact(["Petitioner", "Petitioner's personal property"], {subject: ["Petitioner"]});
    expect(deduplicateEvidenceDocuments(reversed ? [second, first] : [first, second])).toHaveLength(2);
  });

  it.each(["who", "subject"])("does not add an unsupported name to %s at an identical citation", field => {
    const quote = "Payment was made.";
    const first = evidence({what: quote, sourceQuote: quote,
      sourceSpans: [{pageNumber: 1, sourceOffset: 10, sourceQuote: quote}], [field]: ["Casey"]});
    const second = evidence({...first.metadata, [field]: ["Casey", "Jordan"]});
    expect(deduplicateEvidenceDocuments([first, second])).toHaveLength(2);
    expect(deduplicateEvidenceDocuments([second, first])).toHaveLength(2);
  });

  it.each(["who", "subject"])("does not treat missing %s as permission to add an unsupported label", field => {
    for (const missing of [undefined, null, [], ["Unknown"], ["null", "N/A", "not applicable", " "]]) {
      const first = {...evidence().metadata, [field]: missing};
      const second = {...evidence().metadata, [field]: ["Jordan"]};
      expect(mergeEvidenceMetadata(first, second)).toBeNull();
      expect(mergeEvidenceMetadata(second, first)).toBeNull();
    }
  });

  it.each([false, true])("ignores unknown annotations without losing known participants (reviewed=%s)", reviewed => {
    const first = evidence({who: ["Unknown", "Casey"], subject: ["N/A"], reportedBy: ["null"]});
    const second = evidence({who: ["Casey", "not applicable"], subject: ["Casey"], reportedBy: ["Casey"]});
    for (const [left, right] of [[first, second], [second, first]]) {
      const merged = mergeEvidenceMetadata(left.metadata, right.metadata, reviewed)!;
      expect(merged.who).toEqual(["Casey"]);
      expect(merged.subject).toEqual(["Casey"]);
      expect(merged.reportedBy).toEqual(["Casey"]);
    }
  });

  it.each(["Witness", "Casey"])("checks reporter-only enrichment against its existing support rule (%s)", reporter => {
    const first = evidence({reportedBy: ["Court"]});
    const second = evidence({reportedBy: ["Court", reporter]});
    for (const documents of [[first, second], [second, first]]) {
      expect(deduplicateEvidenceDocuments(documents)).toHaveLength(reporter === "Casey" ? 1 : 2);
    }
  });

  it("allows a cited possessive description without inventing an owner or recombining names", () => {
    const quote = "The bicycle listed as Casey's was sold by Jordan Smith to Alex Jones.";
    const first = evidence({what: "A bicycle was sold.", who: ["Casey"], sourceQuote: quote,
      sourceSpans: [{pageNumber: 1, sourceOffset: 10, sourceQuote: quote}]});
    for (const label of ["Jordan Smith", "Casey's bicycle", "Jordan Jones", "Casey's car", "Jordan's bicycle"]) {
      const second = evidence({...first.metadata, who: ["Casey", label]});
      expect(deduplicateEvidenceDocuments([first, second])).toHaveLength(
        ["Jordan Smith", "Casey's bicycle"].includes(label) ? 1 : 2);
    }
  });

  it("requires a shared cited participant for descriptive enrichment", () => {
    const partial = propertyFact([], {who: ["Unknown"]});
    const fuller = propertyFact(["Petitioner", "Petitioner's personal property"]);
    expect(deduplicateEvidenceDocuments([partial, fuller])).toHaveLength(2);
  });

  it.each([[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]])(
    "absorbs both subsets when a fuller record arrives (order=%s,%s,%s)", (a, b, c) => {
      const quote = "Casey and Jordan paid 250 dollars.";
      const documents = [["Casey"], ["Jordan"], ["Casey", "Jordan"]].map((people, index) => evidence({
        what: quote, sourceQuote: quote, sourceSpans: [{pageNumber: 1, sourceOffset: 10, sourceQuote: quote}],
        who: people, subject: people, extractedBy: [`pass:${index}`],
      }));
      expect(deduplicateEvidenceDocuments(documents.slice(0, 2))).toHaveLength(2);
      const input = [documents[a], documents[b], documents[c]];
      const original = JSON.stringify(input);
      const result = deduplicateEvidenceDocuments(input);
      expect(result).toHaveLength(1);
      expect(result[0].metadata.who.slice().sort()).toEqual(["Casey", "Jordan"]);
      expect(result[0].metadata.subject.slice().sort()).toEqual(["Casey", "Jordan"]);
      expect(result[0].metadata.extractedBy.slice().sort()).toEqual(["pass:0", "pass:1", "pass:2"]);
      expect(deduplicateEvidenceDocuments(result)).toEqual(result);
      expect(JSON.stringify(input)).toBe(original);
    });

  it("does not absorb conflicting records through a fuller participant list", () => {
    const quote = "Casey and Jordan paid 250 dollars.";
    const documents = [["Casey"], ["Jordan"], ["Casey", "Jordan"]].map((people, index) => evidence({
      what: quote, sourceQuote: quote, sourceSpans: [{pageNumber: 1, sourceOffset: 10, sourceQuote: quote}],
      who: people, subject: people, where: ["Office", "School", "Unknown"][index],
    }));
    const result = deduplicateEvidenceDocuments(documents);
    expect(result).toHaveLength(2);
    expect(result.map(item => item.metadata.where).sort()).toEqual(["Office", "School"]);
    expect(deduplicateEvidenceDocuments(result)).toEqual(result);
  });

  it.each(["fact", "claim"])("keeps the shared primary citation when a subset %s upgrades to an event", classification => {
    const partial = propertyFact(["Petitioner"], classification === "claim"
      ? {factType: undefined, tags: ["claim"], claimType: "factualAssertion", claimant: "Unknown", claimPolarity: "asserts"}
      : {});
    const fuller = propertyFact(["Petitioner", "Petitioner's personal property"],
      {factType: undefined, tags: ["event"], eventType: "other"});
    const support = {pageNumber: 106, sourceOffset: 0, sourceQuote: "Supporting context."};
    fuller.metadata.sourceSpans.push(support);
    fuller.metadata.pages.push(106);
    for (const documents of [[partial, fuller], [fuller, partial]]) {
      const result = deduplicateEvidenceDocuments(documents);
      expect(result).toHaveLength(1);
      expect(result[0].metadata.factType).toBeUndefined();
      expect(result[0].metadata.claimType).toBeUndefined();
      expect(result[0].metadata.sourceSpans).toEqual(fuller.metadata.sourceSpans);
      expect(result[0].metadata.sourceOffset).toBe(579);
      expect(result[0].metadata.sourceQuote).toBe(partial.metadata.sourceQuote);
      expect(deduplicateEvidenceDocuments([...result, partial, fuller])).toEqual(result);
    }
  });

  it("does not infer primary identity from a shared supporting citation or a named claim", () => {
    const partial = propertyFact(["Petitioner"]);
    const fuller = propertyFact(["Petitioner", "Petitioner's personal property"],
      {factType: undefined, tags: ["event"], eventType: "other"});
    fuller.metadata.sourceOffset += 200;
    fuller.metadata.sourceSpans = [{...fuller.metadata.sourceSpans[0], sourceOffset: fuller.metadata.sourceOffset},
      partial.metadata.sourceSpans[0]];
    const allegation = propertyFact(["Petitioner", "Petitioner's personal property"],
      {factType: undefined, tags: ["claim"], claimType: "factualAssertion", claimant: "Petitioner", claimPolarity: "asserts"});
    for (const second of [fuller, allegation]) {
      expect(deduplicateEvidenceDocuments([partial, second])).toHaveLength(2);
      expect(deduplicateEvidenceDocuments([second, partial])).toHaveLength(2);
    }
  });

  it.each([false, true])("removes superseded other tags and retains original classifications (reviewed=%s)", reviewed => {
    const generic = evidence({tags: ["fact", "factType:other"], factType: "other"});
    const specific = evidence({tags: ["fact", "factType:assessmentResult"], factType: "assessmentResult"});
    const merged = mergeEvidenceMetadata(generic.metadata, specific.metadata, reviewed)!;
    expect(merged.factType).toBe("assessmentResult");
    expect(merged.tags).toEqual(["fact", "factType:assessmentResult"]);
    expect(merged.evidenceClassifications).toEqual([
      {kind: "fact", type: "other"}, {kind: "fact", type: "assessmentResult"},
    ]);
  });

  it.each([false, true])("preserves an attributed allegation beside the same event (reviewed=%s)", reviewed => {
    const occurrence = evidence({what: "John hit Bob.", who: ["John", "Bob"]});
    const allegation = evidence({what: "John hit Bob.", who: ["John", "Bob"],
      claimType: "allegation", claimant: "Mother", claimPolarity: "asserts", tags: ["claim"]});
    expect(mergeEvidenceMetadata(occurrence.metadata, allegation.metadata, reviewed)).toBeNull();
    expect(mergeEvidenceMetadata(allegation.metadata, occurrence.metadata, reviewed)).toBeNull();
  });

  it.each([false, true])("upgrades a fallback event type without active other tags (reviewed=%s)", reviewed => {
    const generic = evidence({eventType: "other", tags: ["event", "eventType:other"]});
    const specific = evidence({eventType: "payment", tags: ["event", "eventType:payment"]});
    const merged = mergeEvidenceMetadata(generic.metadata, specific.metadata, reviewed)!;
    expect(merged.eventType).toBe("payment");
    expect(merged.tags).toEqual(["event", "eventType:payment"]);
    expect(merged.evidenceClassifications).toEqual([
      {kind: "event", type: "other"}, {kind: "event", type: "payment"},
    ]);
  });

  it("merges the same assertion despite whitespace and supporting-citation differences", () => {
    const first = evidence();
    const support = { pageNumber: 2, sourceOffset: 0, sourceQuote: "The receipt was signed by Casey." };
    const second = evidence({ what: "Casey  paid\n250 dollars.",
      sourceSpans: [...first.metadata.sourceSpans, support], pages: [1, 2],
      tags: ["fact", "event", "eventType:payment", "facet:financial:invoice"],
      extractedBy: ["independent:model"], where: "Office" });
    const original = JSON.stringify([first, second]);

    const result = deduplicateEvidenceDocuments([first, second]);

    expect(result).toHaveLength(1);
    expect(result[0].metadata.sourceSpans).toEqual([...first.metadata.sourceSpans, support]);
    expect(result[0].metadata.extractedBy).toEqual(["primary:model", "independent:model"]);
    expect(result[0].metadata.tags).toContain("facet:financial:invoice");
    expect(result[0].metadata.where).toBe("Office");
    expect(result[0].metadata.pages).toEqual([1, 2]);
    expect(result[0].pageContent).toBe(formatEvidenceContent(result[0].metadata));
    expect(result[0].pageContent).toContain(support.sourceQuote);
    expect(JSON.stringify([first, second])).toBe(original);
    expect(deduplicateEvidenceDocuments(result)).toEqual(result);
  });

  it("retains both primary quotations when one contains the other", () => {
    const short = evidence();
    const quote = "On Friday, Casey paid 250 dollars. The receipt was signed.";
    const long = evidence({ sourceOffset: 0, sourceQuote: quote,
      sourceSpans: [{ pageNumber: 1, sourceOffset: 0, sourceQuote: quote }] });
    // The short citation begins after 'On Friday, '.
    short.metadata.sourceOffset = 11;
    short.metadata.sourceSpans[0].sourceOffset = 11;

    const result = deduplicateEvidenceDocuments([short, long]);

    expect(result).toHaveLength(1);
    expect(result[0].metadata.sourceOffset).toBe(11);
    expect(result[0].metadata.sourceSpans).toEqual([...short.metadata.sourceSpans, ...long.metadata.sourceSpans]);
  });

  it.each([
    ["a different amount", { what: "Casey paid 350 dollars." }],
    ["negation", { what: "Casey did not pay 250 dollars." }],
    ["a paraphrase requiring semantic review", { what: "A payment of 250 dollars was made by Casey." }],
    ["different participants", { who: ["Jordan"] }],
    ["an unsupported additional participant", { who: ["Casey", "Jordan"] }],
    ["a different date", { whenStarted: { year: "2025", month: "3", day: "6" } }],
    ["different known locations", { where: "School" }],
    ["a different cause", { why: "A refund" }],
    ["another source", { sourceId: "source-2" }],
    ["another account", { accountId: "account-2" }],
  ])("preserves %s", (_description, overrides) => {
    expect(deduplicateEvidenceDocuments([evidence({ where: "Office", why: "An invoice" }), evidence(overrides)])).toHaveLength(2);
  });

  it("merges compatible partial dates while retaining the more detailed date", () => {
    const exact = { year: "2025", month: "3", day: "10", season: null, quarter: "Q1" };
    const partial = { year: "2025", month: "3", day: "10", season: null, quarter: null };
    const result = deduplicateEvidenceDocuments([
      evidence({ whenStarted: exact, whenEnded: exact }),
      evidence({ whenStarted: partial, whenEnded: null }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].metadata.whenStarted).toEqual(exact);
    expect(result[0].metadata.whenEnded).toEqual(exact);
  });

  it("does not combine conflicting quarter/month or invalid calendar details", () => {
    const march = evidence({ whenStarted: {year: "2025", month: "3", day: null, quarter: null} });
    const fourthQuarter = evidence({ whenStarted: {year: "2025", month: null, day: null, quarter: "Q4"} });
    const february = evidence({ whenStarted: {year: "2025", month: "2", day: null, quarter: null} });
    const day29 = evidence({ whenStarted: {year: "2025", month: null, day: "29", quarter: null} });
    expect(deduplicateEvidenceDocuments([march, fourthQuarter])).toHaveLength(2);
    expect(deduplicateEvidenceDocuments([february, day29])).toHaveLength(2);
  });

  it("retains a venue-unknown qualifier on the same cited fact", () => {
    const base = { tags:["fact", "factType:condition"], factType:"condition", subject:["Casey"] };
    const result = deduplicateEvidenceDocuments([
      evidence({...base,where:"Interview table"}),
      evidence({...base,where:"Interview table (specific venue unknown)"}),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].metadata.where).toBe("Interview table (specific venue unknown)");
  });

  it("requires review for one inventory assertion with conflicting specific fact types", () => {
    const statement = "An inventory entry records an unsigned envelope on the interview table.";
    const span = {pageNumber:1,sourceOffset:0,sourceQuote:statement};
    const common = {what:statement,sourceQuote:statement,sourceOffset:0,sourceSpans:[span]};
    const documents = [
      evidence({...common,tags:["fact","factType:recordedValue"],factType:"recordedValue",
        who:["envelope"],subject:["envelope"]}),
      evidence({...common,tags:["fact","factType:attribute"],factType:"attribute",
        who:["Envelope"],subject:["Envelope"]}),
    ];
    expect(deduplicateEvidenceDocuments(documents)).toHaveLength(2);
    const merged = mergeEvidenceMetadata(documents[0].metadata, documents[1].metadata, true)!;
    expect(merged.factType).toBe("recordedValue");
    expect(merged.tags).toEqual(["fact", "factType:recordedValue"]);
    expect(merged.evidenceClassifications).toEqual(expect.arrayContaining([
      {kind: "fact", type: "recordedValue"}, {kind: "fact", type: "attribute"},
    ]));
    expect(merged.subject).toEqual(["envelope"]);
  });

  it("requires review to merge a partial identity mapping into a relationship classification", () => {
    const statement = "Witness code W-17 identifies Morgan Hale.";
    const span = { pageNumber: 1, sourceOffset: 0, sourceQuote: statement };
    const partial = evidence({ what: statement, sourceOffset: 0, sourceQuote: statement, sourceSpans: [span],
      tags: ["fact", "factType:attribute", "facet:evidence:witnessIdentity"], factType: "attribute",
      who: ["Morgan Hale"], subject: ["Morgan Hale"] });
    const fuller = evidence({ what: statement, sourceOffset: 0, sourceQuote: statement, sourceSpans: [span],
      tags: ["fact", "factType:relationship", "facet:evidence:documentIdentity"], factType: "relationship",
      who: ["Morgan Hale", "Witness code W-17"], subject: ["Morgan Hale", "Witness code W-17"] });

    expect(deduplicateEvidenceDocuments([partial, fuller])).toHaveLength(2);
    const merged = mergeEvidenceMetadata(partial.metadata, fuller.metadata, true)!;
    expect(merged.factType).toBe("relationship");
    expect(merged.tags).toEqual(expect.arrayContaining(["factType:relationship"]));
    expect(merged.tags).not.toContain("factType:attribute");
    expect(merged.subject).toEqual(["Morgan Hale", "Witness code W-17"]);
    expect(merged.who).toEqual(["Morgan Hale", "Witness code W-17"]);
  });

  it("merges the source's short and long witness-code labels without repeating the code", () => {
    const statement = "Witness code W-17 identifies Morgan Hale.";
    const span = { pageNumber: 1, sourceOffset: 0, sourceQuote: statement };
    const common = {what: statement, sourceOffset: 0, sourceQuote: statement, sourceSpans: [span],
      tags: ["fact", "factType:relationship"], factType: "relationship"};
    const result = deduplicateEvidenceDocuments([
      evidence({...common, who: ["W-17", "Morgan Hale"], subject: ["W-17", "Morgan Hale"]}),
      evidence({...common, who: ["Morgan Hale", "Witness code W-17"],
        subject: ["Morgan Hale", "Witness code W-17"]}),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].metadata.who).toEqual(["Witness code W-17", "Morgan Hale"]);
    expect(result[0].metadata.subject).toEqual(["Witness code W-17", "Morgan Hale"]);
  });

  it("preserves conflicting specific fact types for review", () => {
    const result = deduplicateEvidenceDocuments([
      evidence({tags:["fact", "factType:attribute"],factType:"attribute",subject:["Casey"]}),
      evidence({tags:["fact", "factType:relationship"],factType:"relationship",subject:["Casey"]}),
    ]);
    expect(result).toHaveLength(2);
    expect(result.map(doc => doc.metadata.factType)).toEqual(["attribute", "relationship"]);
  });

  it("preserves different claimants and polarity even for identical statements and quotations", () => {
    const base = { tags: ["claim"], claimType: "factualAssertion", claimant: "Casey", claimPolarity: "asserts" };
    expect(deduplicateEvidenceDocuments([
      evidence(base), evidence({ ...base, claimant: "Jordan" }),
      evidence({ ...base, claimant: "Unknown" }), evidence({ ...base, claimPolarity: "denies" }),
    ])).toHaveLength(4);
  });

  it("preserves different subjects and reporters for identical assessment results", () => {
    const base = { tags: ["fact"], factType: "assessmentResult", subject: ["Casey"], reportedBy: ["Parent"] };
    expect(deduplicateEvidenceDocuments([
      evidence(base), evidence({ ...base, subject: ["Jordan"] }), evidence({ ...base, reportedBy: ["Teacher"] }),
    ])).toHaveLength(3);
  });

  it("merges repeated statements on one page while preserving other pages", () => {
    const first = evidence();
    const samePage = evidence({ sourceOffset: 100,
      sourceSpans: [{ pageNumber: 1, sourceOffset: 100, sourceQuote: first.metadata.sourceQuote }] });
    const nextPage = evidence({ pages: [2],
      sourceSpans: [{ pageNumber: 2, sourceOffset: 10, sourceQuote: first.metadata.sourceQuote }] });
    const result = deduplicateEvidenceDocuments([first, samePage, nextPage]);
    expect(result).toHaveLength(2);
    expect(result[0].metadata.sourceSpans).toEqual([...first.metadata.sourceSpans, ...samePage.metadata.sourceSpans]);
  });
});
