import {Document} from "@langchain/core/documents";
import {describe,expect,it} from "vitest";
import {compatibleIdentityDetail,normalizeIdentityExcerpt,unreportedContainmentDetails} from "../src/processors/evidence/evidenceAtomicity.ts";
import {partitionIdentityDecisions} from "../src/processors/evidence/evidenceIdentityReview.ts";
import {applyCanonicalizationDecisions,type CanonicalizationPair} from "../src/processors/evidence/evidenceCanonicalization.ts";
import {atomicityCases} from "./fixtures/atomicityCases.ts";

const pair: CanonicalizationPair = {id:"0:1",leftIndex:0,rightIndex:1,similarity:0.8,allowedSurvivors:["left","right"]};
const document = (what:string,kind:string) => new Document({pageContent:what,metadata:{what,
  ...(kind === "opinion" ? {claimType:kind,claimant:"Clinician",claimPolarity:"asserts"} : {factType:kind}),
  sourceContentHash:"hash",sourceId:"id",sourceQuote:"A shared source passage for these assertions.",sourceOffset:0,pages:[1],
  sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:"A shared source passage for these assertions."}],tags:[]}});

describe("conservative identity enrichment", () => {
  it.each(atomicityCases)("preserves $name despite same_assertion approval, in either direction", example => {
    for(const richer of ["left","right"] as const){
      const docs = (richer === "left" ? [example.compound,example.atomic] : [example.atomic,example.compound]).map(what=>document(what,example.kind));
      const assessment = {pairId:pair.id,relation:"same_assertion",leftOnlyDetails:richer === "left" ? [...example.additions] : [],
        rightOnlyDetails:richer === "right" ? [...example.additions] : [],reason:"The model wrongly treats extra propositions as enrichment."};
      const parsed = partitionIdentityDecisions([pair],[assessment],docs);
      expect(parsed.errors.size).toBe(0);
      expect(parsed.valid[0]).toMatchObject({verdict:"distinct",survivor:"none"});
      // A direct caller cannot bypass the gate by forwarding a forged approval.
      const application = applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor:richer}]);
      expect(application.applied).toEqual([]);
      expect(application.documents).toEqual(docs);
    }
  });

  it.each([
    "at the 93rd percentile", "percentile rank 60", "(scaled-score mean 100)",
    "standard score of 118 at the 88th percentile", "age equivalent 5-6",
    "his age-equivalent performance was five years, one month", "classified as Moderate risk",
    "the narrative describes it as superior range", "in the average range", "were all within the average range",
    "all scales were within the average range", "standard score", "Borderline range, T-score 69, percentile 97",
  ])("recognizes the scalar result modifier: %s", detail => {
    expect(compatibleIdentityDetail(detail,{factType:"assessmentResult"})).toBe(true);
  });

  it.each([
    "score 100 and passed the examination", "classified as average and eligible for services",
    "standard scores have a mean of 100", "contains five subscales", "adequate social skills",
    "parent reading", "good word knowledge", "at the 93rd percentile and",
  ])("rejects unrecognized additions even on an assessment: %s", detail => {
    expect(compatibleIdentityDetail(detail,{factType:"assessmentResult"})).toBe(false);
  });

  it("does not treat an untyped attribute as a measurement modifier", () => {
    expect(compatibleIdentityDetail("average",{factType:"attribute"})).toBe(false);
  });

  it("keeps score/percentile/classification enrichment eligible through review and application", () => {
    const docs=[document("Casey's reading score was 101.","assessmentResult"),
      document("Casey's reading score was 101, percentile 53, classified as average.","assessmentResult")];
    const assessment={pairId:pair.id,relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:["percentile 53","classified as average"],reason:"Same measured result."};
    const review=partitionIdentityDecisions([pair],[assessment],docs);
    expect(review.valid[0]).toMatchObject({verdict:"duplicate",survivor:"right"});
    expect(applyCanonicalizationDecisions(docs,[pair],[{...review.valid[0],survivor:"right"}]).documents).toHaveLength(1);
  });

  it("requires the inventories at application rather than trusting a legacy approval", () => {
    const docs=[document("Reading score 101.","assessmentResult"),document("Reading score 101.","assessmentResult")];
    expect(applyCanonicalizationDecisions(docs,[pair],[{pairId:pair.id,survivor:"left",reason:"Legacy approval"} as never]).applied).toEqual([]);
  });

  it("accepts named context only when the exact entity is already in structured metadata", () => {
    expect(compatibleIdentityDetail("for Casey",{who:["Casey"]})).toBe(true);
    expect(compatibleIdentityDetail("for Jordan",{who:["Casey"]})).toBe(false);
    expect(compatibleIdentityDetail("Clinician Smith states that",{claimant:"Clinician Smith, Ph.D."})).toBe(true);
    expect(compatibleIdentityDetail("Smith states that",{claimant:"Clinician Smith, Ph.D."})).toBe(false);
    expect(compatibleIdentityDetail("with others and developed new skills",{
      what:"Relationships with others and developed new skills.",
      sourceSpans:[{sourceQuote:"Relationships with others and developed new skills."}],
    },{what:"Relationships were positive."})).toBe(false);
  });
});

