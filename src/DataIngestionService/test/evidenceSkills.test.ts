import { describe, expect, it } from "vitest";
import { createAgent, createMiddleware, toolStrategy, StructuredOutputParsingError, FakeToolCallingModel } from "langchain";
import { AIMessageChunk } from "@langchain/core/messages";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { parseSkillMetadata } from "deepagents";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { evidenceSpecialistMode, skillForStage, loadEvidenceSkill, evidenceSkillsFingerprint,
  evidenceSkillRuntime, EVIDENCE_SKILL_NAMES, unwrapEvidenceMiddlewareError } from "../src/processors/evidence/evidenceSkills.ts";
import { needsReportingChainReview } from "../src/processors/evidence/evidenceAttribution.ts";

describe("evidence specialist skills", () => {
  it("defaults off and restricts routing to explicit review stages", () => {
    expect(evidenceSpecialistMode("")).toBe("off");
    expect(evidenceSpecialistMode(" skills ")).toBe("skills");
    expect(() => evidenceSpecialistMode("automatic")).toThrow();
    expect(skillForStage("canonicalization")).toBe("evidence-identity");
    expect(skillForStage("claim-attribution")).toBe("claim-attribution");
    for (const stage of ["primary-events", "primary-facts", "primary-claims", "independent", "reconciliation", "event-date-resolution"]) {
      expect(skillForStage(stage)).toBeNull();
    }
  });

  it.each(EVIDENCE_SKILL_NAMES)("parses %s with Deep Agents and fingerprints its resources", async name => {
    const metadata = parseSkillMetadata(fileURLToPath(new URL(`../src/processors/evidence/skills/${name}/SKILL.md`, import.meta.url)), "project");
    expect(metadata?.name).toBe(name);
    expect(metadata?.metadata?.version).toBe(name === "evidence-identity" ? "19" : "1");
    const skill = await loadEvidenceSkill(name);
    expect(skill.hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await evidenceSkillsFingerprint())).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(EVIDENCE_SKILL_NAMES)("runs real native middleware and strict structured output for %s", async name => {
    const runtime = await evidenceSkillRuntime(name);
    const format = toolStrategy(z.object({answer:z.string()}), {handleError:false});
    const model = new FakeStreamingChatModel({chunks:[new AIMessageChunk({content:"", tool_calls:[
      {name:format[0].name, args:{answer:"reviewed"}, id:"result", type:"tool_call"},
    ]})]});
    const seen: {tools:string[]; prompt:string}[] = [];
    const capture = createMiddleware({name:"CaptureSkillRequest", wrapModelCall(request, handler) {
      seen.push({tools:request.tools.map(tool => "name" in tool ? String(tool.name) : ""), prompt:request.systemMessage.text});
      return handler(request);
    }});
    const agent = createAgent({model, systemPrompt:runtime.systemPrompt,
      middleware:[...runtime.middleware, capture], responseFormat:format});
    const result = await agent.invoke({messages:[{role:"user",content:"Review the supplied candidate."}]}, {recursionLimit:8});
    expect(result.structuredResponse).toEqual({answer:"reviewed"});
    expect(seen).toHaveLength(1);
    expect(seen[0].tools).toContain("read_file");
    for (const tool of ["write_file", "edit_file", "execute", "task", "write_todos"]) expect(seen[0].tools).not.toContain(tool);
    expect(seen[0].prompt).toContain(runtime.systemPrompt);
    expect(seen[0].prompt).toContain(`/${name}/SKILL.md`);
    const other = EVIDENCE_SKILL_NAMES.find(value => value !== name)!;
    expect(seen[0].prompt).not.toContain(`/${other}/SKILL.md`);
  });

  it("keeps malformed structured output as a failure through native middleware", async () => {
    const runtime = await evidenceSkillRuntime("claim-attribution");
    const format = toolStrategy(z.object({answer:z.string()}), {handleError:false});
    const model = new FakeStreamingChatModel({chunks:[new AIMessageChunk({content:"",tool_calls:[
      {name:format[0].name,args:{answer:12},id:"invalid",type:"tool_call"},
    ]})]});
    const agent = createAgent({model,middleware:runtime.middleware,responseFormat:format});
    await expect(agent.invoke({messages:[{role:"user",content:"Review"}]},{recursionLimit:8})
      .catch(error => { throw unwrapEvidenceMiddlewareError(error); }))
      .rejects.toBeInstanceOf(StructuredOutputParsingError);
  });

  it.each(["/claim-attribution/references/examples.md", "/evidence-identity/SKILL.md"])("restricts native file reads: %s", async path => {
    const runtime = await evidenceSkillRuntime("claim-attribution");
    const format = toolStrategy(z.object({answer:z.string()}), {handleError:false});
    const model = new FakeToolCallingModel({toolCalls:[
      [{name:"read_file",args:{file_path:path},id:"read",type:"tool_call"}],
      [{name:format[0].name,args:{answer:"reviewed"},id:"final",type:"tool_call"}],
    ]});
    const agent = createAgent({model,middleware:runtime.middleware,responseFormat:format});
    const response = await agent.invoke({messages:[{role:"user",content:"Read the requested file."}]},{recursionLimit:8});
    const text = response.messages.filter(message => message.type === "tool").map(message => message.text).join("\n");
    if (path.startsWith("/claim-attribution/")) expect(text).toContain("Attribution examples");
    else {
      expect(text).toMatch(/denied/i);
      expect(text).not.toContain("# Evidence identity");
    }
  });

  it("uses reporting cues only as review leads", () => {
    expect(needsReportingChainReview("The supervisor instructed the crew to leave.", "instructed the crew to leave", "Priya testified that the supervisor ")).toBe(true);
    expect(needsReportingChainReview("The supervisor instructed the crew to leave.", "The supervisor instructed the crew to leave.", "")).toBe(false);
    expect(needsReportingChainReview("The score was 97.", "The score was 97.", "The examiner stated: ")).toBe(false);
  });
});
