import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { prepareConsistencyRecords, prepareReviewedExamples, detectEvidenceConsistency, labelDifferences,
  groupRepeatedQuotations, type ConsistencyRecord } from "../src/processors/evidence/evidenceConsistency.ts";
import { assessAssertionAlignment } from "../src/processors/evidence/evidenceAssertionAlignment.ts";

const observation="Casey seemed comfortable with the examiner.";
const claim={claimType:"opinion",claimPolarity:"asserts",claimant:"Avery",factType:undefined,tags:["claim","facet:medical:observation"]};
function fixture(quotes=[observation],overrides:Record<string,unknown>[]=[{}],pageContent?:string,sourceId="source-1") {
  const source=new Document({pageContent:pageContent??`## Observations\n\n${quotes.join("\n\n")}`,metadata:{sourceId,pages:[1]}});
  const evidence=new EvidenceSource(source);
  const documents=overrides.map((fields,index)=>{
    const quote=quotes[index%quotes.length],page=evidence.pages.find(page=>page.text.includes(quote))!;
    const span={pageNumber:page.pageNumber,sourceOffset:page.text.indexOf(quote),sourceQuote:quote};
    return new Document({pageContent:"Generated Fact: RENDERED_LABEL",metadata:{what:quote,factType:"condition",tags:["fact","facet:medical:observation"],
      sourceId,sourceContentHash:evidence.contentHash,pages:[span.pageNumber],sourceOffset:span.sourceOffset,sourceQuote:quote,sourceSpans:[span],
      who:["Casey"],classificationHistory:[{ruleId:"GENERATED_RULE"}],...fields}});
  });
  return {source,documents,records:()=>prepareConsistencyRecords(documents,source)};
}
function reference(record:ConsistencyRecord,label=record.label):ConsistencyRecord {
  return {...record,id:`reviewed:${record.id}`,sourceId:`other:${record.sourceId}`,sourceContentHash:`other:${record.sourceContentHash}`,
    documentGroup:`other:${record.documentGroup}`,label,review:{reviewer:"Synthetic test reviewer",reviewedAt:"2025-01-01T00:00:00Z",rationale:"Synthetic test annotation, not benchmark gold."}};
}

describe("evidence consistency source representation",()=>{
  it("excludes generated labels, claimant fields, proposition wording and audit from embeddings",()=>{
    const f=fixture([observation],[{},{...claim,what:"Generated CLAIM_PROPOSITION",claimant:"GENERATED_CLAIMANT"}]);
    const before=JSON.stringify(f.documents),records=f.records();
    expect(records[0].embeddingInput).toBe(records[1].embeddingInput);
    expect(records[0].inputHash).toBe(records[1].inputHash);
    expect(records[0].embeddingInput).not.toMatch(/RENDERED_LABEL|GENERATED_RULE|CLAIM_PROPOSITION|GENERATED_CLAIMANT/);
    expect(JSON.parse(records[0].embeddingInput)).toMatchObject({quote:observation,section:"Observations"});
    expect(JSON.stringify(f.documents)).toBe(before);
  });
  it("retains original source words even when they look like labels",()=>{
    const f=fixture(["Claim by the parent: the child was tired."]);
    expect(f.records()[0].embeddingInput).toContain("Claim by the parent");
  });
  it("reports bounded source input truncation while retaining the full review citation",()=>{
    const quote="Clinical source statement. ".repeat(200);
    const record=fixture([quote]).records()[0];
    expect(record.inputTruncated).toBe(true);
    expect(JSON.parse(record.embeddingInput).quote).toHaveLength(2400);
    expect(record.sourceSpans[0].sourceQuote).toBe(quote);
  });
  it.each(["sourceId","sourceContentHash","sourceOffset","sourceQuote","pages","sourceSpans"])("rejects invalid %s",field=>{
    const f=fixture();
    f.documents[0].metadata[field]={sourceId:"other",sourceContentHash:"bad",sourceOffset:200,sourceQuote:"bad",pages:[9],
      sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:"bad"}]}[field];
    expect(()=>f.records()).toThrow("Unverified");
  });
});

