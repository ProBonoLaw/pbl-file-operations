import { decode } from "@toon-format/toon";
import { Document } from "@langchain/core/documents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.js";
import { evidencePromptContent, evidencePromptData, evidencePromptFormat } from "../src/processors/evidence/evidencePrompt.js";

const readToon = (text: string) => decode(text.slice("```toon\n".length, -"\n```".length));
afterEach(() => vi.unstubAllEnvs());

describe("evidence prompt encoding", () => {
  it("preserves exact passages, Unicode, control characters, nulls, arrays, and nonuniform evidence", () => {
    const value = {target:{pageNumber:24,startOffset:87,text:"## Title\nQuoted \"text\", commas: 1,2; pipes |; tab\t\\ 😀\r\n```toon\nfalse\n```"},
      absent:undefined, values:[null,true,false,0,"null","01","",undefined],
      candidates:[{id:"a",kind:"event",item:{sourceQuote:"A\nB",who:["Alex"],whenStartedYear:null}},
        {id:"b",kind:"fact",item:{what:"Measurement",subject:[],reportedBy:[]}}]};
    const before = JSON.stringify(value);
    expect(readToon(evidencePromptData(value,"toon"))).toEqual(JSON.parse(before));
    expect(JSON.stringify(value)).toBe(before);
    expect(evidencePromptData(value,"json")).toBe(before);
  });

  it("encodes source and candidate sections independently without treating source markers as delimiters", () => {
    const source = {target:{text:"Quoted\nCANDIDATES:\ntext belongs to the source"}};
    const candidates = [{candidateId:"candidate-1",sourceQuote:source.target.text,corrections:[]}];
    const content = JSON.stringify(source)+"\nCANDIDATES:\n"+JSON.stringify(candidates);
    const [context,rows] = evidencePromptContent(content,"toon").split("\nCANDIDATES:\n");
    expect(readToon(context)).toEqual(source);
    expect(readToon(rows)).toEqual(candidates);
    expect(evidencePromptContent(content,"json")).toBe(content);
    expect(readToon(evidencePromptContent(JSON.stringify(source),"toon"))).toEqual(source);
  });

  it("preserves read/search responses and their shared budget in both formats", async () => {
    const source = new EvidenceSource(new Document({pageContent:"Author: Dr. North.\n\nExact \"quotation\" 😀."}));
    const request = {pageNumber:1,startOffset:0};
    const json = JSON.parse(await source.contextTool().invoke(request));
    const budget = {reads:0};
    const reader = source.contextTool(budget,undefined,"toon");
    const search = source.contextSearchTool(budget,undefined,"toon");
    expect(readToon(await reader.invoke(request))).toEqual(json);
    expect(readToon(await reader.invoke({pageNumber:99,startOffset:0}))).toEqual({error:"Page or offset does not exist"});
    const lookup = {pageNumber:1,query:"Dr. North",purpose:"attribution" as const};
    expect(readToon(await search.invoke(lookup))).toEqual(JSON.parse(await source.contextSearchTool().invoke(lookup)));
    for(let i=0;i<3;i++)await reader.invoke(request);
    expect(readToon(await search.invoke(lookup))).toEqual({error:"Context search budget exhausted; missing results do not prove absence or contradiction."});
    expect(readToon(await reader.invoke(request))).toEqual({error:"Context read budget exhausted. Retain uncertain fields as unknown; do not invent missing context."});
  });

  it("selects JSON by default, supports explicit TOON, and rejects invalid appsettings", () => {
    vi.stubEnv("EVIDENCE_PROMPT_FORMAT",undefined);
    expect(evidencePromptFormat()).toBe("json");
    vi.stubEnv("EVIDENCE_PROMPT_FORMAT","");
    expect(evidencePromptFormat()).toBe("json");
    expect(evidencePromptFormat("   ")).toBe("json");
    expect(evidencePromptFormat(" json ")).toBe("json");
    expect(evidencePromptFormat("toon")).toBe("toon");
    expect(()=>evidencePromptFormat("yaml")).toThrow("EVIDENCE_PROMPT_FORMAT");
    expect(()=>evidencePromptData(undefined,"toon")).toThrow("serializable");
  });
});