describe("quoted excerpt normalization", () => {
  it.each(['"Casey\'s word recognition"',"“Casey's word recognition”"])("peels only balanced display quotes from a real excerpt: %s", detail => {
    expect(normalizeIdentityExcerpt("Improve Casey's word recognition.",detail)).toBe("Casey's word recognition");
  });
  it("retains literal source quotes and does not invent a match", () => {
    expect(normalizeIdentityExcerpt('Casey said "no".', '"no"')).toBe('"no"');
    expect(normalizeIdentityExcerpt("Casey did not pay.",'"Casey paid"')).toBeNull();
    expect(normalizeIdentityExcerpt("Casey paid.",'"Casey')).toBeNull();
    expect(normalizeIdentityExcerpt("Casey paid.",'" "')).toBeNull();
  });
});

describe("directional statement detail preservation", () => {
  it("does not equate different category labels through a substring match", () => {
    const docs=[document("The result in the Index category was Borderline.","assessmentResult"),
      document("The result in the Subindex category was Borderline.","assessmentResult")];
    const assessment={pairId:pair.id,relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Fault injection: ignores category distinction."};
    expect(partitionIdentityDecisions([pair],[assessment],docs).valid[0]).toMatchObject({verdict:"distinct",survivor:"none"});
    for (const survivor of ["left","right"] as const)
      expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor}]).applied).toEqual([]);
  });
  it("accepts a reported relationship target only in the fuller source-supported statement", () => {
    const docs = [document("Parents should foster positive relationships.","opinion"),
      document("Parents should foster positive relationships with others.","opinion")];
    for (const doc of docs) {
      doc.metadata.sourceQuote = docs[1].metadata.what;
      doc.metadata.sourceSpans[0].sourceQuote = docs[1].metadata.what;
    }
    const assessment = {pairId:pair.id,relation:"same_assertion",leftOnlyDetails:[],
      rightOnlyDetails:["with others"],reason:"Same relationship goal with its explicit target."};
    expect(partitionIdentityDecisions([pair],[assessment],docs).valid[0]).toMatchObject({verdict:"duplicate",survivor:"right"});
    expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor:"right"}]).documents).toHaveLength(1);
  });
  it.each([
    ["The clinician recommends time with Casey to foster positive relationships.",
      "Parents should spend time with Casey to foster positive relationships with others."],
    ["The board issued a notice.", "The board issued a notice to the applicant."],
    ["Use alternative teaching methods.", "Use alternative teaching methods where possible."],
    ["The school may share the record.", "The school may share the record only when parents consent."],
    ["Parents should spend 30 minutes with Casey.", "Parents should spend at least 30 minutes with Casey."],
    ["The recorded result was Borderline, T-score 63.", "The recorded result in the Index category was Borderline, T-score 63."],
    ["The application was accepted.", "The application under the Priority Review category was accepted."],
    ["The request was recorded.", "The request within the Expedited category was recorded."],
  ])("retains targets and qualifications omitted from empty inventories: %s", (partial,full) => {
    for (const statements of [[partial,full],[full,partial]]) {
      const docs = statements.map(what => document(what,"opinion"));
      const richer = statements[0] === full ? "left" : "right";
      const assessment = {pairId:pair.id,relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Same assertion, but the model omitted a detail."};
      expect(partitionIdentityDecisions([pair],[assessment],docs).valid[0]).toMatchObject({verdict:"duplicate",survivor:richer});
      const wrong = richer === "left" ? "right" : "left";
      expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor:wrong}]).applied).toEqual([]);
      const result = applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor:richer}]);
      if (partial === "Use alternative teaching methods.") {
        // The existing qualifier guard conservatively retains both forms.
        expect(result.documents).toHaveLength(2);
        continue;
      }
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.what).toBe(full);
    }
  });
});

