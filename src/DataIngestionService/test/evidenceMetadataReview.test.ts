import { describe, expect, it } from "vitest";
import { Document } from "@langchain/core/documents";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { applyCanonicalizationDecisions, findCanonicalizationPairs, type CanonicalizationDecision, type CanonicalizationPair } from "../src/processors/evidence/evidenceCanonicalization.ts";
import { partitionIdentityDecisions } from "../src/processors/evidence/evidenceIdentityReview.ts";
import { mergeEvidenceMetadata } from "../src/processors/evidence/evidenceDeduplication.ts";
import { eventCitationId } from "../src/processors/evidence/evidenceEventStructure.ts";

function fixture(what = "Morgan's test score was 118.", quote = what) {
  const header = "**Client:** Alex Morgan Lane\nParents: Taylor Lane and Jordan Reed\nMorgan is the familiar name used for the client.\nMorgan's mother is Jordan Reed.\nMorgan's father is Taylor Lane.";
  const source = new EvidenceSource(new Document({pageContent:header + "<!-- PageBreak -->" + quote,
    metadata:{sourceId:"source",pages:[1,2]}}));
  const primary = {pageNumber:2,sourceOffset:0,sourceQuote:quote};
  const support = {pageNumber:1,sourceOffset:0,sourceQuote:header};
  const record = (changes: Record<string, unknown> = {}) => new Document({pageContent:what,metadata:{
    accountId:"account",sourceId:"source",sourceContentHash:source.contentHash,source:"document",title:"Report",evidenceSchemaVersion:1,
    what,who:["Morgan"],subject:["Morgan"],reportedBy:[],factType:"attribute",where:"Unknown",why:"Unknown",
    tags:["fact"],sourceQuote:quote,sourceOffset:0,sourceSpans:[primary,support],pages:[2,1],...changes}});
  return {source,record,primary};
}

function approval(pair: CanonicalizationPair, documents: Document[]): CanonicalizationDecision {
  return {pairId:pair.id,survivor:pair.allowedSurvivors[0],reason:"Same source-supported assertion and participants.",
    relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:[],semanticAssessment:{relationship:"equivalent",contextualDetails:[]},
    metadataResolutions:pair.metadataReview?.fields.map(field => ({field,
      explanation:"The participant header and both passages establish compatible labels/annotations for this assertion.",
      citations:[{side:"left",citationIndex:0,sourceQuote:documents[pair.leftIndex].metadata.sourceQuote},
        {side:"right",citationIndex:0,sourceQuote:documents[pair.rightIndex].metadata.sourceQuote},
        {side:"document",citationIndex:0,sourceQuote:pair.metadataReview!.documentContext[0].sourceQuote}]}))};
}

