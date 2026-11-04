import { describe, expect, it, vi } from "vitest";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { AIMessageChunk } from "@langchain/core/messages";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { createAgent, StructuredOutputParsingError, toolStrategy } from "langchain";
import { ClaimAttributionResponseSchema, needsClaimantReview, validateClaimAttributionDecision } from "../src/processors/evidence/evidenceAttribution.ts";

describe("claim attribution", () => {
  it.each(["Unknown", "Unknown report author", "Report author", "Document author", "the examiner",
    "Evaluation author", "author of the report", "N/A", ""])("reviews unresolved label %s", label => {
    expect(needsClaimantReview(label)).toBe(true);
  });

  it.each(["Dr. North", "Rachel Carter", "North Psychological Services"])("does not replace named claimant %s", label => {
    expect(needsClaimantReview(label)).toBe(false);
  });

  const resolved = () => ({candidateId:"a",status:"resolved",claimant:"Dr. North",explanation:"The examiner's recommendation in this report.",
    supportingQuotes:[{pageNumber:1,quote:"Examiner: Dr. North."}]});

  it("uses a reference-free schema containing only attribution fields", () => {
    const schema=toJsonSchema(ClaimAttributionResponseSchema);
    expect(JSON.stringify(schema)).not.toContain('"$ref"');
    expect(Object.keys((schema.properties as any).decisions.items.properties).sort())
      .toEqual(["candidateId","claimant","explanation","status","supportingQuotes"]);
  });

  it("accepts a cited name and rejects guessed, generic, or partial-word matches", () => {
    expect(validateClaimAttributionDecision(resolved()).claimant).toBe("Dr. North");
    for(const claimant of ["Dr. South","Report author","Nort"]) {
      expect(()=>validateClaimAttributionDecision({...resolved(),claimant})).toThrow();
    }
    expect(()=>validateClaimAttributionDecision({...resolved(),supportingQuotes:[]})).toThrow();
  });

  it("preserves uncertainty without assigning or rewriting evidence", () => {
    expect(validateClaimAttributionDecision({...resolved(),status:"unknown",claimant:"",supportingQuotes:[]}).status).toBe("unknown");
    expect(()=>validateClaimAttributionDecision({...resolved(),status:"unknown"})).toThrow();
    expect(()=>validateClaimAttributionDecision({...resolved(),statement:"rewritten"})).toThrow();
  });

  it("discards unused diagnostic quotations when attribution remains unknown", () => {
    const decision=validateClaimAttributionDecision({...resolved(),status:"unknown",claimant:"",
      supportingQuotes:[{pageNumber:1,quote:"A repeated bullet."}]});
    expect(decision.supportingQuotes).toEqual([]);
  });

  it("makes LangChain throw on the first malformed structured tool output", async () => {
    const format=toolStrategy(ClaimAttributionResponseSchema,{handleError:false});
    const model=new FakeStreamingChatModel({chunks:[new AIMessageChunk({content:"",tool_calls:[
      {name:format[0].name,args:{decisions:[{candidateId:"a"}]},id:"invalid-output",type:"tool_call"},
    ]})]});
    const completed=vi.fn();
    const agent=createAgent({model,tools:[],responseFormat:format});
    await expect(agent.invoke({messages:[{role:"user",content:"Extract attribution"}]},
      {recursionLimit:24,callbacks:[{handleLLMEnd:completed}]}))
      .rejects.toBeInstanceOf(StructuredOutputParsingError);
    expect(completed).toHaveBeenCalledTimes(1);
  });
});
