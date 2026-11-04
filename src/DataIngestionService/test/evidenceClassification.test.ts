import { Document } from "@langchain/core/documents";
import { describe, expect, it, vi } from "vitest";
import { classifyEvidenceDocuments, EVIDENCE_CLASSIFICATION_RULE_VERSION } from "../src/processors/evidence/evidenceClassification.ts";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { formatEvidenceContent } from "../src/processors/evidence/evidenceContent.ts";
import { deduplicateEvidenceDocuments } from "../src/processors/evidence/evidenceDeduplication.ts";
import { applyCanonicalizationDecisions, findCanonicalizationPairs } from "../src/processors/evidence/evidenceCanonicalization.ts";

const emptyDate = {year:null,month:null,day:null,season:null,quarter:null};
const examiner = "**Examiner:** Avery North";
function fixture(quote: string, what = quote, options: {
  section?: string; paragraph?: string; metadata?: Record<string, unknown>;
} = {}) {
  const source = new Document({pageContent: `${examiner}\n\n## ${options.section ?? "Observations"}\n\n${options.paragraph ?? quote}`,
    metadata:{pages:[1],sourceId:"classification-test"}});
  const primary = {pageNumber:1,sourceOffset:source.pageContent.indexOf(quote),sourceQuote:quote};
  const metadata = {what, factType:"condition", subject:["Casey"], reportedBy:["Avery North"],
    who:["Casey","Avery North"],where:"Clinic",why:"Unknown",asOf:emptyDate,whenStarted:emptyDate,whenEnded:null,
    tags:["fact","factType:condition","facet:medical:observation","custom-tag"],
    headers:["condition","Clinic",JSON.stringify(emptyDate)],evidenceSchemaVersion:"3",sourceId:"classification-test",
    sourceContentHash:new EvidenceSource(source).contentHash,sourceQuote:quote,sourceOffset:primary.sourceOffset,pages:[1],
    sourceSpans:[primary,{pageNumber:1,sourceOffset:0,sourceQuote:examiner}],
    extractedBy:["primary:model","independent:model"], ...options.metadata};
  const document = new Document({metadata,pageContent:formatEvidenceContent(metadata)});
  return {source,document, run: () => classifyEvidenceDocuments([document],source)};
}