describe("omitted differences in coordinated containment", () => {
  it.each([
    ["Parents should continue to create a home where Casey feels successful.","Parents should continue creating a home where Casey feels secure and successful."],
    ["The clinician recommends practicing until Casey is fluent.","The clinician recommends practice until Casey is accurate and fluent."],
    ["The team documented the repair.","The team documents the repair and the inspection."],
    ["Casey attended the course.","Casey attended, and passed, the course."],
    ["Casey's scores suggest no disorder.","Casey's scores suggest adequate social skills with no disorder."],
    ["Scaled scores have a mean of 10.","Standard scores have a mean of 100 and scaled scores have a mean of 10."],
    ["The instrument measures social behavior.","The instrument contains five subscales and measures social behavior."],
    ["High scores indicate verbal problem solving.","High scores indicate good word knowledge, verbal problem solving, and effective communication."],
    ["Parents should practice relaxation and remind Casey of the techniques.","Parents should practice relaxation, reassure Casey, and remind Casey of the techniques."],
    ["The clinician recommends tutoring.","The clinician recommends parent reading, self-reading, and tutoring."],
  ])("keeps atomic statements when the model omits the differences: %s", (atomic,compound) => {
    for(const statements of [[atomic,compound],[compound,atomic]]) {
      const docs=statements.map(what=>document(what,"attribute"));
      const assessment={pairId:pair.id,relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Fault injection: inventories omit material additions."};
      const review=partitionIdentityDecisions([pair],[assessment],docs);
      expect(review.errors.size).toBe(0);
      expect(review.valid[0]).toMatchObject({verdict:"distinct",survivor:"none"});
      for(const survivor of ["left","right"] as const)
        expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor}]).applied).toEqual([]);
    }
  });

  it("blocks a partially complete inventory that lists only a permitted modifier", () => {
    const docs=[document("Casey's reading score was 101.","assessmentResult"),
      document("Casey's reading score was 101, percentile 53, and Casey qualified for tutoring.","assessmentResult")];
    const assessment={pairId:pair.id,relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:["percentile 53"],reason:"Incomplete inventory."};
    expect(partitionIdentityDecisions([pair],[assessment],docs).valid[0]).toMatchObject({verdict:"distinct",survivor:"none"});
    expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor:"right"}]).applied).toEqual([]);
  });

  it("does not flag a coordinated scalar enrichment with a complete inventory", () => {
    const docs=[document("Casey's reading score was 101.","assessmentResult"),
      document("Casey's reading score was 101, percentile 53, and classified as average.","assessmentResult")];
    expect(unreportedContainmentDetails(docs[0].metadata,docs[1].metadata,[],["percentile 53","classified as average"])).toEqual([]);
  });

  it("does not claim to parse paraphrases with unique words on both sides", () => {
    expect(unreportedContainmentDetails({what:"Casey completed the course."},
      {what:"Casey attended training and passed the examination."},[],[])).toEqual([]);
  });
});

describe("alternative action focus", () => {
  it.each([
    ["The clinician recommends ending the meeting with refreshments as an alternative to playing a game.",
      "The clinician recommends ending the meeting by playing a game as an alternative to having refreshments."],
    ["The adviser recommends calling instead of writing.","The adviser recommends writing instead of calling."],
    ["Casey should walk rather than drive.","Casey should drive rather than walk."],
    ["Casey may call or write.","Casey may write or call."],
    ["Casey should call.","Casey should call as an alternative to writing."],
  ])("preserves separate focuses even with empty inventories: %s", (left,right) => {
    for (const statements of [[left,right],[right,left]]) {
      const docs=statements.map(what=>document(what,"opinion"));
      const assessment={pairId:pair.id,relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Fault injection: both mention the same options."};
      expect(partitionIdentityDecisions([pair],[assessment],docs).valid[0]).toMatchObject({verdict:"distinct",survivor:"none"});
      for (const survivor of ["left","right"] as const)
        expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor}]).applied).toEqual([]);
    }
  });

  it("still permits duplicate copies of the same alternative recommendation", () => {
    const docs=Array.from({length:2},()=>document("Casey should call as an alternative to writing.","opinion"));
    const assessment={pairId:pair.id,relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Identical recommendation and alternative."};
    expect(partitionIdentityDecisions([pair],[assessment],docs).valid[0]).toMatchObject({verdict:"duplicate",survivor:"left"});
    expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor:"left"}]).documents).toHaveLength(1);
  });

  it("does not block unrelated paraphrasing around unchanged alternatives", () => {
    const docs=[document("Continue tutoring as part of multiple interventions in small-group settings or one-on-one.","opinion"),
      document("Continue tutoring as one of multiple interventions in small-group or one-on-one settings.","opinion")];
    const assessment={pairId:pair.id,relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Same tutoring recommendation and setting options."};
    expect(partitionIdentityDecisions([pair],[assessment],docs).valid[0]).toMatchObject({verdict:"duplicate"});
    expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor:"left"}]).documents).toHaveLength(1);
  });
});