describe("document-supported metadata review", () => {
  it("reviews a familiar middle name and preserves all labels, source support and resolutions", () => {
    const {source,record}=fixture();
    const docs=[record(),record({who:["Alex Morgan Lane"],subject:["Alex Morgan Lane"],tags:["fact","evidence:testResult"]})];
    const original=JSON.stringify(docs);
    expect(mergeEvidenceMetadata(docs[0].metadata,docs[1].metadata,true)).toBeNull();
    expect(findCanonicalizationPairs(docs)).toHaveLength(0);
    const pairs=findCanonicalizationPairs(docs,{source});
    expect(pairs).toHaveLength(1);
    expect(pairs[0].metadataReview?.fields).toEqual(["who","subject"]);
    expect(pairs[0].metadataReview?.documentContext.some(span=>span.sourceQuote.includes("Alex Morgan Lane"))).toBe(true);
    const decision=approval(pairs[0],docs);
    expect(partitionIdentityDecisions(pairs,[decision],docs,source).valid[0].verdict).toBe("duplicate");
    const result=applyCanonicalizationDecisions(docs,pairs,[decision],source);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata).toMatchObject({what:docs[0].metadata.what,
      who:["Morgan","Alex Morgan Lane"],subject:["Morgan","Alex Morgan Lane"],
      tags:["fact","evidence:testResult","factType:attribute"],metadataResolutions:[{pairId:"0:1",resolutions:expect.any(Array)}]});
    expect(result.documents[0].metadata.sourceSpans).toEqual(expect.arrayContaining(docs.flatMap(doc=>doc.metadata.sourceSpans)));
    expect(result.documents[0].metadata.metadataResolutions[0].evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({field:"who",side:"left",pageNumber:2,sourceOffset:0,sourceQuote:docs[0].metadata.sourceQuote})]));
    expect(JSON.stringify(docs)).toBe(original);
  });

  it.each([
    ["reportedBy",["Mother"],["Morgan's mother"]],
    ["reportedBy",["Father"],["Morgan's father"]],
    ["who",["Morgan's mother"],["Jordan Reed"]],
    ["who",["Morgan"],["Assessment instrument"]],
    ["where","preschool","Preschool, facility unspecified"],
  ])("requires explicit resolution of %s annotations %j and %j", (field,left,right) => {
    const {source,record}=fixture("Morgan's score was 118.","Morgan's mother completed the assessment instrument at preschool. Mother's score was 118.");
    const docs=[record({[field]:left}),record({[field]:right})];
    const pairs=findCanonicalizationPairs(docs,{source});
    expect(pairs).toHaveLength(1);
    const decision=approval(pairs[0],docs);
    expect(applyCanonicalizationDecisions(docs,pairs,[{...decision,metadataResolutions:[]}],source).documents).toHaveLength(2);
    expect(applyCanonicalizationDecisions(docs,pairs,[decision],source).documents).toHaveLength(1);
  });

  it("resolves collective claimant labels without losing either attribution", () => {
    const {source,record}=fixture("Morgan's parents reported that therapy helped.");
    const base={factType:undefined,claimType:"factualAssertion",claimPolarity:"asserts",tags:["claim"]};
    const docs=[record({...base,claimant:"Morgan's parents"}),record({...base,claimant:"Taylor Lane and Jordan Reed"})];
    const pairs=findCanonicalizationPairs(docs,{source});
    const result=applyCanonicalizationDecisions(docs,pairs,[approval(pairs[0],docs)],source);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.evidenceClassifications.map((value:{claimant:string})=>value.claimant))
      .toEqual(expect.arrayContaining(["Morgan's parents","Taylor Lane and Jordan Reed"]));
  });

  it("resolves asserts/uncertain annotation differences while retaining the qualified statement and original polarities", () => {
    const {source,record}=fixture("Morgan seemed comfortable with the examiner.");
    const base={factType:undefined,claimType:"factualAssertion",claimant:"Examiner",tags:["claim"]};
    const docs=[record({...base,claimPolarity:"asserts"}),record({...base,claimPolarity:"uncertain"})];
    const pairs=findCanonicalizationPairs(docs,{source});
    const result=applyCanonicalizationDecisions(docs,pairs,[approval(pairs[0],docs)],source);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.what).toContain("seemed");
    expect(result.documents[0].metadata.claimPolarity).toBe("asserts");
    expect(result.documents[0].metadata.metadataResolutions[0].originals.map((value:{fields:{claimPolarity:string}})=>value.fields.claimPolarity))
      .toEqual(["asserts","uncertain"]);
  });

  it("requires grounded field resolutions again at application time", () => {
    const {source,record}=fixture();
    const docs=[record(),record({who:["Alex Morgan Lane"],subject:["Alex Morgan Lane"]})];
    const pairs=findCanonicalizationPairs(docs,{source}), good=approval(pairs[0],docs);
    const invalid=[{...good,metadataResolutions:undefined},{...good,metadataResolutions:good.metadataResolutions!.slice(0,1)},
      {...good,metadataResolutions:[...good.metadataResolutions!,good.metadataResolutions![0]]},
      {...good,metadataResolutions:good.metadataResolutions!.map(row=>({...row,explanation:" "}))},
      {...good,metadataResolutions:good.metadataResolutions!.map(row=>({...row,citations:row.citations.map(c=>({...c,sourceQuote:"invented identity proof"}))}))},
      {...good,semanticAssessment:undefined}];
    for (const decision of invalid) {
      expect(partitionIdentityDecisions(pairs,[decision],docs,source).valid.some(row=>row.verdict==="duplicate")).toBe(false);
      expect(applyCanonicalizationDecisions(docs,pairs,[decision],source).documents).toHaveLength(2);
    }
    expect(applyCanonicalizationDecisions(docs,pairs,[good]).documents).toHaveLength(2);
    const changed=docs.map(doc=>new Document({...doc,metadata:{...doc.metadata}}));
    changed[1].metadata.who=["Another person"];
    expect(applyCanonicalizationDecisions(changed,pairs,[good],source).documents).toHaveLength(2);
  });

  it.each([{accountId:"other"},{sourceId:"other"},{sourceContentHash:"other"},
    {whenStarted:{year:"2025"}},{claimPolarity:"denies"},{what:"Morgan may have scored 118."},{what:"Morgan's test score was 119."}])("keeps hard boundaries and material distinctions: %j", change => {
    const {source,record}=fixture();
    const common={whenStarted:{year:"2024"},factType:undefined,claimType:"factualAssertion",claimant:"Examiner",claimPolarity:"asserts"};
    const docs=[record(common),record({...common,who:["Alex Morgan Lane"],subject:["Alex Morgan Lane"],...change})];
    expect(findCanonicalizationPairs(docs,{source})).toHaveLength(0);
  });

  it("does not merge a new metadata candidate on a contradictory semantic judgment", () => {
    const {source,record}=fixture();
    const docs=[record(),record({who:["Alex Morgan Lane"],subject:["Alex Morgan Lane"]})];
    const pairs=findCanonicalizationPairs(docs,{source});
    const decision:CanonicalizationDecision={...approval(pairs[0],docs),semanticAssessment:{relationship:"contradictory",contextualDetails:[]}};
    expect(applyCanonicalizationDecisions(docs,pairs,[decision],source).documents).toHaveLength(2);
  });

  it("does not turn two reviewed identity links into an unreviewed transitive merge", () => {
    const {source,record}=fixture();
    const docs=[record(),record({who:["Alex Morgan Lane"],subject:["Alex Morgan Lane"]}),
      record({who:["Jordan Reed"],subject:["Jordan Reed"]})];
    const pairs=findCanonicalizationPairs(docs,{source});
    expect(pairs).toHaveLength(3);
    const decisions=pairs.filter(pair=>pair.id!=="1:2").map(pair=>approval(pair,docs));
    const result=applyCanonicalizationDecisions(docs,pairs,decisions,source);
    expect(result.documents).toHaveLength(2);
    expect(result.documents.some(doc=>doc.metadata.who.includes("Alex Morgan Lane")&&doc.metadata.who.includes("Jordan Reed"))).toBe(false);
  });

  it("retains patient and affectedPerson roles for a reviewed occurrence, but rejects reversed directions", () => {
    const {source,record,primary}=fixture("Morgan was delivered by C-section.");
    const structure=(role:string,participant:string)=>({version:1,trigger:primary,roles:[{role,participant,citationIds:[eventCitationId(primary)]}]});
    const base={factType:undefined,subject:undefined,eventType:"medical",tags:["event"]};
    const docs=[record({...base,eventStructure:structure("patient","Morgan")}),
      record({...base,who:["Alex Morgan Lane"],eventStructure:structure("affectedPerson","Alex Morgan Lane")})];
    const pairs=findCanonicalizationPairs(docs,{source});
    expect(pairs).toHaveLength(1);
    const result=applyCanonicalizationDecisions(docs,pairs,[approval(pairs[0],docs)],source);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.eventStructure.roles.map((role:{role:string})=>role.role)).toEqual(["patient","affectedPerson"]);
    const reversed=[record({...base,eventStructure:structure("sender","Morgan")}),
      record({...base,who:["Alex Morgan Lane"],eventStructure:structure("recipient","Alex Morgan Lane")})];
    expect(findCanonicalizationPairs(reversed,{source})).toHaveLength(0);
  });
});