describe("observation-only consistency detection",()=>{
  it("finds cross-kind disagreements and never changes evidence",()=>{
    const f=fixture([observation],[{},claim]),records=f.records(),before=JSON.stringify(records);
    const result=detectEvidenceConsistency(records);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({differences:["evidence-kind"],discovery:["quotation-group","citation-lexical"],
      alignment:{status:"likely-aligned"},review:{verdict:"",notes:""}});
    expect(result.stats.embeddingPairsExamined).toBe(0);
    expect(JSON.stringify(records)).toBe(before);
  });
  it("finds subtype, facet and polarity disagreements separately",()=>{
    const base={kind:"claim" as const,type:"opinion",polarity:"asserts" as const,facets:["facet:medical:observation"]};
    expect(labelDifferences(base,{...base,type:"denial",polarity:"denies",facets:[]})).toEqual(["subtype","polarity","facets"]);
    expect(detectEvidenceConsistency(fixture([observation],[claim,{...claim,claimPolarity:"uncertain"}]).records()).items[0].differences).toEqual(["polarity"]);
  });
  it("does not flag identical labels or unrelated propositions in a broad quote",()=>{
    expect(detectEvidenceConsistency(fixture([observation],[{},{}]).records()).items).toEqual([]);
    const quote="Casey's score was 97. Avery recommended extra time for reading.";
    const records=fixture([quote],[{what:"Casey's score was 97."},{...claim,what:"Avery recommended extra time for reading."}]).records();
    expect(detectEvidenceConsistency(records).items).toEqual([]);
  });
  it("retrieves paraphrases through vectors when citations do not overlap",()=>{
    const f=fixture([observation,"The child appeared relaxed during testing."],[{},claim]),records=f.records();
    expect(detectEvidenceConsistency(records).items).toEqual([]);
    const result=detectEvidenceConsistency(records,{vectors:[[1,0],[0.99,0.01]]});
    expect(result.items).toHaveLength(1);
    expect(result.items[0].discovery).toEqual(["embedding"]);
    expect(result.items[0]).not.toHaveProperty("confidence");
    expect(detectEvidenceConsistency(records,{vectors:[[1,0],[0,1]]}).items).toEqual([]);
  });
  it("keeps material field differences visible rather than excluding them from consistency review",()=>{
    const f=fixture(["Casey did not appear tense during the examination."],[{...claim},{...claim,claimPolarity:"denies",who:["Jordan"],
      whenStarted:{year:"2025"},claimant:"Morgan",what:"Casey did appear tense during the examination."}]);
    expect(detectEvidenceConsistency(f.records()).items[0].riskDifferences).toEqual(expect.arrayContaining(["negation","attribution","people","dates"]));
  });
  it("enforces queue and comparison budgets and exposes incomplete coverage",()=>{
    const records=fixture([observation],Array.from({length:8},(_,i)=>i%2 ? claim : {})).records();
    const result=detectEvidenceConsistency(records,{maxPairs:1,maxComparisons:2,vectors:records.map(()=>[1,0])});
    expect(result.items).toHaveLength(1);
    expect(result.stats.lexicalComparisons).toBe(2);
    expect(result.stats.embeddingPairsExamined).toBe(2);
    expect(result.stats.lexicalBudgetExhausted).toBe(true);
    expect(result.stats.embeddingBudgetExhausted).toBe(true);
    expect(result.stats.quotationComparisons).toBe(2);
    expect(result.stats.quotationBudgetExhausted).toBe(true);
    expect(detectEvidenceConsistency(records,{maxPairs:1}).stats.queueTruncated).toBe(true);
  });
  it.each([
    {vectors:[[0,0]]},{vectors:[[NaN,1]]},{vectors:[]},{vectors:[[1,0],[1,0,0]]},
    {maxComparisons:0},{topK:0},{maxPairs:-1},{embeddingThreshold:NaN},{lexicalThreshold:2},
  ])("rejects malformed vectors or options: %j",options=>{
    expect(()=>detectEvidenceConsistency(fixture().records(),options)).toThrow();
  });
  it("retrieves agreeing reference examples too, instead of cherry-picking dissent",()=>{
    const [record]=fixture().records();
    const same=reference(record),different=reference({...record,id:"different"},{kind:"claim",type:"opinion",polarity:"asserts",facets:[]});
    expect(detectEvidenceConsistency([record],{vectors:[[1,0]],examples:[same,different],exampleVectors:[[1,0],[0.95,0.2]],topK:1}).items).toEqual([]);
    const result=detectEvidenceConsistency([record],{vectors:[[1,0]],examples:[same,different],exampleVectors:[[1,0],[0.95,0.2]],topK:2});
    expect(result.items).toHaveLength(1);
    expect(result.items[0].discovery).toEqual(["reviewed-example"]);
    expect(result.items[0].reviewedNeighbors).toHaveLength(2);
  });
  it("rejects unreviewed references and excludes source/group leakage even when called directly",()=>{
    const [record]=fixture().records();
    expect(()=>detectEvidenceConsistency([record],{examples:[record]})).toThrow("adjudication");
    const example={...reference(record),documentGroup:record.documentGroup,label:{kind:"claim" as const,type:"opinion",polarity:"asserts" as const,facets:[]}};
    expect(detectEvidenceConsistency([record],{vectors:[[1,0]],examples:[example],exampleVectors:[[1,0]]}).items).toEqual([]);
  });
});

