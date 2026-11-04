import {Document} from "@langchain/core/documents";
import {describe, expect, it} from "vitest";
import {deduplicateEvidenceDocuments, mergeEvidenceMetadata} from "../src/processors/evidence/evidenceDeduplication.ts";
import {findCanonicalizationPairs, applyCanonicalizationDecisions} from "../src/processors/evidence/evidenceCanonicalization.ts";
import {possibleParticipantReferenceAlias, possibleEvidenceParticipantAlias} from "../src/processors/evidence/evidencePageIdentity.ts";
import {partitionIdentityDecisions} from "../src/processors/evidence/evidenceIdentityReview.ts";
import {formatEvidenceContent} from "../src/processors/evidence/evidenceContent.ts";
import {eventCitationId} from "../src/processors/evidence/evidenceEventStructure.ts";

const quote = "Casey's birth was an emergency C-section when his mother went into shock.";
const primary = {pageNumber:4, sourceOffset:0, sourceQuote:quote};
function record(overrides: Record<string, unknown> = {}) {
  const metadata = {accountId:"account", sourceId:"source", sourceContentHash:"hash", what:"Casey's birth was an emergency C-section.",
    who:["Casey", "his mother"], factType:"attribute", subject:["Casey"], reportedBy:[], tags:["fact"],
    where:"Unknown", why:"Unknown", pages:[4], sourceQuote:quote, sourceOffset:0, sourceSpans:[primary], extractedBy:["primary"],
    ...overrides};
  return new Document({metadata, pageContent:formatEvidenceContent(metadata)});
}
const reviewedMerge = (docs: Document[]) => {
  const pairs = findCanonicalizationPairs(docs);
  const review = partitionIdentityDecisions(pairs, pairs.map(pair => ({pairId:pair.id, relation:"same_assertion",
    leftOnlyDetails:[], rightOnlyDetails:[], reason:"Same assertion and unnamed participant in the cited occurrence."})), docs);
  return {pairs, review, result:applyCanonicalizationDecisions(docs, pairs, review.valid.flatMap(decision =>
    decision.survivor === "none" ? [] : [{...decision, survivor:decision.survivor}]))};
};