describe("explicit causal attribution", () => {
  it.each([
    ["Parents are concerned about Casey's learning struggles, which they attribute to a family history of learning disabilities.",
      "Parents are concerned about learning struggles for Casey because of a family history of learning disabilities."],
    ["The operator attributed the failure to the repair.","The operator was worried about a failure after the repair."],
    ["The clinician is attributing fatigue to medication.","The clinician is concerned about fatigue due to medication."],
  ])("retains differing causal constructions despite an empty inventory: %s", (left,right) => {
    for (const statements of [[left,right],[right,left]]) {
      const docs=statements.map(what=>document(what,"opinion"));
      const assessment={pairId:pair.id,relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Fault injection: same topic and cause words."};
      expect(partitionIdentityDecisions([pair],[assessment],docs).valid[0]).toMatchObject({verdict:"distinct",survivor:"none"});
      for (const survivor of ["left","right"] as const)
        expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor}]).applied).toEqual([]);
    }
  });

  it("permits duplicate copies preserving the same causal attribution", () => {
    const docs=Array.from({length:2},()=>document("The operator attributes the failure to the repair.","opinion"));
    const assessment={pairId:pair.id,relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Same explicit attribution."};
    expect(partitionIdentityDecisions([pair],[assessment],docs).valid[0]).toMatchObject({verdict:"duplicate"});
    expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor:"left"}]).documents).toHaveLength(1);
  });
});

describe("source-defined instrument expansions", () => {
  const full="Child Learning Checklist for Ages 1 1/2-5 (CLC)";
  const docsFor=()=>{
    const docs=[document(`Casey's father-reported ${full} responses showed an elevation.`,"assessmentResult"),
      document("Casey's father-reported CLC responses showed an elevation.","assessmentResult")];
    for(const doc of docs)doc.metadata.sourceSpans.push({pageNumber:1,sourceOffset:100,sourceQuote:`Both parents completed the ${full}.`});
    return docs;
  };
  it.each([full,full.replace(" (CLC)","")])("permits a cited expansion and preserves its richer record: %s", detail => {
    const docs=docsFor(),assessment={pairId:pair.id,relation:"same_assertion",leftOnlyDetails:[detail],rightOnlyDetails:[],reason:"The cited passage explicitly defines CLC."};
    expect(partitionIdentityDecisions([pair],[assessment],docs).valid[0]).toMatchObject({verdict:"duplicate",survivor:"left"});
    expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor:"left"}]).documents).toHaveLength(1);
    expect(unreportedContainmentDetails(docs[0].metadata,docs[1].metadata,[],[])).toEqual([]);
  });
  it.each(["no definition","other occurrence","other source","conflicting expansion"])("rejects unsupported abbreviation equivalence: %s", variant => {
    const docs=docsFor();
    if(variant==="no definition")docs[0].metadata.sourceSpans.pop();
    if(variant==="other occurrence")docs[1].metadata.sourceSpans[0].sourceOffset=200;
    if(variant==="other source")docs[1].metadata.sourceContentHash="different";
    if(variant==="conflicting expansion")docs[1].metadata.what="Casey's Clinical Language Checklist (CLC) responses showed an elevation.";
    expect(compatibleIdentityDetail(full,docs[0].metadata,docs[1].metadata)).toBe(false);
  });
  it("does not authorize removing overall when it is listed as a material distinction", () => {
    const docs=[document("Casey's overall score was 101.","assessmentResult"),document("Casey's score was 101.","assessmentResult")];
    const onlyRight={...pair,allowedSurvivors:["right"] as ("left"|"right")[]};
    const assessment={pairId:pair.id,relation:"same_assertion",leftOnlyDetails:["overall"],rightOnlyDetails:[],reason:"Only left identifies a total score."};
    expect(partitionIdentityDecisions([onlyRight],[assessment],docs).valid[0]).toMatchObject({verdict:"distinct",survivor:"none"});
  });
});