describe("quotation grouping and assertion alignment",()=>{
  it("groups exact repeated wording across occurrences without merging members, labels or citations",()=>{
    const f=fixture([observation],[{},claim],`${observation}\n\n${observation}`);
    const offset=f.source.pageContent.lastIndexOf(observation);
    f.documents[1].metadata.sourceOffset=offset;
    f.documents[1].metadata.sourceSpans[0].sourceOffset=offset;
    const records=f.records(),before=JSON.stringify(records),result=detectEvidenceConsistency(records);
    expect(result.quotationGroups).toHaveLength(1);
    expect(result.quotationGroups[0].members.map(member=>member.sourceSpans[0].sourceOffset)).toEqual([0,offset]);
    expect(result.items[0].discovery).toEqual(["quotation-group"]);
    expect(result.quotationGroups[0].reviewPairIds).toEqual([result.items[0].id]);
    expect(result.quotationGroups[0].likelyAlignedPairIds).toEqual([result.items[0].id]);
    expect(JSON.stringify(records)).toBe(before);
  });
  it("normalizes whitespace only and isolates source IDs and hashes",()=>{
    const [a]=fixture().records();
    const b={...a,id:"b",index:1,sourceSpans:[{...a.sourceSpans[0],sourceQuote:observation.replaceAll(" ","\n")} ]};
    expect(groupRepeatedQuotations([a,b])).toHaveLength(1);
    expect(groupRepeatedQuotations([a,{...b,sourceId:"other"}])).toEqual([]);
    expect(groupRepeatedQuotations([a,{...b,sourceContentHash:"other"}])).toEqual([]);
    expect(groupRepeatedQuotations([a,{...b,sourceSpans:[{...b.sourceSpans[0],sourceQuote:observation.toUpperCase()}]}])).toEqual([]);
  });
  it("keeps different clauses sharing a vector out of the aligned priority queue",()=>{
    const quote="Casey was compliant with the examiner and seemed to want to do well.";
    const records=fixture([quote],[{what:"Casey was compliant with the examiner."},{...claim,what:"Casey seemed to want to do well."}]).records();
    const result=detectEvidenceConsistency(records,{vectors:[[1,0],[1,0]]});
    expect(result.items).toHaveLength(1);
    expect(result.items[0].cosineSimilarity).toBe(1);
    expect(result.items[0].alignment.status).toBe("related-only");
    expect(result.summary.alignedPriorityPairs).toBe(0);
    expect(result.quotationGroups[0].members).toHaveLength(2);
  });
  it("keeps word-matched observations with expanded examiner names available for review",()=>{
    const quote="Casey was compliant with examiner Avery North.";
    const records=fixture([quote],[{what:"Casey was compliant with the examiner.",who:["Casey","Avery North"]},
      {...claim,what:quote,claimant:"Avery North",who:["Casey","Avery North"]}]).records();
    expect(assessAssertionAlignment(...records as [ConsistencyRecord,ConsistencyRecord]).status).toBe("likely-aligned");
    expect(detectEvidenceConsistency(records).items[0].discovery).toContain("quotation-group");
  });
  it.each([
    ["Casey was walking within normal limits.","Casey was talking within normal limits."],
    ["Casey's talking development was within normal limits.","Casey's walking development was within normal limits."],
    ["Casey's academic ability was assessed in the average range.","Casey's academic ability was assessed in the above average range."],
    ["Casey's score was >= 65.","Casey's score was > 65."],
    ["Casey will receive the scheduled payment next month.","Casey received the scheduled payment next month."],
    ["The payment was sent to Casey.","The payment was sent by Casey."],
    ["Casey completed the assessment.","The assessment measures fine motor skills."],
    ["Casey was working on writing letters.","Casey's parents expressed concern about pre-reading skills."],
    ["Casey's score was 97.","Casey's score was 79."],
    ["Casey did not appear tense during testing.","Casey did appear tense during testing."],
    ["Casey may require additional time.","Casey requires additional time."],
    ["Casey reported the missed payment.","Casey missed the payment."],
    ["Casey paid Avery.","Avery paid Casey."],
    ["Casey needed additional time.","Casey needed additional time and a quiet room with frequent breaks."],
  ])("does not promote distinct or qualified assertions: %s / %s",(left,right)=>{
    const records=fixture([`${left} ${right}`],[{what:left,who:["Casey","Avery"]},{...claim,what:right,who:["Casey","Avery"]}]).records();
    expect(assessAssertionAlignment(records[0],records[1]).status).not.toBe("likely-aligned");
  });
  it("protects participant order even in a long, otherwise identical statement",()=>{
    const left="Casey paid Avery the full outstanding balance for the services provided during the previous calendar month.";
    const right="Avery paid Casey the full outstanding balance for the services provided during the previous calendar month.";
    const records=fixture([`${left} ${right}`],[{what:left,who:["Casey","Avery"]},{...claim,what:right,who:["Casey","Avery"]}]).records();
    expect(assessAssertionAlignment(records[0],records[1])).toMatchObject({status:"uncertain",reasons:["participant-order-or-repetition-differs"]});
  });
  it("keeps different recipients uncertain even when the payer and action match",()=>{
    const left="Casey paid Avery the remaining invoice balance.",right="Casey paid Jordan the remaining invoice balance.";
    const records=fixture([`${left} ${right}`],[{what:left,who:["Casey","Avery"]},{...claim,what:right,who:["Casey","Jordan"]}]).records();
    expect(assessAssertionAlignment(records[0],records[1])).toMatchObject({status:"uncertain",reasons:["named-participants-differ"]});
  });
  it("does not use taxonomy labels or vector scores to establish alignment",()=>{
    const [a,b]=fixture([observation],[{},claim]).records();
    const alignment=assessAssertionAlignment(a,b);
    expect(assessAssertionAlignment({...a,label:b.label},{...b,label:a.label})).toEqual(alignment);
    expect(alignment.status).toBe("likely-aligned");
  });
  it("bounds statement alignment and retains oversized candidates as uncertain",()=>{
    const records=fixture(["word ".repeat(300)],[{},claim]).records();
    expect(assessAssertionAlignment(records[0],records[1])).toMatchObject({status:"uncertain",reasons:["statement-too-long-for-alignment"]});
  });
});

