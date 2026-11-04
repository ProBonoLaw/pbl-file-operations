import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { compactReconciliationSchema, compactEventDateSchema, expandCompactReconciliation, expandCompactEventDate } from "../src/processors/evidence/evidenceCompactResponses.js";
import { applyEvidenceCorrections } from "../src/processors/evidence/evidenceReconciliation.js";
import { validateEventDateDecision } from "../src/processors/evidence/evidenceEventDates.js";
import { partitionDecisions } from "../src/processors/evidence/evidenceReviewDecisions.js";
import { stableEvidenceResponseSchema } from "../src/processors/evidence/evidenceCompactResponses.js";
import { toolStrategy } from "langchain";

const item = z.object({what:z.string(),who:z.array(z.string()),whenStartedYear:z.string().nullable(),sourceQuote:z.string()});
const schema = () => compactReconciliationSchema(item,item,item);
const expand = (value:unknown) => expandCompactReconciliation(value,schema());

describe("compact response contracts", () => {
  it("uses the same response tool identity across independently constructed batches and changes it with the schema", () => {
    const first = toolStrategy(stableEvidenceResponseSchema(schema()),{handleError:false})[0];
    toolStrategy(z.object({unrelated:z.string()})); // Advance the library's global counter.
    const next = toolStrategy(stableEvidenceResponseSchema(schema()),{handleError:false})[0];
    expect(first.name).toBe(next.name);
    expect(first.tool).toEqual(next.tool);
    expect(first.name).toMatch(/^evidence_response_[a-f0-9]{24}$/);
    expect(toolStrategy(stableEvidenceResponseSchema(compactEventDateSchema()))[0].name).not.toBe(first.name);
  });

  it("defaults missing empty replacement lists without accepting explicit null or mixed actions", () => {
    const replacement = {what:"An assertion",who:[],whenStartedYear:null,sourceQuote:"An assertion"};
    expect(expand({candidateId:"a",action:"replace",reason:"Reclassified",facts:[replacement]}))
      .toMatchObject({keepOriginal:false,events:[],facts:[replacement],claims:[]});
    expect(()=>expand({candidateId:"a",action:"replace",reason:"Reclassified",facts:[replacement],events:null})).toThrow();
    expect(()=>expand({candidateId:"a",action:"replace",reason:"Reclassified",facts:[replacement],corrections:[]})).toThrow();
  });

  it("expands keep into a supported unchanged decision with no implicit changes", () => {
    expect(expand({candidateId:"a",action:"keep"})).toEqual({candidateId:"a",verdict:"supported",keepOriginal:true,
      reason:"",corrections:[],events:[],facts:[],claims:[]});
    expect(()=>expand({candidateId:"a",action:"keep",corrections:[{field:"who",value:[]}]})).toThrow();
    expect(()=>expand({candidateId:"a",action:"keep",reason:null})).toThrow();
  });

  it("preserves explicit clearing, citation-choice IDs and untouched fields", () => {
    const decision = expand({candidateId:"a",action:"correct",reason:"Remove unsupported participants and date",corrections:[
      {field:"who",value:[]},{field:"whenStartedYear",value:null},{field:"sourceQuote",value:"cite:primary:1"},
    ]});
    const patched = applyEvidenceCorrections({what:"An attributed denial",who:["A"],whenStartedYear:"2026",sourceQuote:"Quote"},decision.corrections as any,item);
    expect(patched).toEqual({what:"An attributed denial",who:[],whenStartedYear:null,sourceQuote:"cite:primary:1"});
    expect(()=>applyEvidenceCorrections({...patched,eventStructure:{}},decision.corrections as any,item)).toThrow("complete replacement");
  });

  it.each([
    {field:"what",value:null},{field:"who",value:null},{field:"who",value:"A"},{field:"whenStartedYear",value:2026},
    {field:"facets",value:["medical"]},{field:"supportingQuotes",value:[{pageNumber:1,quote:{passageId:"foreign"}}]},
    {field:"sourceQuote",value:{passageId:"foreign"}},{field:"unknown",value:"x"},{field:"what",value:"x",text:"extra"},
  ])("rejects wrong types or foreign reference objects: %j", correction => {
    expect(()=>expand({candidateId:"a",action:"correct",reason:"Correction",corrections:[correction]})).toThrow();
  });

  it("retains field-specific validation, duplicate-field rejection, and partial row recovery", () => {
    const duplicate = expand({candidateId:"b",action:"correct",reason:"Correction",corrections:[{field:"who",value:[]},{field:"who",value:["A"]}]});
    expect(()=>applyEvidenceCorrections({what:"x",who:[],whenStartedYear:null,sourceQuote:"x"},duplicate.corrections as any,item)).toThrow("repeated");
    const result = partitionDecisions(["a","b"],[{candidateId:"a",action:"keep"},
      {candidateId:"b",action:"correct",reason:"Correction",corrections:null},{candidateId:"foreign",action:"keep"}],expand);
    expect(result.valid.map(row=>row.candidateId)).toEqual(["a"]);
    expect(result.errors.has("b")).toBe(true);
    expect(result.unexpectedIds).toContain("foreign");
  });

  it("preserves complete replacements and rejection reasons", () => {
    const replacement = {what:"Source assertion",who:["A"],whenStartedYear:null,sourceQuote:"Source assertion"};
    expect(expand({candidateId:"a",action:"replace",reason:"Reclassified",events:[],facts:[replacement],claims:[]}).facts).toEqual([replacement]);
    expect(expand({candidateId:"b",action:"unsupported",reason:"No anchor"})).toMatchObject({verdict:"unsupported",keepOriginal:false,reason:"No anchor"});
    expect(()=>expand({candidateId:"b",action:"unsupported",reason:"",corrections:[]})).toThrow();
  });

  it("expands unknown dates and preserves supported relative timing without assigning calendar dates", () => {
    const unknown = validateEventDateDecision(expandCompactEventDate({candidateId:"a",resolution:"unknown",explanation:"No temporal link in inspected sections"}));
    expect(unknown).toMatchObject({status:"unknown",relation:"unknown",qualifier:"",supportingQuotes:[],start:{year:"",month:"",day:"",season:"",quarter:""}});
    const relative = validateEventDateDecision(expandCompactEventDate({candidateId:"a",resolution:"unknown",explanation:"Stated duration",
      relation:"duration",qualifier:"three months",supportingQuotes:[{pageNumber:1,quote:"for three months"}]}));
    expect(relative.status).toBe("unknown"); expect(relative.qualifier).toBe("three months");
    expect(relative.start.year).toBe("");
    expect(()=>expandCompactEventDate({candidateId:"a",resolution:"unknown",explanation:"Unclear",start:null})).toThrow();
  });

  it.each(["unknown", "conflict"])("preserves supporting quotations for an undated %s decision", resolution => {
    const row = {candidateId:"a",resolution,explanation:"Source context explains uncertainty",
      supportingQuotes:[{pageNumber:1,quote:"The date was not recorded."}],
      ...(resolution === "unknown" ? {relation:"unknown",qualifier:""} : {})};
    const decision = validateEventDateDecision(expandCompactEventDate(row));
    expect(decision.status).toBe(resolution);
    expect(decision.supportingQuotes).toEqual(row.supportingQuotes);
    expect(decision.start.year).toBe("");
  });

  it("validates partial precision, calendar limits, duplicate parts and temporal bounds after expansion", () => {
    const row = {candidateId:"a",resolution:"dated",explanation:"Temporally linked",relation:"point",start:[{part:"year",value:"2024"},{part:"month",value:"2"},{part:"day",value:"29"}],end:[],qualifier:"",supportingQuotes:[{pageNumber:1,quote:"On February 29, 2024"}]};
    expect(validateEventDateDecision(expandCompactEventDate(row)).start.day).toBe("29");
    expect(()=>validateEventDateDecision(expandCompactEventDate({...row,start:[{part:"year",value:"2023"},{part:"month",value:"2"},{part:"day",value:"29"}]}))).toThrow();
    expect(()=>expandCompactEventDate({...row,start:[{part:"year",value:"2024"},{part:"year",value:"2025"}]})).toThrow("Repeated");
    expect(()=>validateEventDateDecision(expandCompactEventDate({...row,relation:"bounded",qualifier:"between sessions"}))).toThrow("both endpoints");
    expect(()=>validateEventDateDecision(expandCompactEventDate({...row,supportingQuotes:[]}))).toThrow();
  });

  it("generates strict provider-compatible date alternatives without nested references or optional fields", () => {
    const json = toJsonSchema(compactEventDateSchema());
    expect(JSON.stringify(json)).not.toContain('"$ref"');
    const visit = (value:any) => {
      if (!value || typeof value !== "object") return;
      if (value.type === "object") expect([...(value.required ?? [])].sort()).toEqual(Object.keys(value.properties).sort());
      for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(visit); else visit(child);
    };
    visit(json);
  });
});