describe("source-local unnamed and possessive participant references", () => {
  it.each(["Unknown doctor", "Unidentified doctor", "Unspecified doctor"])("reviews %s against The doctor without assigning an identity", claimant => {
    const sourceQuote="Casey was evaluated by a doctor who determined that the behavior resulted from abuse.";
    const base={factType:undefined, claimType:"factualAssertion", claimPolarity:"asserts", tags:["claim"],
      what:"Casey's behavior resulted from abuse.", who:["Casey"], sourceQuote,
      sourceSpans:[{...primary,sourceQuote}]};
    const docs=[record({...base,claimant}),record({...base,claimant:"The doctor",extractedBy:["independent"]})];
    expect(deduplicateEvidenceDocuments(docs)).toHaveLength(2);
    const {pairs, result}=reviewedMerge(docs);
    expect(pairs).toHaveLength(1);
    expect(applyCanonicalizationDecisions(docs,pairs,[]).documents).toHaveLength(2);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.claimant).toBe(claimant);
    expect(result.documents[0].metadata.evidenceClassifications.map((value:{claimant:string})=>value.claimant))
      .toEqual(expect.arrayContaining([claimant,"The doctor"]));
    expect(result.documents[0].metadata.extractedBy).toEqual(["primary","independent"]);
  });

  it.each(["Unknown teacher", "The nurse", "Dr. Jordan Lane", "The treating doctor", "The second doctor", "Doctor who evaluated Riley",
    "Unknown Doctor Lane", "The Doctor Lane"])("does not make Unknown doctor compatible with %s", label => {
    const a=record({claimant:"Unknown doctor"}), b=record({claimant:label});
    expect(possibleEvidenceParticipantAlias(a.metadata.claimant,b.metadata.claimant,a.metadata,b.metadata)).toBe(false);
    expect(mergeEvidenceMetadata(a.metadata,b.metadata,true)).toBeNull();
  });

  it("reviews a source-supported description of the same unnamed doctor without guessing their name", () => {
    const sourceQuote="Casey was evaluated by a doctor who determined that the behavior resulted from abuse.";
    const a=record({claimant:"Unknown doctor",sourceQuote,sourceSpans:[{...primary,sourceQuote}]}),
      b=record({claimant:"Doctor who evaluated Casey",sourceQuote,sourceSpans:[{...primary,sourceQuote}]});
    expect(possibleParticipantReferenceAlias(a.metadata.claimant,b.metadata.claimant,a.metadata,b.metadata)).toBe(true);
    expect(possibleParticipantReferenceAlias("The doctor",b.metadata.claimant,a.metadata,b.metadata)).toBe(true);
    expect(possibleParticipantReferenceAlias("Unknown doctor","Doctor who evaluated Riley",a.metadata,b.metadata)).toBe(false);
    expect(possibleParticipantReferenceAlias("Unknown doctor","Casey's evaluating doctor",a.metadata,b.metadata)).toBe(true);
    expect(possibleParticipantReferenceAlias("Casey's evaluating doctor","Doctor who evaluated Casey",a.metadata,b.metadata)).toBe(true);
    expect(possibleParticipantReferenceAlias("Unknown doctor","Riley's evaluating doctor",a.metadata,b.metadata)).toBe(false);
    expect(possibleParticipantReferenceAlias("Unknown doctor","Casey's treating doctor",a.metadata,b.metadata)).toBe(false);
  });

  it.each([false,true])("retains fuller doctor wording using both name aliases and statement participants (reverse=%s)", reverse => {
    const sourceQuote="Casey was evaluated by a doctor and it was determined his negative behavior was secondary to the abuse he received at day care.";
    const base={factType:undefined,claimType:"factualAssertion",claimPolarity:"asserts",tags:["claim"],
      subject:undefined,sourceQuote,sourceSpans:[{...primary,sourceQuote}]};
    const short=record({...base,claimant:"The doctor",who:["Casey","doctor","Casey's day care provider"],
      what:"The doctor determined that Casey's negative behavior was secondary to the abuse he received at day care."});
    const fuller=record({...base,claimant:"Doctor who evaluated Casey",who:["Casey Morgan","Casey's day care provider"],
      what:"The doctor who evaluated Casey determined that his negative behavior was secondary to the abuse he received at day care."});
    const docs=reverse?[fuller,short]:[short,fuller], pairs=findCanonicalizationPairs(docs);
    expect(pairs).toHaveLength(1);
    const side=reverse?"left":"right";
    expect(pairs[0].allowedSurvivors).toContain(side);
    const reviewed=partitionIdentityDecisions(pairs,[{pairId:pairs[0].id,relation:"same_assertion",
      leftOnlyDetails:reverse?["who evaluated Casey"]:[],rightOnlyDetails:reverse?[]:["who evaluated Casey"],
      reason:"The source identifies the same doctor and determination.",semanticAssessment:{
        relationship:reverse?"left_entails_right":"right_entails_left",contextualDetails:[{side,detail:"who evaluated Casey",
          kind:"participant_reference",sourceQuote,explanation:"Identifies the doctor making the same determination."}]}}],docs);
    const result=applyCanonicalizationDecisions(docs,pairs,reviewed.valid.flatMap(d=>d.survivor==="none"?[]:[{...d,survivor:d.survivor}]));
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.what).toBe(fuller.metadata.what);
    expect(result.documents[0].metadata.who).toEqual(expect.arrayContaining(["Casey","Casey Morgan","doctor","Casey's day care provider"]));
  });

  it.each(["who","subject","reportedBy"])("reviews doctor reference variants in %s and retains every label", field => {
    const a=record({[field]:["Unknown doctor"]}),b=record({[field]:["The doctor"]});
    const {pairs,result}=reviewedMerge([a,b]);
    expect(pairs).toHaveLength(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata[field]).toEqual(expect.arrayContaining(["Unknown doctor","The doctor"]));
  });

  it.each([false,true])("reviews his mother against Casey's mother without rewriting labels (reverse=%s)", reverse => {
    const a=record(),b=record({who:["Casey","Casey’s mother"],extractedBy:["independent"]});
    const docs=reverse?[b,a]:[a,b];
    expect(deduplicateEvidenceDocuments(docs)).toHaveLength(2);
    const {pairs,result}=reviewedMerge(docs);
    expect(pairs).toHaveLength(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.who).toEqual(expect.arrayContaining(["Casey","his mother","Casey’s mother"]));
    expect(result.documents[0].pageContent).toBe(formatEvidenceContent(result.documents[0].metadata));
  });

  it("applies the same reference compatibility to matching event roles", () => {
    const event=(participant:string)=>record({factType:undefined,subject:undefined,reportedBy:undefined,what:"Casey's mother went into shock.",
      who:[participant], tags:["event","eventType:medical"], eventType:"medical", eventStructure:{version:1,
        trigger:{...primary,sourceOffset:quote.indexOf("went into shock"),sourceQuote:"went into shock"},
        roles:[{role:"affectedPerson",participant,citationIds:[eventCitationId(primary)]}]}});
    const docs=[event("his mother"),event("Casey's mother")];
    const {pairs,result}=reviewedMerge(docs);
    expect(pairs).toHaveLength(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.eventStructure.roles).toHaveLength(2);
    expect(result.documents[0].metadata.eventStructure.roles.every((value:{citationIds:string[]})=>value.citationIds.includes(eventCitationId(primary)))).toBe(true);
    const wrongRole=event("Casey's mother");wrongRole.metadata.eventStructure.roles[0].role="provider";
    expect(findCanonicalizationPairs([docs[0],wrongRole])).toHaveLength(0);
  });

  it.each(["her mother","their father"])("resolves a source-cited possessive reference: %s", label => {
    const sourceQuote=`Casey visited ${label} during the session.`;
    const a=record({what:"Casey visited a parent.",sourceQuote,sourceSpans:[{...primary,sourceQuote}]}),b=record({...a.metadata});
    expect(possibleParticipantReferenceAlias(label,`Casey's ${label.split(' ')[1]}`,a.metadata,b.metadata)).toBe(true);
  });

  it.each(["different owner","different relative","competing participant","competing antecedent","missing pronoun","owner absent from assertion",
    "different passage","different page","different account","different source","different revision"])("keeps ambiguous or conflicting references separate: %s", variant => {
    const a=record(),b=record({who:["Casey","Casey's mother"]});let label="Casey's mother";
    if(variant==="different owner")label="Riley's mother";
    if(variant==="different relative")label="Casey's father";
    if(variant==="competing participant")a.metadata.who.push("Riley");
    if(variant==="competing antecedent"){
      const sourceQuote="Casey and Riley were present when his mother went into shock.";
      for(const doc of[a,b]){doc.metadata.sourceQuote=sourceQuote;doc.metadata.sourceSpans=[{...primary,sourceQuote}];}
    }
    if(variant==="missing pronoun")for(const doc of[a,b]){doc.metadata.sourceQuote="Casey's birth was an emergency C-section.";doc.metadata.sourceSpans=[{...primary,sourceQuote:doc.metadata.sourceQuote}];}
    if(variant==="owner absent from assertion")b.metadata.what="The birth was an emergency C-section.";
    if(variant==="different passage"){b.metadata.sourceOffset=100;b.metadata.sourceSpans=[{...primary,sourceOffset:100}];}
    if(variant==="different page"){b.metadata.pages=[5];b.metadata.sourceSpans=[{...primary,pageNumber:5}];}
    if(variant==="different account")b.metadata.accountId="other";
    if(variant==="different source")b.metadata.sourceId="other";
    if(variant==="different revision")b.metadata.sourceContentHash="other";
    expect(possibleParticipantReferenceAlias("his mother",label,a.metadata,b.metadata)).toBe(false);
  });

  it("requires the same cited occurrence for unnamed-role compatibility", () => {
    const a=record({claimant:"Unknown doctor"}),b=record({claimant:"The doctor",sourceOffset:100,sourceSpans:[{...primary,sourceOffset:100}]});
    expect(possibleParticipantReferenceAlias(a.metadata.claimant,b.metadata.claimant,a.metadata,b.metadata)).toBe(false);
  });

  it.each([false,true])("reviews observer/provider as overlapping participation in one event (reverse=%s)", reverse => {
    const sourceQuote="Casey was tested by Jordan Lane, who was present during all testing.";
    const primary={pageNumber:4,sourceOffset:0,sourceQuote};
    const event=(role:"observer"|"provider")=>record({factType:undefined,subject:undefined,reportedBy:undefined,
      what:"Casey underwent testing.",who:["Casey","Jordan Lane"],tags:["event"],sourceQuote,sourceSpans:[primary],
      eventStructure:{version:1,trigger:{...primary,sourceOffset:sourceQuote.indexOf("tested"),sourceQuote:"tested"},
        roles:[{role:"subject",participant:"Casey",citationIds:[eventCitationId(primary)]},
          {role,participant:"Jordan Lane",citationIds:[eventCitationId(primary)]}]}});
    const a=event("provider"),b=event("observer"),docs=reverse?[b,a]:[a,b];
    expect(deduplicateEvidenceDocuments(docs)).toHaveLength(2);
    const {pairs,result}=reviewedMerge(docs);
    expect(pairs).toHaveLength(1);
    expect(applyCanonicalizationDecisions(docs,pairs,[]).documents).toHaveLength(2);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.eventStructure.roles.map((value:{role:string})=>value.role).sort())
      .toEqual(["observer","provider","subject"]);
    const other=event("observer");other.metadata.who[1]="Riley West";other.metadata.eventStructure.roles[1].participant="Riley West";
    expect(findCanonicalizationPairs([a,other])).toHaveLength(0);
  });

  it.each([false,true])("normalizes a reviewed negative-assertion polarity mismatch while retaining original classifications (reverse=%s)", reverse => {
    const sourceQuote="Pregnancy with Casey was reported with no complications.";
    const base={factType:undefined,claimType:"factualAssertion",claimant:"Unknown",who:["Casey"],tags:["claim"],
      sourceQuote,sourceSpans:[{...primary,sourceQuote}]};
    const a=record({...base,what:sourceQuote,claimPolarity:"asserts",tags:["claim","claimPolarity:asserts"]});
    const b=record({...base,what:"The pregnancy with Casey was reported to have had no complications.",claimPolarity:"denies",tags:["claim","claimPolarity:denies"]});
    const docs=reverse?[b,a]:[a,b];
    expect(deduplicateEvidenceDocuments(docs)).toHaveLength(2);
    const {pairs,result}=reviewedMerge(docs);
    expect(pairs).toHaveLength(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.claimPolarity).toBe("asserts");
    expect(result.documents[0].metadata.evidenceClassifications.map((value:{claimPolarity:string})=>value.claimPolarity).sort()).toEqual(["asserts","denies"]);
    expect(result.documents[0].metadata.tags).toEqual(expect.arrayContaining(["claimPolarity:asserts","claimPolarity:denies"]));
    expect(result.documents[0].metadata.claimPolarityResolutions[0]).toMatchObject({rule:"source-negative-assertion",polarity:"asserts"});
    expect(result.documents[0].metadata.claimPolarityResolutions[0].originals.map((value:{what:string})=>value.what))
      .toEqual(expect.arrayContaining(docs.map(doc=>doc.metadata.what)));
  });

  it.each(["opposite assertion","explicit denial","denial type","denial source","uncertain","different passage"])("retains meaning-changing polarity differences: %s", variant => {
    const sourceQuote="Pregnancy with Casey was reported with no complications.";
    const base={factType:undefined,claimType:"factualAssertion",claimant:"Unknown",who:["Casey"],tags:["claim"],
      what:sourceQuote,sourceQuote,sourceSpans:[{...primary,sourceQuote}]};
    const a=record({...base,claimPolarity:"asserts"}),b=record({...base,claimPolarity:"denies"});
    if(variant==="opposite assertion")b.metadata.what="Pregnancy with Casey had complications.";
    if(variant==="explicit denial")b.metadata.what="Casey's mother denied complications during pregnancy.";
    if(variant==="denial type")b.metadata.claimType="denial";
    if(variant==="denial source")for(const doc of[a,b]){doc.metadata.sourceQuote="Casey's mother denied any complications and reported no problems.";doc.metadata.sourceSpans=[{...primary,sourceQuote:doc.metadata.sourceQuote}];}
    if(variant==="uncertain")b.metadata.claimPolarity="uncertain";
    if(variant==="different passage"){b.metadata.sourceOffset=100;b.metadata.sourceSpans=[{...primary,sourceOffset:100,sourceQuote}];}
    expect(findCanonicalizationPairs([a,b])).toHaveLength(0);
    expect(mergeEvidenceMetadata(a.metadata,b.metadata,true)).toBeNull();
  });

  it("does not normalize polarity when semantic review finds different negative assertions", () => {
    const sourceQuote="Casey had no pregnancy complications and no developmental delay.";
    const base={factType:undefined,claimType:"factualAssertion",claimant:"Unknown",who:["Casey"],sourceQuote,
      sourceSpans:[{...primary,sourceQuote}]};
    const docs=[record({...base,what:"Casey had no pregnancy complications.",claimPolarity:"asserts"}),
      record({...base,what:"Casey had no developmental delay.",claimPolarity:"denies"})];
    const pairs=findCanonicalizationPairs(docs);expect(pairs).toHaveLength(1);
    const review=partitionIdentityDecisions(pairs,pairs.map(pair=>({pairId:pair.id,relation:"independent_assertions",
      leftOnlyDetails:[],rightOnlyDetails:[],reason:"Pregnancy complications and developmental delay are different assertions."})),docs);
    expect(review.valid[0].verdict).toBe("distinct");
    expect(applyCanonicalizationDecisions(docs,pairs,[]).documents).toHaveLength(2);
  });
});