describe("reviewed-example bundle",()=>{
  function bundle(){
    const f=fixture(["The learner appeared calm throughout testing."],[{}],undefined,"review-source"),[record]=f.records();
    return {version:1,scope:"account-1",sources:[{sourceId:record.sourceId,documentGroup:"review-group",pageContent:f.source.pageContent,pages:[1]}],
      examples:[{id:"example-1",sourceId:record.sourceId,sourceContentHash:record.sourceContentHash,sourceSpans:record.sourceSpans,
        label:{kind:"claim",type:"opinion",polarity:"asserts",facets:[]},
        review:{status:"human-reviewed",reviewer:"Synthetic test reviewer",reviewedAt:"2025-01-01T00:00:00Z",rationale:"Synthetic test only."}}]};
  }
  it("requires explicit reviewed labels and exact source citations",()=>{
    const value=bundle(),target=fixture().records();
    expect(prepareReviewedExamples(value,"account-1",target).records).toHaveLength(1);
    expect(()=>prepareReviewedExamples(value,"account-2",target)).toThrow("scope");
    value.examples[0].sourceSpans[0].sourceOffset++;
    expect(()=>prepareReviewedExamples(value,"account-1",target)).toThrow("Unverified");
  });
  it("excludes related document groups and disallows unreviewed or duplicate examples",()=>{
    const value=bundle(),target=fixture().records();
    value.sources[0].documentGroup=target[0].documentGroup;
    expect(prepareReviewedExamples(value,"account-1",target)).toMatchObject({records:[],excludedSameDocument:1});
    value.examples[0].review.status="model-reviewed";
    expect(()=>prepareReviewedExamples(value,"account-1",target)).toThrow();
    value.examples[0].review.status="human-reviewed";value.examples.push(value.examples[0]);
    expect(()=>prepareReviewedExamples(value,"account-1",target)).toThrow("Duplicate");
  });
});
