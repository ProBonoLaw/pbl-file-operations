import {Document} from "@langchain/core/documents";
import {describe,expect,it} from "vitest";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.ts";
import {applyCanonicalizationDecisions,findCanonicalizationPairs,type CanonicalizationDecision} from "../src/processors/evidence/evidenceCanonicalization.ts";
import {partitionIdentityDecisions} from "../src/processors/evidence/evidenceIdentityReview.ts";
import {metadataConflictFields,metadataResolutionIssues,repairMetadataResolutions} from "../src/processors/evidence/evidenceMetadataReview.ts";

const sentence="For the index scores and the FSIQ, scores from 90 to 109 are average.";
const paragraph="The Example Assessment is a clinical instrument. Its subtest scores contribute to the index scores, which cover several cognitive areas. It also produces a Full Scale IQ composite score.";
const abbreviated="The Example Assessment is a clinical instrument. Its subtest scores contribute to the index scores... It also produces a Full Scale IQ composite score.";
function fixture(context=paragraph) {
  const text=sentence+"\n\n"+context;
  const source=new EvidenceSource(new Document({pageContent:text,metadata:{sourceId:"report",pages:[1]}}));
  const primary={pageNumber:1,sourceOffset:0,sourceQuote:sentence};
  const support={pageNumber:1,sourceOffset:sentence.length+2,sourceQuote:context};
  const docs=["Example Assessment score system","Example Assessment"].map(subject=>new Document({pageContent:sentence,metadata:{
    accountId:"account",sourceId:"report",sourceContentHash:source.contentHash,what:sentence,who:[subject],subject:[subject],
    factType:"recordedValue",reportedBy:[],tags:["fact"],where:"Unknown",why:"Unknown",sourceQuote:sentence,sourceOffset:0,
    sourceSpans:[primary,support],pages:[1]}}));
  const pair=findCanonicalizationPairs(docs,{source})[0];
  // Deterministic source-valid contexts to exercise index errors and ambiguity.
  pair.metadataReview!.documentContext=[support,primary];
  const decision:CanonicalizationDecision={pairId:pair.id,relation:"same_assertion",survivor:"left",reason:"The same scoring rule and instrument.",
    leftOnlyDetails:[],rightOnlyDetails:[],semanticAssessment:{relationship:"equivalent",contextualDetails:[]},
    metadataResolutions:pair.metadataReview!.fields.map(field=>({field,explanation:"Both labels identify this instrument's scoring system.",
      citations:[{side:"left",citationIndex:0,sourceQuote:sentence},{side:"right",citationIndex:0,sourceQuote:sentence},
        {side:"document",citationIndex:0,sourceQuote:context}]}))};
  return {source,docs,pair,decision};
}