describe("source-backed overall index equivalence", () => {
  const docsFor=()=>{
    const docs=[document("Casey's Learning Memory Index (LMI) overall standard score was 112 at the 79th percentile.","assessmentResult"),
      document("Casey's Learning Memory Index (LMI) standard score was 112 at the 79th percentile, classified as high average.","assessmentResult")];
    const quote="On the LMI, Casey's overall performance was above peers (SS = 112, 79th percentile).";
    for(const doc of docs){doc.metadata.sourceQuote=quote;doc.metadata.sourceSpans[0].sourceQuote=quote;}
    return docs;
  };
  const assessment={pairId:pair.id,relation:"same_assertion",leftOnlyDetails:["overall"],rightOnlyDetails:["classified as high average"],reason:"Same named index result."};
  it.each(["overall","overall standard score"])("records contextual equivalence for %s while retaining the classification", detail => {
    const docs=docsFor(),before=JSON.stringify(docs);
    const current={...assessment,leftOnlyDetails:[detail]};
    const review=partitionIdentityDecisions([pair],[current],docs);
    expect(review.valid[0]).toMatchObject({verdict:"duplicate",survivor:"right",leftOnlyDetails:[],
      rightOnlyDetails:["classified as high average"],equivalentDetails:{left:[detail],right:[]}});
    const result=applyCanonicalizationDecisions(docs,[pair],[{...current,survivor:"right"}]);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.what).toBe(docs[1].metadata.what);
    expect(JSON.stringify(docs)).toBe(before);
  });
  it.each(["different index","subtest","different percentile","different source","different occurrence","no source tuple","no source overall"])("retains overall when the equivalence proof fails: %s", variant => {
    const docs=docsFor();
    if(variant==="different index")docs[1].metadata.what=docs[1].metadata.what.replace("Learning Memory Index (LMI)","Visual Memory Index (VMI)");
    if(variant==="subtest")docs[1].metadata.what=docs[1].metadata.what.replace("Index (LMI)","Index (LMI) subtest");
    if(variant==="different percentile")docs[1].metadata.what=docs[1].metadata.what.replace("79th","80th");
    if(variant==="different source")docs[1].metadata.sourceContentHash="other";
    if(variant==="different occurrence")docs[1].metadata.sourceSpans[0].sourceOffset=200;
    if(variant==="no source tuple" || variant==="no source overall")for(const doc of docs){
      doc.metadata.sourceSpans[0].sourceQuote=variant==="no source tuple" ? "On the LMI, Casey's overall performance was above peers." : "LMI: SS = 112, 79th percentile.";
    }
    expect(partitionIdentityDecisions([pair],[assessment],docs).valid[0]).toMatchObject({verdict:"distinct",survivor:"none",leftOnlyDetails:["overall"]});
    expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor:"right"}]).applied).toEqual([]);
  });
  it("validates original excerpts before removing an equivalent modifier", () => {
    const docs=docsFor();docs[0].metadata.what=docs[0].metadata.what.replace("overall ","");
    expect(partitionIdentityDecisions([pair],[assessment],docs).errors.size).toBe(1);
    expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor:"right"}]).applied).toEqual([]);
  });
});

describe("repeated named assessment details", () => {
  const docsFor=()=>{
    const docs=[document("Casey's mother-rated Attention Problems score was 107, average, at the 68th percentile.","assessmentResult"),
      document("Casey's mother-rated score was average (the corresponding Attention Problems score was 107).","assessmentResult")];
    for(const doc of docs)Object.assign(doc.metadata,{subject:["Casey"],reportedBy:["Casey's mother"]});
    return docs;
  };
  const assessment={pairId:pair.id,relation:"same_assertion",leftOnlyDetails:["Attention Problems score was 107","at the 68th percentile"],rightOnlyDetails:[],reason:"Same result; the named score is in both statements."};
  it("excludes the repeated phrase and preserves the additional percentile", () => {
    const docs=docsFor();
    expect(partitionIdentityDecisions([pair],[assessment],docs).valid[0]).toMatchObject({verdict:"duplicate",survivor:"left",
      leftOnlyDetails:["at the 68th percentile"],equivalentDetails:{left:["Attention Problems score was 107"],right:[]}});
    expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor:"left"}]).documents).toHaveLength(1);
  });
  it.each(["different reporter","different subject","multiple scores","no shared source","score absent from other statement"])("does not erase a possible distinction: %s", variant => {
    const docs=docsFor();
    if(variant==="different reporter")docs[1].metadata.reportedBy=["Casey's father"];
    if(variant==="different subject")docs[1].metadata.subject=["Jordan"];
    if(variant==="multiple scores")docs[1].metadata.what+=" The prior score was 105.";
    if(variant==="no shared source")docs[1].metadata.sourceSpans[0].sourceOffset=99;
    if(variant==="score absent from other statement")docs[1].metadata.what="Casey's mother-rated score was average.";
    expect(partitionIdentityDecisions([pair],[assessment],docs).valid[0]).toMatchObject({verdict:"distinct",leftOnlyDetails:assessment.leftOnlyDetails});
    expect(applyCanonicalizationDecisions(docs,[pair],[{...assessment,survivor:"left"}]).applied).toEqual([]);
  });
});