describe("source-grounded deterministic classification", () => {
  it.each([
    ["He did not appear tense", "Casey did not appear tense.", "asserts"],
    ["seemed comfortable with the examiner.", "Casey seemed comfortable with the examiner.", "asserts"],
  ])("classifies the saved observation passage %s as an opinion", (quote,what,polarity) => {
    const result = fixture(quote,what,{paragraph:"He did not appear tense and seemed comfortable with the examiner."}).run();
    expect(result.changes).toHaveLength(1);
    expect(result.documents[0].metadata).toMatchObject({claimType:"opinion",claimPolarity:polarity,claimant:"Avery North"});
    expect(result.documents[0].metadata.factType).toBeUndefined();
    expect(result.changes[0].trace.ruleId).toBe("source-subjective-observation");
  });

  const academic = "Academic ability was in the high average range with a strength for math reasoning and a weakness for timed math paper-pencil calculation and spelling.";
  it.each([academic,"Casey's academic ability was reported in the high-average range, with a strength in math reasoning and weaknesses in timed math paper-pencil calculation and spelling.",
    "Casey's academic ability was classified in the high average range."])(
    "distinguishes the saved Impressions conclusion from a measured score: %s", what => {
      const result = fixture(academic,what,{section:"Impressions",metadata:{factType:"assessmentResult"}}).run();
      expect(result.changes[0].trace.ruleId).toBe("section-supported-interpretation");
      expect(result.documents[0].metadata.claimType).toBe("opinion");
    });

  it.each([
    ["Casey qualifies for a Specific Learning Disorder with impairment in reading and written expression.","Impressions","opinion","asserts"],
    ["The findings suggest a possible attention disorder in Casey.","Assessment","opinion","uncertain"],
    ["The examiner recommends extended time for Casey's testing.","Recommendations","opinion","asserts"],
    ["Family relationships are reported as close and supportive.","History","factualAssertion","asserts"],
    ["Casey denied taking the missing vehicle.","History","denial","denies"],
  ])("reclassifies clear source-supported claim: %s", (quote,section,claimType,claimPolarity) => {
    expect(fixture(quote,quote,{section}).run().documents[0].metadata).toMatchObject({claimType,claimPolarity});
  });

  it.each([
    "| WJ-IV Total Achievement | 97 | 43 | Average |",
    "| Fluid Reasoning | 114 | 82 | High Average |",
    "| Parent-reported Problem Behaviors | 130 | High Risk |",
    "The father-reported CBC Anxious-Depressed scale was Borderline, T-score 65, percentile 93.",
    "Casey's score was 114 at the 82nd percentile, High Average.",
    "Casey's academic ability score was 114, classified as high average.",
    "The CBC has six DSM-Oriented Scales indicating possible diagnostic areas.",
    "The report lists a recorded diagnosis of F81.0.",
    "The resource is titled Possible Solutions for Parents.",
    "The examination took place in May 2025.",
    "The plan allows changes where possible.",
    "Consent is limited to the use of this report by the requesting agency and its consultants.",
    "The report describes the CBC as containing six DSM-Oriented Scales that indicate possible diagnostic areas.",
    "The recommended home reading program is titled Teach Your Child to Read.",
  ])("protects recorded information: %s", quote => {
    const f = fixture(quote,quote,{section:"Impressions"});
    expect(f.run().documents[0]).toBe(f.document);
  });

  it("does not classify every statement under Impressions as a claim", () => {
    const f = fixture("Casey is a five year old boy preparing to start kindergarten.",undefined,{section:"Impressions"});
    expect(f.run().changes).toHaveLength(0);
  });

  it("does not borrow a hedge from another sentence in a broad primary quote", () => {
    const f = fixture("Casey attends Oak School. The examiner suggests an attention disorder.","Casey attends Oak School.");
    expect(f.run().changes).toHaveLength(0);
  });

  it("does not borrow a hedge from supporting citations or an adjacent paragraph", () => {
    const f = fixture("Casey attends Oak School.",undefined,{paragraph:"The examiner suggests an attention disorder.\n\nCasey attends Oak School."});
    f.document.metadata.sourceSpans.push({pageNumber:1,sourceOffset:f.source.pageContent.indexOf("The examiner suggests"),
      sourceQuote:"The examiner suggests an attention disorder."});
    expect(f.run().changes).toHaveLength(0);
  });

  it.each([
    ["Casey's score was 97, which suggests an attention disorder.",undefined,"mixed-measurement-interpretation"],
    ["Casey attends Oak School.","Casey may have attended Oak School.","ambiguous-source-context"],
    ["| Reading | Possible impairment |",undefined,"ambiguous-table-interpretation"],
  ])("flags ambiguous evidence without losing it: %s", (quote,what,ruleId) => {
    const f = fixture(quote,what);
    // Interpretive wording in a table must also be explicitly guarded.
    if (ruleId === "ambiguous-table-interpretation") f.document.metadata.what = "Reading indicates possible impairment.";
    const result = f.run();
    expect(result.changes).toHaveLength(0);
    expect(result.flags[0].trace.ruleId).toBe(ruleId);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].pageContent).toBe(f.document.pageContent);
    expect(result.documents[0].metadata.factType).toBe("condition");
  });

  it.each([
    [[],"Unknown"],[["Uncited Name"],"Unknown"],[["Avery North","Casey"],"Unknown"],
    [["Avery North"],"Avery North"],[["Avery Nort"],"Unknown"],[["Unknown report author"],"Unknown"],
  ])("uses only one cited existing reporter: %j", (reportedBy,claimant) => {
    const f = fixture("Casey seemed comfortable with the examiner.",undefined,{metadata:{reportedBy}});
    expect(f.run().documents[0].metadata.claimant).toBe(claimant);
  });

  it("does not substitute a report author for a parent reporting symptoms", () => {
    const f = fixture("The mother reported that Casey had trouble sleeping.");
    expect(f.run().documents[0].metadata.claimant).toBe("Unknown");
  });

  it.each(["Casey denied taking the missing vehicle.","Family relationships are reported as close and supportive."])(
    "does not substitute an examiner header for a reported speaker: %s", quote => {
      expect(fixture(quote).run().documents[0].metadata.claimant).toBe("Unknown");
    });

  it("preserves dates, evidence, provenance and facets; rebuilds search content and records an immutable audit", () => {
    const date = {...emptyDate,year:"2025",month:"3"};
    const f = fixture("Casey's performance suggests an attention disorder.",undefined,{metadata:{asOf:date}});
    const before = JSON.stringify(f.document);
    const result = f.run();
    const after = result.documents[0];
    expect(after.metadata.whenStarted).toEqual(date);
    expect(after.metadata.asOf).toBeUndefined();
    for (const field of ["who","subject","reportedBy","sourceSpans","sourceContentHash","sourceOffset","sourceQuote","extractedBy"])
      expect(after.metadata[field]).toEqual(f.document.metadata[field]);
    expect(after.metadata.tags).toEqual(["facet:medical:observation","custom-tag","claim","claimType:opinion","claimPolarity:uncertain"]);
    expect(after.pageContent).toContain("Claim by Avery North (opinion; uncertain)");
    expect(after.pageContent).toContain("Date referenced by the claim: March 2025");
    expect(after.pageContent).toBe(formatEvidenceContent(after.metadata));
    expect(result.changes[0].trace).toMatchObject({version:EVIDENCE_CLASSIFICATION_RULE_VERSION,original:{asOf:date,factType:"condition"}});
    expect(JSON.stringify(f.document)).toBe(before);
    expect(classifyEvidenceDocuments(result.documents,f.source)).toMatchObject({documents:result.documents,changes:[],flags:[]});
  });

  it("retains anomalous extra date fields for review instead of overwriting them", () => {
    const f = fixture("Casey seemed comfortable with the examiner.",undefined,{metadata:{whenStarted:{...emptyDate,year:"2020"}}});
    const result = f.run();
    expect(result.flags[0].trace.ruleId).toBe("ambiguous-fact-date-fields");
    expect(result.documents[0].metadata.whenStarted.year).toBe("2020");
  });

  it.each(["sourceContentHash","sourceOffset","sourceQuote","pages","sourceSpans"])("rejects unverified %s", field => {
    const f = fixture("Casey seemed comfortable with the examiner.");
    f.document.metadata[field] = {sourceContentHash:"wrong",sourceOffset:900,sourceQuote:"not the source",pages:[9],
      sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:"tampered"}]}[field];
    expect(() => f.run()).toThrow("verified source identity and citations");
  });

  it("corrects denies for an asserted negative observation but preserves speaker, wording and dates", () => {
    const f = fixture("He did not appear tense and seemed comfortable with the examiner.","Casey did not appear tense during evaluation.",
      {metadata:{factType:undefined,claimType:"opinion",claimant:"Avery North",claimPolarity:"denies",tags:["claim","claimType:opinion","claimPolarity:denies"],whenStarted:{year:"2018"}}});
    const result = f.run();
    expect(result.documents[0].metadata).toMatchObject({what:f.document.metadata.what,claimant:"Avery North",claimPolarity:"asserts",whenStarted:{year:"2018"}});
    expect(result.changes[0].trace.action).toBe("polarity-corrected");
    expect(result.changes[0].trace.original.claimPolarity).toBe("denies");
  });

  it.each(["Casey seemed comfortable with the examiner.","Casey denied that he did not appear tense."])(
    "flags uncertain observation polarity or explicit denials without rewriting them: %s", quote => {
      const f = fixture(quote,undefined,{metadata:{factType:undefined,claimType:"opinion",claimant:"Avery North",claimPolarity:"uncertain",tags:["claim"]}});
      expect(f.run().flags[0].trace.ruleId).toBe("observation-polarity-review");
      expect(f.run().documents[0].metadata.claimPolarity).toBe("uncertain");
    });

  it("leaves other claims and events unchanged and uses no network", () => {
    const fetch = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Unexpected network call"));
    try {
      const event = fixture("Casey met the examiner.",undefined,{metadata:{factType:undefined,tags:["event"]}});
      const claim = fixture("Casey's score was 97.",undefined,{metadata:{factType:undefined,claimType:"factualAssertion",claimant:"Avery North",claimPolarity:"asserts",tags:["claim"]}});
      expect(event.run().documents[0]).toBe(event.document);
      expect(claim.run().documents[0]).toBe(claim.document);
      expect(fetch).not.toHaveBeenCalled();
    } finally {fetch.mockRestore();}
  });

  it.each(["strict","canonical"])("preserves classification audit through %s merges", mode => {
    const f = fixture("Casey seemed comfortable with the examiner.");
    const left = f.run().documents[0];
    const right = new Document({pageContent:left.pageContent,metadata:{...left.metadata,
      classificationHistory:[{...left.metadata.classificationHistory[0],id:"another-original",original:{factType:"attribute"}}]}});
    const documents = [left,right];
    const pairs = findCanonicalizationPairs(documents);
    const merged = mode === "strict" ? deduplicateEvidenceDocuments(documents)
      : applyCanonicalizationDecisions(documents,pairs,[{pairId:pairs[0].id,survivor:"left",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Same observation."}]).documents;
    expect(merged).toHaveLength(1);
    expect(merged[0].metadata.classificationHistory).toHaveLength(2);
  });
});