describe("repair metadata citations without changing assertion identity",()=>{
  it.each([abbreviated,abbreviated.replace("...","…"),abbreviated.replace("...","[...]" )])(
    "re-anchors abbreviated explanation quotes and preserves the source text: %s", quote=>{
      const {source,docs,pair,decision}=fixture();
      decision.metadataResolutions![1].citations[2].sourceQuote=quote;
      const before=JSON.stringify(decision);
      const partition=partitionIdentityDecisions([pair],[decision],docs,source);
      expect(partition.errors.size).toBe(0);
      expect(partition.valid[0].verdict).toBe("duplicate");
      const result=applyCanonicalizationDecisions(docs,[pair],[decision],source);
      expect(result.documents).toHaveLength(1);
      const resolution=result.documents[0].metadata.metadataResolutions[0].resolutions[1];
      expect(resolution.citations[2].sourceQuote).toBe(paragraph);
      expect(resolution.citationRepairs).toEqual([{original:{side:"document",citationIndex:0,sourceQuote:quote},
        corrected:{side:"document",citationIndex:0,sourceQuote:paragraph}}]);
      expect(result.documents[0].metadata.subject).toEqual(["Example Assessment score system","Example Assessment"]);
      expect(result.documents[0].metadata.sourceSpans).toEqual(expect.arrayContaining(docs[0].metadata.sourceSpans));
      expect(JSON.stringify(decision)).toBe(before);
    });

  it.each(["left","right","document"] as const)("repairs a unique misplaced index within the %s side",side=>{
    const {source,docs,pair,decision}=fixture();
    const row=decision.metadataResolutions![0];
    row.citations.push({side,citationIndex:99,sourceQuote:"clinical instrument"+". Its subtest scores contribute"});
    const repaired=repairMetadataResolutions(pair.metadataReview,decision.metadataResolutions,docs[0].metadata,docs[1].metadata,source)!;
    expect(repaired[0].citations.at(-1)).toEqual({side,citationIndex:side==="document"?0:1,sourceQuote:paragraph});
    expect(metadataResolutionIssues(pair.metadataReview,repaired,docs[0].metadata,docs[1].metadata,source)).toEqual([]);
    expect(applyCanonicalizationDecisions(docs,[pair],[decision],source).documents).toHaveLength(1);
  });

  it("is idempotent and revalidates source and pair integrity at application",()=>{
    const {source,docs,pair,decision}=fixture();decision.metadataResolutions![0].citations[2].sourceQuote=abbreviated;
    const repaired=repairMetadataResolutions(pair.metadataReview,decision.metadataResolutions,docs[0].metadata,docs[1].metadata,source)!;
    expect(repairMetadataResolutions(pair.metadataReview,repaired,docs[0].metadata,docs[1].metadata,source)).toEqual(repaired);
    expect(applyCanonicalizationDecisions(docs,[pair],[{...decision,metadataResolutions:repaired}]).applied).toHaveLength(0);
    docs[1].metadata.subject=["Other instrument"];
    expect(applyCanonicalizationDecisions(docs,[pair],[{...decision,metadataResolutions:repaired}],source).applied).toHaveLength(0);
  });

  it.each(["invented evidence about an instrument", "It also produces...The Example Assessment", "index...score"])(
    "requests a correction instead of classifying an invalid quote as distinct: %s",quote=>{
      const {source,docs,pair,decision}=fixture();decision.metadataResolutions![0].citations[2].sourceQuote=quote;
      const result=partitionIdentityDecisions([pair],[decision],docs,source);
      expect(result.valid).toEqual([]);expect(result.errors.get(pair.id)).toContain("Repair metadataResolutions");
      expect(applyCanonicalizationDecisions(docs,[pair],[decision],source).applied).toHaveLength(0);
    });

  it("does not hide negation inside an ellipsis",()=>{
    const {source,docs,pair,decision}=fixture("The instrument measures cognitive ability but does not diagnose a disability. It also produces a composite score.");
    decision.metadataResolutions![0].citations[2].sourceQuote="The instrument measures cognitive ability... It also produces a composite score.";
    expect(partitionIdentityDecisions([pair],[decision],docs,source).errors.has(pair.id)).toBe(true);
    expect(applyCanonicalizationDecisions(docs,[pair],[decision],source).applied).toHaveLength(0);
  });

  it("does not guess between multiple source locations or move a citation to another side",()=>{
    const {source,docs,pair,decision}=fixture(paragraph+"\n\n"+paragraph);
    pair.metadataReview!.documentContext=[...docs[0].metadata.sourceSpans];
    decision.metadataResolutions![0].citations[2]={side:"document",citationIndex:99,sourceQuote:sentence};
    pair.metadataReview!.documentContext.push({...docs[0].metadata.sourceSpans[0]});
    expect(partitionIdentityDecisions([pair],[decision],docs,source).errors.has(pair.id)).toBe(true);
    const separate=fixture();
    separate.docs[0].metadata.sourceSpans=separate.docs[0].metadata.sourceSpans.slice(0,1);
    const p=findCanonicalizationPairs(separate.docs,{source:separate.source})[0];
    separate.decision.metadataResolutions![0].citations[0].sourceQuote=paragraph;
    expect(partitionIdentityDecisions([p],[separate.decision],separate.docs,separate.source).errors.get(p.id)).toContain("unsupported left citation");
  });

  it.each(["independent_assertions","uncertain"] as const)("does not retry a substantive %s decision to force a merge",relation=>{
    const {source,docs,pair,decision}=fixture();decision.relation=relation;decision.metadataResolutions=[];
    const result=partitionIdentityDecisions([pair],[decision],docs,source);
    expect(result.errors.size).toBe(0);expect(result.valid[0].verdict).toBe(relation==="uncertain"?"uncertain":"distinct");
  });

  it("ignores unrequested annotation resolutions without granting new merge permissions",()=>{
    const {source,docs,pair,decision}=fixture();
    decision.metadataResolutions!.push({field:"where",explanation:"Extra annotation",citations:[{side:"left",citationIndex:99,sourceQuote:"invented"},{side:"right",citationIndex:99,sourceQuote:"invented"}]});
    expect(partitionIdentityDecisions([pair],[decision],docs,source).valid[0].verdict).toBe("duplicate");
    docs[1].metadata.where="Another location";
    expect(applyCanonicalizationDecisions(docs,[pair],[decision],source).applied).toHaveLength(0);
  });
});

describe("omissions are not competing metadata values",()=>{
  it("requires resolution only for conflicting known annotations",()=>{
    expect(metadataConflictFields({who:["Casey"],subject:["Casey"],reportedBy:[],where:"Unknown",claimant:null},
      {who:["Casey","Doctor"],subject:undefined,reportedBy:["Doctor"],where:"Clinic",claimant:"Doctor"})).toEqual([]);
    expect(metadataConflictFields({subject:["Casey"],claimant:"Doctor A"},{subject:["Jordan"],claimant:"Doctor B"})).toEqual(["subject","claimant"]);
  });

  it.each([undefined,[],["Unknown"]])("keeps known participants when the other extraction omitted them: %j",missing=>{
    const {source,docs}=fixture();
    Object.assign(docs[0].metadata,{who:missing,subject:missing});
    const pairs=findCanonicalizationPairs(docs,{source});expect(pairs).toHaveLength(1);expect(pairs[0].metadataReview).toBeUndefined();
    const decision:CanonicalizationDecision={pairId:pairs[0].id,survivor:"right",relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Same cited assertion.",semanticAssessment:{relationship:"equivalent",contextualDetails:[]}};
    const result=applyCanonicalizationDecisions(docs,pairs,[decision],source);
    expect(result.documents).toHaveLength(1);expect(result.documents[0].metadata.who).toContain("Example Assessment");
  });

  it("preserves a known claimant alongside an omitted claimant",()=>{
    const {source,docs}=fixture();
    for(const doc of docs)Object.assign(doc.metadata,{factType:undefined,claimType:"factualAssertion",claimPolarity:"asserts",who:["Reporter"],subject:[],tags:["claim"]});
    docs[0].metadata.claimant="Unknown";docs[1].metadata.claimant="Reporter";
    const pairs=findCanonicalizationPairs(docs,{source});expect(pairs).toHaveLength(1);
    const result=applyCanonicalizationDecisions(docs,pairs,[{pairId:pairs[0].id,survivor:"left",reason:"Same source assertion.",leftOnlyDetails:[],rightOnlyDetails:[]}],source);
    expect(result.documents).toHaveLength(1);expect(result.documents[0].metadata.claimant).toBe("Reporter");
  });
});
