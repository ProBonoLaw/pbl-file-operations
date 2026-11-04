import { Document } from "@langchain/core/documents";
import { EvidenceBudgetError } from "../src/processors/evidence/evidenceCostBudget.js";
import { EvidenceUnresolvedError } from "../src/processors/evidence/evidenceUnresolvedError.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { ZodError } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceExtractor, type ClaimExtractionResponse, type EventExtractionResponse, type FactExtractionResponse } from "../src/processors/evidence/evidenceExtractor.ts";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { EVIDENCE_CONTENT_VERSION, formatEvidenceContent } from "../src/processors/evidence/evidenceContent.ts";
import { EventDateResponseSchema } from "../src/processors/evidence/evidenceEventDates.ts";
import { StructuredOutputParsingError } from "langchain";
import { GraphRecursionError } from "@langchain/langgraph";
import type { EvidenceCheckpointStore } from "../src/processors/evidence/evidenceCheckpoint.ts";
import { createEvidenceModel, mistralFetch } from "../src/processors/evidence/evidenceModels.ts";
import { telemetryClient } from "../src/processors/appInsights.js";
import { EVIDENCE_FIELD_SUPPORT_INSTRUCTIONS } from "../src/processors/evidence/evidenceSupport.ts";
import { supportCaseInput, validateSupportSuite, gradeSupportCase } from "../scripts/evidence-support-benchmark.mjs";
import {EvidenceReviewPending, withEvidenceReviewDispatcher, type EvidenceReviewTask} from "../src/processors/evidence/evidenceAsync.js";
import {evidenceTaskHarness} from "./helpers/evidenceTaskHarness.js";

const agentMocks = vi.hoisted(() => ({ createAgent: vi.fn(), providerStrategy: vi.fn((schema) => ({ schema, native: true })) }));
const modelMocks = vi.hoisted(() => ({ chatOpenAIOptions: vi.fn(), chatAnthropicOptions: vi.fn() }));

vi.mock("langchain", async importOriginal => ({ ...await importOriginal<typeof import("langchain")>(),
  createAgent: agentMocks.createAgent, providerStrategy: agentMocks.providerStrategy }));
vi.mock("@langchain/openai", () => ({
  ChatOpenAI: class {
    constructor(options: unknown) {
      modelMocks.chatOpenAIOptions(options);
    }
  },
}));
vi.mock("@langchain/anthropic", () => ({
  ChatAnthropic: class {
    constructor(options: unknown) {
      modelMocks.chatAnthropicOptions(options);
    }
  },
}));
vi.mock("../src/processors/appInsights.js", () => ({
  telemetryClient: { trackEvent: vi.fn(), trackException: vi.fn() },
}));

function event(overrides: Partial<EventExtractionResponse> = {}): EventExtractionResponse {
  return {
    whenStartedYear: "2020",
    whenStartedMonth: null,
    whenStartedDay: null,
    whenStartedSeason: null,
    whenStartedQuarter: null,
    whenEndedYear: "2021",
    whenEndedMonth: "5",
    whenEndedDay: "10",
    whenEndedSeason: null,
    whenEndedQuarter: null,
    where: "Somewhere",
    what: "An event occurred",
    who: ["Person"],
    why: "A reason",
    eventType: "other",
    facets: [],
    sourceQuote: "An event occurred.",
    supportingQuotes: [],
    ...overrides,
  };
}

function staticFact(overrides: Partial<FactExtractionResponse> = {}): FactExtractionResponse {
  return {
    what: "The father-reported CBC Anxious-Depressed scale was Borderline, T-score 65, percentile 93.",
    subject: ["Casey Vale"],
    reportedBy: ["Casey's father"],
    where: "Unknown",
    asOfYear: null,
    asOfMonth: null,
    asOfDay: null,
    factType: "assessmentResult",
    facets: [{ namespace: "medical", value: "assessmentResult" }],
    sourceQuote: "Anxious-Depressed | Borderline | 65 | 93",
    supportingQuotes: [],
    ...overrides,
  };
}

function claim(overrides: Partial<ClaimExtractionResponse> = {}): ClaimExtractionResponse {
  return {
    statement: "John stole the vehicle.",
    claimant: "Jane",
    claimType: "allegation",
    polarity: "asserts",
    facets: [],
    who: ["Jane", "John"],
    whenStartedYear: "2025",
    whenStartedMonth: "2",
    whenStartedDay: "28",
    whenEndedYear: null,
    whenEndedMonth: null,
    whenEndedDay: null,
    where: "Unknown",
    sourceQuote: "John stole the vehicle.",
    supportingQuotes: [],
    ...overrides,
  };
}

function findSchemaRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(findSchemaRefs);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      key === "$ref" ? [String(child)] : findSchemaRefs(child));
  }
  return [];
}

function jsonResponseFormat(format: any) {
  return Array.isArray(format) ? format[0].schema : toJsonSchema(format.schema ?? format);
}

async function endedDate(overrides: Partial<EventExtractionResponse>) {
  const finder = Object.create(EvidenceExtractor.prototype) as EvidenceExtractor;
  (finder as any).generateEvidence = vi.fn().mockResolvedValue({
    events: [{ item: event(overrides), pageNumber: 0, sourceOffset: 0, sourceQuote: "An event occurred." }],
    facts: [],
    claims: [],
  });
  const source = new Document({
    pageContent: "An event occurred.",
    metadata: { pages: [0], sourceId: "source-1" },
  });

  const documents = await finder.generateDocuments(source);
  expect(documents).toHaveLength(1);
  return documents[0].metadata.whenEnded;
}

describe("EvidenceExtractor Azure model configuration", () => {
  beforeEach(() => {
    modelMocks.chatOpenAIOptions.mockClear();
    modelMocks.chatAnthropicOptions.mockClear();
    vi.stubEnv("AZURE_OPENAI_LLM_API_KEY", "test-key");
    vi.stubEnv("AZURE_OPENAI_API_DEPLOYMENT_NAME", "evidence-deployment");
    vi.stubEnv("AZURE_OPENAI_MODEL", "gpt-6-sol");
    vi.stubEnv("EVIDENCE_PRIMARY_DEPLOYMENT_NAME", "evidence-deployment");
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "research-gpt-6.1-sol");
    vi.stubEnv("EVIDENCE_PRIMARY_PROVIDER", "");
    vi.stubEnv("EVIDENCE_INDEPENDENT_PROVIDER", "");
    vi.stubEnv("AZURE_OPENAI_REASONING", "");
    vi.stubEnv("AZURE_OPENAI_VERBOSITY", "");
    vi.stubEnv("EVIDENCE_PRIMARY_REASONING", "");
    vi.stubEnv("EVIDENCE_INDEPENDENT_REASONING", "");
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "");
    vi.stubEnv("EVIDENCE_RECONCILIATION_PROVIDER", "");
    vi.stubEnv("EVIDENCE_RECONCILIATION_ENDPOINT", "");
    vi.stubEnv("EVIDENCE_RECONCILIATION_API_KEY", "");
    vi.stubEnv("EVIDENCE_RECONCILIATION_REASONING", "");
    vi.stubEnv("EVIDENCE_RECONCILIATION_SERVICE_TIER", "");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "off");
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each(["openai", "anthropic", "mistral", "deepseek"])("uses an explicit gathering HTTP timeout for %s without changing ordinary review clients", provider => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://test.services.ai.azure.com");
    vi.stubEnv("EVIDENCE_INDEPENDENT_PROVIDER", provider);
    const gathering = createEvidenceModel("INDEPENDENT", "research", {maxRetries:0,timeoutMs:300_000});
    const ordinary = createEvidenceModel("INDEPENDENT", "research");
    expect(gathering.timeoutMs).toBe(300_000);
    expect(ordinary.timeoutMs).toBe(180_000);
    const calls = provider === "anthropic" ? modelMocks.chatAnthropicOptions.mock.calls : modelMocks.chatOpenAIOptions.mock.calls;
    expect(provider === "anthropic" ? calls[0][0].clientOptions.timeout : calls[0][0].timeout).toBe(300_000);
    expect(calls[0][0].maxRetries).toBe(0);
    expect(provider === "anthropic" ? calls[1][0].clientOptions.timeout : calls[1][0].timeout).toBe(180_000);
  });

  it.each([0, -1, 1.5, 2_147_483_648])("rejects an invalid model timeout %s", timeoutMs => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://test.services.ai.azure.com");
    expect(()=>createEvidenceModel("INDEPENDENT", "research", {maxRetries:0,timeoutMs})).toThrow("timer limit");
  });

  it.each([
    ["Test", "https://test-resource.services.ai.azure.com/openai/deployments", "https://test-resource.services.ai.azure.com/openai/v1/"],
    ["Production", "https://prod-resource.cognitiveservices.azure.com/openai/deployments", "https://prod-resource.cognitiveservices.azure.com/openai/v1/"],
  ])("uses Azure v1 Responses routing for %s", (_environment, endpoint, baseURL) => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", endpoint);

    new EvidenceExtractor("account-1", "source-1");

    expect(modelMocks.chatOpenAIOptions).toHaveBeenCalledTimes(2);
    expect(modelMocks.chatOpenAIOptions).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: "evidence-deployment",
      apiKey: "test-key",
      configuration: { baseURL, fetch:expect.any(Function) },
      useResponsesApi: true,
      reasoning: { effort: "high" },
    }));
    expect(modelMocks.chatOpenAIOptions).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: "research-gpt-6.1-sol",
      apiKey: "test-key",
      configuration: { baseURL, fetch:expect.any(Function) },
      useResponsesApi: true,
      reasoning: { effort: "low" },
    }));
    expect(modelMocks.chatAnthropicOptions).not.toHaveBeenCalled();
  });

  it.each([
    "https://test-resource.services.ai.azure.com/api/projects/evidence-project",
    "https://test-resource.services.ai.azure.com/api/projects/evidence-project/openai/v1/",
  ])("preserves the Foundry project Responses route for %s", endpoint => {
    vi.stubEnv("EVIDENCE_PRIMARY_ENDPOINT", endpoint);
    vi.stubEnv("EVIDENCE_PRIMARY_DEPLOYMENT_NAME", "utility-model-router");
    createEvidenceModel("PRIMARY", "utility-model-router");
    expect(modelMocks.chatOpenAIOptions).toHaveBeenCalledWith(expect.objectContaining({
      model: "utility-model-router",
      configuration: {
        baseURL: "https://test-resource.services.ai.azure.com/api/projects/evidence-project/openai/v1/",
        fetch: expect.any(Function),
      },
      useResponsesApi: true,
    }));
  });

  it("sets a per-role Responses output ceiling for routed evidence calls", () => {
    vi.stubEnv("EVIDENCE_PRIMARY_ENDPOINT", "https://test-resource.services.ai.azure.com/api/projects/evidence-project");
    vi.stubEnv("EVIDENCE_PRIMARY_DEPLOYMENT_NAME", "fast-tasks-model-router");
    vi.stubEnv("EVIDENCE_PRIMARY_MAX_OUTPUT_TOKENS", "16384");
    createEvidenceModel("PRIMARY", "fast-tasks-model-router");
    expect(modelMocks.chatOpenAIOptions).toHaveBeenCalledWith(expect.objectContaining({
      model: "fast-tasks-model-router",
      maxTokens: 16384,
      useResponsesApi: true,
    }));
  });

  it.each(["medium", "high"])("uses primary %s reasoning and independent low before the global fallback", effort => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com/openai/deployments");
    vi.stubEnv("AZURE_OPENAI_REASONING", "medium");
    vi.stubEnv("EVIDENCE_PRIMARY_REASONING", effort);
    vi.stubEnv("EVIDENCE_INDEPENDENT_REASONING", "low");

    new EvidenceExtractor("account-1", "source-1");

    expect(modelMocks.chatOpenAIOptions).toHaveBeenNthCalledWith(1, expect.objectContaining({ reasoning: { effort } }));
    expect(modelMocks.chatOpenAIOptions).toHaveBeenNthCalledWith(2, expect.objectContaining({ reasoning: { effort: "low" } }));
  });

  it.each(["tasks-gpt-6.0-luna", "recon-test-gpt-6-luna"])("routes reconciliation through %s at xhigh when configured", deployment => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com/openai/deployments");
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", deployment);
    vi.stubEnv("EVIDENCE_RECONCILIATION_REASONING", "xhigh");

    new EvidenceExtractor("account-1", "source-1");

    expect(modelMocks.chatOpenAIOptions).toHaveBeenCalledTimes(3);
    expect(modelMocks.chatOpenAIOptions).toHaveBeenNthCalledWith(3, expect.objectContaining({
      model: deployment,
      apiKey: "test-key",
      configuration: { baseURL: "https://example.services.ai.azure.com/openai/v1/", fetch:expect.any(Function) },
      useResponsesApi: true,
      reasoning: { effort: "xhigh" },
    }));
  });

  it.each(["sol", "always", "invalid"])("rejects invalid fallback mode %s", mode => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com/");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", mode);
    expect(() => new EvidenceExtractor("account-1", "source-1")).toThrow("EVIDENCE_RECONCILIATION_FALLBACK");
  });

  it("rejects fallback to the same deployment", () => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com/");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "independent");
    expect(() => new EvidenceExtractor("account-1", "source-1")).toThrow("different deployment");
  });

  it("configures a separate cheap-first reconciliation fallback and Haiku independent pass", () => {
    const project = "https://example.services.ai.azure.com/api/projects/test-project";
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com");
    vi.stubEnv("EVIDENCE_PRIMARY_DEPLOYMENT_NAME", "fast-tasks-model-router");
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "tasks-claude-haiku-5-5");
    vi.stubEnv("EVIDENCE_INDEPENDENT_PROVIDER", "anthropic");
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "fast-tasks-model-router");
    vi.stubEnv("EVIDENCE_RECONCILIATION_ENDPOINT", project);
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "configured");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK_DEPLOYMENT_NAME", "utility-model-router");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK_ENDPOINT", project);

    new EvidenceExtractor("account-1", "source-1");

    expect(modelMocks.chatAnthropicOptions).toHaveBeenCalledWith(expect.objectContaining({
      model:"tasks-claude-haiku-5-5",
    }));
    expect(modelMocks.chatOpenAIOptions.mock.calls.map(([options]) => options.model)).toEqual([
      "fast-tasks-model-router", "fast-tasks-model-router", "utility-model-router",
    ]);
    expect(modelMocks.chatOpenAIOptions.mock.calls[2][0].configuration.baseURL)
      .toBe(project + "/openai/v1/");
  });

  it("requires a deployment for a configured reconciliation fallback", () => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "configured");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK_DEPLOYMENT_NAME", "");
    expect(() => new EvidenceExtractor("account-1", "source-1"))
      .toThrow("EVIDENCE_RECONCILIATION_FALLBACK_DEPLOYMENT_NAME");
  });

  it("passes priority only to the configured reconciliation client", () => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com/openai/deployments");
    vi.stubEnv("EVIDENCE_RECONCILIATION_SERVICE_TIER", "priority");

    new EvidenceExtractor("account-1", "source-1");

    expect(modelMocks.chatOpenAIOptions).toHaveBeenCalledTimes(3);
    expect(modelMocks.chatOpenAIOptions).toHaveBeenNthCalledWith(3, expect.objectContaining({
      model: "research-gpt-6.1-sol",
      useResponsesApi: true,
      reasoning: { effort: "low" },
      service_tier: "priority",
    }));
    expect(modelMocks.chatOpenAIOptions.mock.calls[0][0].service_tier).toBeUndefined();
    expect(modelMocks.chatOpenAIOptions.mock.calls[1][0].service_tier).toBeUndefined();
  });

  it.each([undefined, "mistral"])("routes Foundry Mistral through Chat Completions with provider %s", provider => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com/openai/deployments");
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "Recon-Test-Mistral-Large-3");
    if (provider) vi.stubEnv("EVIDENCE_RECONCILIATION_PROVIDER", provider);
    vi.stubEnv("EVIDENCE_RECONCILIATION_ENDPOINT", "https://mistral-resource.services.ai.azure.com/models");
    vi.stubEnv("EVIDENCE_RECONCILIATION_API_KEY", "mistral-key");
    vi.stubEnv("AZURE_OPENAI_REASONING", "high");
    vi.stubEnv("AZURE_OPENAI_VERBOSITY", "medium");

    new EvidenceExtractor("account-1", "source-1");

    const options = modelMocks.chatOpenAIOptions.mock.calls[2][0];
    expect(options).toMatchObject({
      model: "Recon-Test-Mistral-Large-3", apiKey: "mistral-key",
      configuration: {baseURL: "https://mistral-resource.services.ai.azure.com/openai/v1/", fetch: expect.any(Function)},
      useResponsesApi: false, maxTokens: 8192,
    });
    expect(options).not.toHaveProperty("reasoning");
    expect(options).not.toHaveProperty("verbosity");
    expect(options).not.toHaveProperty("service_tier");
    expect(modelMocks.chatOpenAIOptions.mock.calls[0][0].useResponsesApi).toBe(true);
    expect(modelMocks.chatOpenAIOptions.mock.calls[1][0].useResponsesApi).toBe(true);
  });

  it("rejects a GPT service tier override for Mistral", () => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com/openai/deployments");
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "Recon-Test-Mistral-Large-3");
    vi.stubEnv("EVIDENCE_RECONCILIATION_SERVICE_TIER", "priority");
    expect(() => new EvidenceExtractor("account-1", "source-1"))
      .toThrow("EVIDENCE_RECONCILIATION_SERVICE_TIER requires an OpenAI model");
  });

  it.each([undefined, "deepseek"])("routes Foundry DeepSeek through Chat Completions with provider %s", provider => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com/openai/deployments");
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "Recon-Test-DeepSeek-V4-Pro");
    if (provider) vi.stubEnv("EVIDENCE_RECONCILIATION_PROVIDER", provider);
    vi.stubEnv("EVIDENCE_RECONCILIATION_API_KEY", "deepseek-key");
    vi.stubEnv("EVIDENCE_RECONCILIATION_MAX_OUTPUT_TOKENS", "4096");
    vi.stubEnv("EVIDENCE_RECONCILIATION_REQUEST_INTERVAL_MS", "32000");
    vi.stubEnv("AZURE_OPENAI_REASONING", "high");
    vi.stubEnv("AZURE_OPENAI_VERBOSITY", "medium");
    new EvidenceExtractor("account-1", "source-1");
    const options = modelMocks.chatOpenAIOptions.mock.calls[2][0];
    expect(options).toMatchObject({model: "Recon-Test-DeepSeek-V4-Pro", apiKey: "deepseek-key",
      configuration: {baseURL: "https://example.services.ai.azure.com/openai/v1/",fetch: expect.any(Function)},
      useResponsesApi: false,maxTokens: 4096});
    expect(options).not.toHaveProperty("reasoning");
    expect(options).not.toHaveProperty("verbosity");
    expect(options).not.toHaveProperty("service_tier");
  });

  it("removes only assistant names from Mistral tool-round requests", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      const messages = [
        {role: "user", name: "source", content: "Input"},
        {role: "assistant", name: "model", content: null, tool_calls: [{id: "abc", type: "function", function: {name: "read_source_page", arguments: "{}"}}]},
        {role: "tool", name: "read_source_page", tool_call_id: "abc", content: "Evidence"},
      ];
      await mistralFetch("https://example.services.ai.azure.com/openai/v1/chat/completions", {
        method: "POST", headers: {Authorization: "Bearer test-key"},
        body: JSON.stringify({model: "Recon-Test-Mistral-Large-3", messages, response_format: {type: "json_schema"}}),
      });
      const init = spy.mock.calls[0][1]!;
      const body = JSON.parse(init.body as string);
      expect(body.messages[1]).not.toHaveProperty("name");
      expect(body.messages[1].tool_calls).toEqual(messages[1].tool_calls);
      expect(body.messages[0]).toEqual(messages[0]);
      expect(body.messages[2]).toEqual(messages[2]);
      expect(body.response_format).toEqual({type: "json_schema"});
      expect(init.headers).toEqual({Authorization: "Bearer test-key"});
    } finally {spy.mockRestore();}
  });

  it("uses provider-default verbosity when no verbosity setting is supplied", () => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com/openai/deployments");

    new EvidenceExtractor("account-1", "source-1");

    for (const [options] of modelMocks.chatOpenAIOptions.mock.calls) {
      expect(options).not.toHaveProperty("verbosity");
    }
  });

  it("retains the legacy global reasoning setting when role overrides are absent", () => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com/openai/deployments");
    vi.stubEnv("AZURE_OPENAI_REASONING", "medium");

    new EvidenceExtractor("account-1", "source-1");

    for (const [options] of modelMocks.chatOpenAIOptions.mock.calls) {
      expect(options.reasoning).toEqual({ effort: "medium" });
    }
  });

  it("routes both named Claude deployments to the Foundry Anthropic Messages endpoint", () => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example-ai-test.services.ai.azure.com/openai/deployments");
    vi.stubEnv("EVIDENCE_PRIMARY_DEPLOYMENT_NAME", "tasks-claude-haiku-5-5");
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "research-claude-sonnet-5-5");

    new EvidenceExtractor("account-1", "source-1");

    expect(modelMocks.chatOpenAIOptions).not.toHaveBeenCalled();
    expect(modelMocks.chatAnthropicOptions).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: "tasks-claude-haiku-5-5",
      apiKey: "test-key",
      clientOptions: { baseURL: "https://example-ai-test.services.ai.azure.com/anthropic", timeout: 180_000, fetch:expect.any(Function) },
      maxTokens: 16_384,
    }));
    expect(modelMocks.chatAnthropicOptions).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: "research-claude-sonnet-5-5",
      apiKey: "test-key",
      clientOptions: { baseURL: "https://example-ai-test.services.ai.azure.com/anthropic", timeout: 180_000, fetch:expect.any(Function) },
    }));
  });

  it.each(["off", "annotate"])("uses native Claude evidence schemas and larger envelopes with event structure %s", async mode => {
    vi.stubEnv("EVIDENCE_EVENT_STRUCTURE_MODE", mode);
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example-ai-test.services.ai.azure.com/openai/deployments");
    vi.stubEnv("EVIDENCE_PRIMARY_DEPLOYMENT_NAME", "tasks-claude-haiku-5-5");
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "research-claude-sonnet-5-5");
    agentMocks.createAgent.mockReset();
    agentMocks.providerStrategy.mockClear();
    agentMocks.createAgent.mockImplementation(({ responseFormat }) => {
      const requestedSchema = responseFormat.schema;
      const fields = requestedSchema.shape ?? requestedSchema.properties;
      const content = "payload" in fields ? { events: [], facts: [], claims: [] }
        : Object.fromEntries(["events", "facts", "claims"]
          .filter((field) => field in fields).map((field) => [field, []]));
      const structuredResponse = "payload" in fields ? { payload: JSON.stringify(content) } : content;
      return { invoke: vi.fn().mockResolvedValue({ structuredResponse }) };
    });

    const extractor = new EvidenceExtractor("account-1", "source-1");
    const documents = await extractor.generateDocuments(new Document({ pageContent: "A factual statement.", metadata: { pages: [1] } }));

    expect(documents).toEqual([]);
    expect(agentMocks.providerStrategy).toHaveBeenCalledTimes(4);
    expect(agentMocks.createAgent.mock.calls.every(([options]) => options.responseFormat.native)).toBe(true);
    const formats = agentMocks.providerStrategy.mock.calls.map(([schema]) => schema);
    expect(formats.filter((schema) => schema.shape).map((schema) => Object.keys(schema.shape))).toEqual([["payload"]]);
    const native = formats.filter((schema) => schema.properties);
    expect(native.map((schema) => Object.keys(schema.properties).join(",")).sort())
      .toEqual(["claims", "events", "facts"]);
    for (const schema of native) {
      const serialized = JSON.stringify(schema);
      expect(findSchemaRefs(schema)).toEqual([]);
      expect(serialized).not.toMatch(/"type":\["string","null"\]/);
      expect(serialized).not.toMatch(/"minLength"|"minimum"/);
    }
  });

  it("allows a mixed provider pair with a separate Claude endpoint and key", () => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://gpt-resource.services.ai.azure.com/openai/deployments");
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "legal-reviewer");
    vi.stubEnv("EVIDENCE_INDEPENDENT_PROVIDER", "anthropic");
    vi.stubEnv("EVIDENCE_INDEPENDENT_ENDPOINT", "https://claude-resource.services.ai.azure.com/anthropic/v1/messages");
    vi.stubEnv("EVIDENCE_INDEPENDENT_API_KEY", "claude-key");

    new EvidenceExtractor("account-1", "source-1");

    expect(modelMocks.chatOpenAIOptions).toHaveBeenCalledTimes(1);
    expect(modelMocks.chatAnthropicOptions).toHaveBeenCalledTimes(1);
    expect(modelMocks.chatAnthropicOptions).toHaveBeenCalledWith(expect.objectContaining({
      model: "legal-reviewer",
      apiKey: "claude-key",
      clientOptions: { baseURL: "https://claude-resource.services.ai.azure.com/anthropic", timeout: 180_000, fetch:expect.any(Function) },
    }));
  });

  it("rejects an unknown provider instead of silently using OpenAI", () => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com/openai/deployments");
    vi.stubEnv("EVIDENCE_PRIMARY_PROVIDER", "unknown");

    expect(() => new EvidenceExtractor("account-1", "source-1"))
      .toThrow("EVIDENCE_PRIMARY_PROVIDER must be openai, anthropic, mistral, or deepseek");
  });
});

describe("EvidenceExtractor reconciliation candidate replay", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("classifies source-verified facts before deduplication without an extra model invocation", async () => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com");
    vi.stubEnv("AZURE_OPENAI_LLM_API_KEY", "test-key");
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "off");
    vi.stubEnv("EVIDENCE_CANONICALIZATION_MODE", "off");
    const quote = "Casey seemed comfortable with the examiner.";
    const author = "Examiner: Avery North";
    const doc = new Document({pageContent:`${author}\n\n${quote}`,metadata:{pages:[1],sourceId:"classification-integration"}});
    const source = new EvidenceSource(doc);
    const shared = {sourceQuote:quote,supportingQuotes:[{pageNumber:1,quote:author}],
      facets:[{namespace:"medical" as const,value:"observation"}]};
    const candidates = [
      {id:"1:0:fact",kind:"fact",item:staticFact({...shared,what:quote,subject:["Casey"],reportedBy:["Avery North"],factType:"condition"}),extractedBy:["primary-facts:test"]},
      {id:"1:0:claim",kind:"claim",item:claim({...shared,statement:quote,claimant:"Avery North",claimType:"opinion",polarity:"asserts",
        who:["Casey","Avery North"],whenStartedYear:null,whenStartedMonth:null,whenStartedDay:null}),extractedBy:["primary-claims:test"]},
    ];
    const store = {mode:"replay" as const,get:vi.fn().mockResolvedValue({version:1,sourceContentHash:source.contentHash,
      pageNumber:1,startOffset:0,textHash:createHash("sha256").update(source.windows()[0].text).digest("hex"),candidates}),put:vi.fn()};
    const invoke = vi.fn().mockResolvedValue({structuredResponse:{decisions:candidates.map(candidate => ({candidateId:candidate.id,
      verdict:"supported",keepOriginal:true,reason:"",corrections:[],events:[],facts:[],claims:[]}))}});
    agentMocks.createAgent.mockReset();
    agentMocks.createAgent.mockReturnValue({invoke});
    const semaphore = {acquire:vi.fn().mockResolvedValue(true),release:vi.fn()};
    const extractor = new EvidenceExtractor("account-1","classification-integration",semaphore,undefined,store);
    const documents = await extractor.generateDocuments(doc);
    expect(documents).toHaveLength(1);
    expect(documents[0].metadata).toMatchObject({claimType:"opinion",claimPolarity:"asserts",claimant:"Avery North",
      classificationHistory:[expect.objectContaining({ruleId:"source-subjective-observation",original:expect.objectContaining({factType:"condition"})})]});
    expect(documents[0].metadata.extractedBy).toEqual(expect.arrayContaining(["primary-facts:test","primary-claims:test"]));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it.each(["Recon-Test-Mistral-Large-3", "Recon-Test-DeepSeek-V4-Pro"])("uses native schema output for %s and rejects invalid agent responses while releasing permits", async deployment => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com");
    vi.stubEnv("AZURE_OPENAI_LLM_API_KEY", "test-key");
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", deployment);
    vi.stubEnv("EVIDENCE_CANONICALIZATION_MODE", "off");
    const doc = new Document({pageContent: "An event occurred.", metadata: {pages: [1]}});
    const source = new EvidenceSource(doc);
    const window = source.windows()[0];
    const store = {mode: "replay" as const, get: vi.fn().mockResolvedValue({version: 1,
      sourceContentHash: source.contentHash, pageNumber: 1, startOffset: 0,
      textHash: createHash("sha256").update(window.text).digest("hex"),
      candidates: [{id: "1:0:candidate-0",kind: "event",item: event(),extractedBy: ["primary-events:test"]}]}), put: vi.fn()};
    const semaphore = {acquire: vi.fn().mockResolvedValue(true),release: vi.fn()};
    const valid = {structuredResponse: {decisions: [{candidateId: "1:0:candidate-0",verdict: "supported",keepOriginal: true,
      reason: "",corrections: [],events: [],facts: [],claims: []}]}};
    const invoke = vi.fn().mockResolvedValue(valid);
    agentMocks.createAgent.mockReset();
    agentMocks.providerStrategy.mockClear();
    agentMocks.createAgent.mockReturnValue({invoke});
    const extractor = new EvidenceExtractor("account-1", "source-1",semaphore,undefined,store);
    await expect(extractor.generateDocuments(doc)).resolves.toHaveLength(1);
    expect(agentMocks.providerStrategy).toHaveBeenCalledTimes(1);
    expect(agentMocks.createAgent.mock.calls[0][0].responseFormat.native).toBe(true);
    expect(agentMocks.createAgent.mock.calls[0][0].systemPrompt).toContain("This stage does not deduplicate.");
    expect(agentMocks.createAgent.mock.calls[0][0].systemPrompt).toContain("supportingQuotes from ANY supplied page");
    invoke.mockResolvedValueOnce({structuredResponse: {decisions: "invalid"}});
    await expect(extractor.generateDocuments(doc)).rejects.toBeInstanceOf(ZodError);
    invoke.mockResolvedValueOnce({...valid,messages: [{response_metadata: {finish_reason: "length"}}]});
    await expect(extractor.generateDocuments(doc)).rejects.toThrow("response reached its output token limit");
    expect(semaphore.acquire).toHaveBeenCalledTimes(3);
    expect(semaphore.release).toHaveBeenCalledTimes(3);
  });

  it("uses source-matched candidates without invoking extraction workers", async () => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com");
    vi.stubEnv("AZURE_OPENAI_LLM_API_KEY", "test-key");
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "");
    agentMocks.createAgent.mockClear();
    const source = new EvidenceSource(new Document({
      pageContent: "An event occurred.", metadata: { pages: [1], sourceId: "source-1" },
    }));
    const window = source.windows()[0];
    const candidates = [{ id: `${window.pageNumber}:${window.startOffset}:candidate-0`,
      kind: "event", item: event(), extractedBy: ["primary-events:tasks-gpt-6.0-luna"] }];
    const store = {
      mode: "replay" as const,
      get: vi.fn().mockResolvedValue({ version: 1, sourceContentHash: source.contentHash,
        pageNumber: window.pageNumber, startOffset: window.startOffset,
        textHash: createHash("sha256").update(window.text).digest("hex"), candidates }),
      put: vi.fn(),
    };
    const extractor = new EvidenceExtractor("account-1", "source-1", undefined, undefined, store);
    const reviewed = { events: [], facts: [], claims: [] };
    const reconcile = vi.fn().mockResolvedValue(reviewed);
    (extractor as any).reconcileWindowCandidates = reconcile;

    await expect((extractor as any).extractWindow(source, window)).resolves.toEqual(reviewed);
    expect(reconcile).toHaveBeenCalledWith(candidates, source, window, undefined);
    expect(agentMocks.createAgent).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();

    store.get.mockResolvedValueOnce({ version: 1, sourceContentHash: "different",
      pageNumber: window.pageNumber, startOffset: window.startOffset,
      textHash: createHash("sha256").update(window.text).digest("hex"), candidates });
    await expect((extractor as any).extractWindow(source, window)).rejects.toThrow(/does not match/);
  });

  it("reuses an existing candidate snapshot during capture-only recovery", async () => {
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.services.ai.azure.com");
    vi.stubEnv("AZURE_OPENAI_LLM_API_KEY", "test-key");
    agentMocks.createAgent.mockClear();
    const source = new EvidenceSource(new Document({
      pageContent: "An event occurred.", metadata: { pages: [1], sourceId: "source-1" },
    }));
    const window = source.windows()[0];
    const store = {
      mode: "captureOnly" as const,
      get: vi.fn().mockResolvedValue({ version: 1, sourceContentHash: source.contentHash,
        pageNumber: window.pageNumber, startOffset: window.startOffset,
        textHash: createHash("sha256").update(window.text).digest("hex"),
        candidates: [{ id: "1:0:candidate-0", kind: "event", item: event(),
          extractedBy: ["primary-events:tasks-gpt-6.0-luna"] }] }),
      put: vi.fn(),
    };
    const extractor = new EvidenceExtractor("account-1", "source-1", undefined, undefined, store);

    await expect((extractor as any).extractWindow(source, window)).resolves.toEqual({
      events: [], facts: [], claims: [],
    });
    expect(store.get).toHaveBeenCalledWith(window);
    expect(store.put).not.toHaveBeenCalled();
    expect(agentMocks.createAgent).not.toHaveBeenCalled();
  });
});

describe("EvidenceExtractor ended date validation", () => {
  it("retains a valid ended date", async () => {
    await expect(endedDate({})).resolves.toEqual({
      year: "2021",
      month: "5",
      day: "10",
      season: null,
      quarter: null,
    });
  });

  it.each(["unknown", "2021ish"])("normalizes an ended year %s", async (year) => {
    await expect(endedDate({ whenEndedYear: year })).resolves.toEqual(year === "unknown" ? {
      year: null,
      month: "5",
      day: "10",
      season: null,
      quarter: null,
    } : null);
  });

  it.each(["unknown", "5th"])("clears an invalid ended month %s", async (month) => {
    await expect(endedDate({ whenEndedMonth: month })).resolves.toEqual({
      year: "2021",
      month: null,
      day: "10",
      season: null,
      quarter: null,
    });
  });

  it.each(["unknown", "10th"])("normalizes an ended day %s", async (day) => {
    await expect(endedDate({ whenEndedDay: day })).resolves.toEqual(day === "unknown" ? {
      year: "2021",
      month: "5",
      day: null,
      season: null,
      quarter: null,
    } : null);
  });
});

describe("EvidenceExtractor evidence documents", () => {
  it("keeps a specific type when identical generic and classified events merge", async () => {
    const finder = Object.create(EvidenceExtractor.prototype) as EvidenceExtractor;
    Object.assign(finder, {accountId: "account-1", sourceId: "source-1"});
    const quote = "Casey completed the assessment.";
    const located = { pageNumber: 1, sourceOffset: 0, sourceQuote: quote,
      sourceSpans: [{ pageNumber: 1, sourceOffset: 0, sourceQuote: quote }], extractedBy: [] };
    (finder as any).generateEvidence = vi.fn().mockResolvedValue({
      events: [
        { ...located, item: event({ what: quote, sourceQuote: quote }) },
        { ...located, item: event({ what: quote, sourceQuote: quote, eventType: "assessment",
          facets: [{ namespace: "education", value: "academicAssessment" }] }) },
      ], facts: [], claims: [],
    });

    const documents = await finder.generateDocuments(new Document({ pageContent: quote, metadata: { pages: [1] } }));

    expect(documents).toHaveLength(1);
    expect(documents[0].metadata.eventType).toBe("assessment");
    expect(documents[0].metadata.tags).toEqual(["fact", "event", "eventType:assessment", "facet:education:academicAssessment"]);
    expect(documents[0].metadata.sourceQuote).toBe(quote);
  });

  it("consolidates event and fact extractions while preserving the attributed claim", async () => {
    const finder = Object.create(EvidenceExtractor.prototype) as EvidenceExtractor;
    Object.assign(finder, {accountId: "account-1", sourceId: "source-1", canonicalizationMode: "off"});
    const quote = "Casey paid 250 dollars on March 5, 2025.";
    const located = {pageNumber: 1, sourceOffset: 0, sourceQuote: quote,
      sourceSpans: [{pageNumber: 1, sourceOffset: 0, sourceQuote: quote}]};
    const common = {what: "Casey paid 250 dollars.", sourceQuote: quote, where: "Unknown"};
    (finder as any).generateEvidence = vi.fn().mockResolvedValue({
      events: [{...located, extractedBy: ["primary-events"], item: event({...common, who: ["Casey"], why: "Unknown",
        eventType: "payment", whenStartedYear: "2025", whenStartedMonth: "3", whenStartedDay: "5",
        whenEndedYear: null, whenEndedMonth: null, whenEndedDay: null})}],
      facts: [{...located, extractedBy: ["primary-facts"], item: staticFact({...common, subject: ["Casey"], reportedBy: [],
        factType: "recordedValue", facets: []})}],
      claims: [{...located, extractedBy: ["primary-claims"], item: claim({statement: common.what, sourceQuote: quote,
        claimant: "Casey", claimType: "factualAssertion", who: ["Casey"], whenStartedYear: null,
        whenStartedMonth: null, whenStartedDay: null})}],
    });
    const documents = await finder.generateDocuments(new Document({pageContent: quote, metadata: {pages: [1]}}));
    expect(documents).toHaveLength(2);
    expect(documents[0].metadata).toMatchObject({accountId: "account-1", sourceId: "source-1", eventType: "payment"});
    expect(documents[0].metadata.factType).toBeUndefined();
    expect(documents[0].metadata.claimType).toBeUndefined();
    expect(documents[0].metadata.tags).toEqual(expect.arrayContaining(["event", "fact"]));
    expect(documents[0].metadata.extractedBy).toHaveLength(2);
    expect(documents[1].metadata).toMatchObject({claimType: "factualAssertion", claimant: "Casey", claimPolarity: "asserts"});
    expect(documents[1].pageContent).toContain("Claim");
    expect(documents[0].pageContent).toContain("Event: Casey paid 250 dollars.");
  });

  it("preserves specific domain facets on attributed claims with canonical spelling", async () => {
    const finder = Object.create(EvidenceExtractor.prototype) as EvidenceExtractor;
    const quote = "Jordan recommends extra time for written work.";
    (finder as any).generateEvidence = vi.fn().mockResolvedValue({
      events: [], facts: [], claims: [{ item: claim({
        statement: quote, claimant: "Jordan", claimType: "opinion", sourceQuote: quote,
        facets: [
          { namespace: "education", value: "LEARNING ACCOMMODATION" },
          { namespace: "education", value: "learningAccommodation" },
          { namespace: "education", value: "written expression support" },
        ],
      }), pageNumber: 1, sourceOffset: 0, sourceQuote: quote }],
    });

    const [document] = await finder.generateDocuments(new Document({ pageContent: quote, metadata: { pages: [1] } }));

    expect(document.metadata.tags).toEqual([
      "claim", "claimType:opinion", "claimPolarity:asserts",
      "facet:education:learningAccommodation", "facet:education:writtenExpressionSupport",
    ]);
    expect(document.metadata.evidenceTaxonomyVersion).toBe("1");
    expect(document.metadata.claimant).toBe("Jordan");
    expect(document.pageContent).toContain(quote);
  });

  it("keeps an atomic event and a reported claim separate with searchable tags and source pages", async () => {
    const finder = Object.create(EvidenceExtractor.prototype) as EvidenceExtractor;
    (finder as any).generateEvidence = vi.fn().mockResolvedValue({
      events: [{ item: event({
        whenStartedYear: "2025",
        whenStartedMonth: "3",
        whenStartedDay: "5",
        whenEndedYear: null,
        whenEndedMonth: null,
        whenEndedDay: null,
        what: "Jane spoke to Detective Smith.",
        who: ["Jane", "Detective Smith"],
        why: "Unknown",
        eventType: "communication",
        facets: [
          { namespace: "communication", value: "email" },
          { namespace: "legal", value: "notice" },
        ],
        sourceQuote: "Jane spoke to Detective Smith.",
      }), pageNumber: 2, sourceOffset: 1, sourceQuote: "Jane spoke to Detective Smith." }],
      facts: [],
      claims: [{ item: claim(), pageNumber: 2, sourceOffset: 41, sourceQuote: "John stole the vehicle." }],
    });
    const source = new Document({
      pageContent: "First page.\n<!-- PageBreak -->\nJane spoke to Detective Smith. She said John stole the vehicle.",
      metadata: {
        pages: [1, 2], title: "Interview", source: "https://example.test/source",
        sourceId: "source-1", tags: ["CurrentOrder"],
      },
    });

    const documents = await finder.generateDocuments(source);

    expect(documents).toHaveLength(2);
    expect(documents[0].metadata).toMatchObject({
      pages: [2], title: "Interview", source: "https://example.test/source", sourceId: "source-1",
      sourceQuote: "Jane spoke to Detective Smith.", sourceOffset: 1,
      whenStarted: { year: "2025", month: "3", day: "5" },
      tags: ["CurrentOrder", "fact", "event", "eventType:communication", "facet:communication:email", "facet:legal:notice"],
    });
    expect(documents[0].metadata.what).toBe("Jane spoke to Detective Smith.");
    expect(documents[0].pageContent).toContain("Event start date: 5 March 2025");
    expect(documents[1].pageContent).toContain("Claim by Jane (allegation; asserts): John stole the vehicle.");
    expect(documents[1].pageContent).toContain("Date referenced by the claim: 28 February 2025");
    expect(documents[1].metadata).toMatchObject({
      pages: [2], claimant: "Jane", claimType: "allegation", claimPolarity: "asserts",
      sourceQuote: "John stole the vehicle.", sourceOffset: 41,
      whenStarted: { year: "2025", month: "2", day: "28" },
      tags: ["CurrentOrder", "claim", "claimType:allegation", "claimPolarity:asserts"],
    });
    expect(documents[1].metadata.tags).not.toContain("event");
  });

  it("indexes assessment results as static facts with distinct subject and reporter", async () => {
    const finder = Object.create(EvidenceExtractor.prototype) as EvidenceExtractor;
    const row = "Anxious-Depressed | Borderline | 65 | 93";
    (finder as any).generateEvidence = vi.fn().mockResolvedValue({
      events: [],
      facts: [{ item: staticFact({ asOfYear: "2025", asOfMonth: "3" }), pageNumber: 1, sourceOffset: 0, sourceQuote: row,
        sourceSpans: [{ pageNumber: 1, sourceOffset: 0, sourceQuote: row }], extractedBy: ["primary-facts:tasks-gpt-6.0-luna"] }],
      claims: [],
    });
    const source = new Document({ pageContent: row, metadata: { pages: [1], sourceId: "source-1" } });

    const documents = await finder.generateDocuments(source);

    expect(documents).toHaveLength(1);
    expect(documents[0].metadata).toMatchObject({
      factType: "assessmentResult",
      subject: ["Casey Vale"],
      reportedBy: ["Casey's father"],
      who: ["Casey Vale", "Casey's father"],
      tags: ["fact", "factType:assessmentResult", "facet:medical:assessmentResult"],
      sourceQuote: row,
      sourceOffset: 0,
      evidenceSchemaVersion: "3",
    });
    expect(documents[0].metadata.tags).not.toContain("event");
    expect(documents[0].metadata.tags).not.toContain("eventType:observation");
    expect(documents[0].metadata.whenStarted.year).toBeNull();
    expect(documents[0].pageContent).toContain("As of: March 2025");
    expect(documents[0].metadata.evidenceContentVersion).toBe(EVIDENCE_CONTENT_VERSION);
  });

});

describe("EvidenceExtractor agent responses", () => {
  beforeEach(() => {
    agentMocks.createAgent.mockReset();
    vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://example.openai.azure.com/");
    vi.stubEnv("AZURE_OPENAI_LLM_API_KEY", "test-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function makeExtractor(checkpointStore?: EvidenceCheckpointStore) {
    const semaphore = {
      acquire: vi.fn(async () => true),
      release: vi.fn(() => {}),
    };
    return {
      extractor: new EvidenceExtractor("account-1", "source-1", semaphore, checkpointStore),
      semaphore,
    };
  }

  const source = new Document({ pageContent: "A factual statement.", metadata: { pages: [1] } });

  const correction = (field: string, value: Record<string, unknown> = {}) => ({
    field, text: null, people: [], facets: [], supportingQuotes: [], ...value,
  });

  describe("field support review through agent invocation", () => {
    const suite = validateSupportSuite(JSON.parse(readFileSync(new URL("./fixtures/evidence-support.json", import.meta.url), "utf8")));
    const unchanged = (id: string) => ({candidateId: id, verdict: "supported", keepOriginal: true,
      reason: "", corrections: [], events: [], facts: [], claims: []});

    function replay(id: string) {
      vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "off");
      vi.stubEnv("EVIDENCE_CANONICALIZATION_MODE", "off");
      const item = suite.cases.find(item => item.id === id)!;
      const input = supportCaseInput(item);
      const semaphore = {acquire: vi.fn(async () => true), release: vi.fn()};
      const extractor = new EvidenceExtractor("benchmark-account", id, semaphore, undefined, input.store);
      return {item, ...input, semaphore, extractor};
    }

    it.each(["opposing-claims-both-survive", "cross-page-speaker-link", "partial-date-control", "assessment-fact-control"])(
      "preserves evidence through compact model responses for %s", async id => {
        vi.stubEnv("EVIDENCE_PROMPT_COMPACTION", "on");
        const run = replay(id);
        agentMocks.createAgent.mockImplementation(({systemPrompt,responseFormat}) => ({invoke: vi.fn(async ({messages}) => {
          expect(systemPrompt).toContain("RESPONSE CONTRACT");
          expect(systemPrompt).toContain(EVIDENCE_FIELD_SUPPORT_INSTRUCTIONS);
          const schema = Array.isArray(responseFormat) ? responseFormat[0].schema : responseFormat.schema;
          const json = schema?._def ? toJsonSchema(schema) : schema;
          expect(JSON.stringify(json)).not.toContain('"$ref"');
          const candidates = JSON.parse(messages[0].content).candidates;
          return {structuredResponse:{decisions:candidates.map((candidate:any)=>({candidateId:candidate.candidateId,action:"keep"}))}};
        })}));
        const documents = await run.extractor.generateDocuments(run.document);
        expect(gradeSupportCase(run.item,{caseId:run.item.id,documents,
          availableEvidenceIds:run.item.evidence.map(unit=>unit.id)}).passed).toBe(true);
        expect(run.semaphore.release).toHaveBeenCalledTimes(run.semaphore.acquire.mock.calls.length);
      });

    it("applies compact corrections through full validation without adding a date to an undated occurrence", async () => {
      vi.stubEnv("EVIDENCE_PROMPT_COMPACTION", "on");
      const run = replay("unrelated-date-on-consent");
      agentMocks.createAgent.mockImplementation(()=>({invoke:vi.fn(async ({messages})=>({structuredResponse:{
        decisions:JSON.parse(messages[0].content).candidates.map((candidate:any)=>({candidateId:candidate.candidateId,
          action:"correct",reason:"Assessment date does not establish consent date",corrections:[
            {field:"whenStartedYear",value:null},{field:"whenStartedMonth",value:null},{field:"whenStartedDay",value:null},
            {field:"supportingQuotes",value:[{pageNumber:1,quote:"The date of consent was not recorded."}]},
          ]})),
      }}))}));
      const documents = await run.extractor.generateDocuments(run.document);
      expect(documents).toHaveLength(1);
      expect(documents[0].metadata.whenStarted.year).toBeNull();
      expect(gradeSupportCase(run.item,{caseId:run.item.id,documents,
        availableEvidenceIds:run.item.evidence.map(unit=>unit.id)}).passed).toBe(true);
    });

    it("applies field corrections while retaining an occurrence whose supplied date was unsupported", async () => {
      const run = replay("unrelated-date-on-consent");
      agentMocks.createAgent.mockImplementation(({systemPrompt}) => ({invoke: vi.fn(async ({messages}) => {
        expect(systemPrompt).toContain(EVIDENCE_FIELD_SUPPORT_INSTRUCTIONS);
        const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        return {structuredResponse: {decisions: candidates.map((candidate: any) => ({...unchanged(candidate.candidateId),
          keepOriginal: false, reason: "The assessment date does not establish the consent date.",
          corrections: [correction("whenStartedYear"), correction("whenStartedMonth"), correction("whenStartedDay"),
            correction("supportingQuotes", {supportingQuotes: [{pageNumber: 1, quote: "The date of consent was not recorded."}]})],
        }))}};
      })}));
      const documents = await run.extractor.generateDocuments(run.document);
      expect(documents).toHaveLength(1);
      expect(documents[0].metadata.whenStarted.year).toBeNull();
      expect(documents[0].metadata.what).toBe("The parents consented to the evaluation.");
      expect(gradeSupportCase(run.item, {caseId: run.item.id, documents,
        availableEvidenceIds: run.item.evidence.map(unit => unit.id)}).passed).toBe(true);
      expect(run.semaphore.release).toHaveBeenCalledTimes(run.semaphore.acquire.mock.calls.length);
    });

    it.each(["opposing-claims-both-survive", "cross-page-speaker-link", "partial-date-control", "assessment-fact-control"])(
      "preserves supported fields and sufficient citations for %s", async id => {
        const run = replay(id);
        agentMocks.createAgent.mockImplementation(({systemPrompt}) => ({invoke: vi.fn(async ({messages}) => {
          expect(systemPrompt).toContain(EVIDENCE_FIELD_SUPPORT_INSTRUCTIONS);
          const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
          return {structuredResponse: {decisions: candidates.map((candidate: any) => unchanged(candidate.candidateId))}};
        })}));
        const documents = await run.extractor.generateDocuments(run.document);
        expect(gradeSupportCase(run.item, {caseId: run.item.id, documents,
          availableEvidenceIds: run.item.evidence.map(unit => unit.id)}).passed).toBe(true);
        expect(run.semaphore.release).toHaveBeenCalledTimes(run.semaphore.acquire.mock.calls.length);
      });

    it("keeps the reported speaker when correcting attribution from the report author", async () => {
      const run = replay("parent-versus-report-author");
      agentMocks.createAgent.mockImplementation(() => ({invoke: vi.fn(async ({messages}) => {
        const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        return {structuredResponse: {decisions: candidates.map((candidate: any) => ({...unchanged(candidate.candidateId),
          keepOriginal: false, reason: "Morgan is the reported speaker; Reed is the report author.",
          corrections: [correction("claimant", {text: "Morgan"})],
        }))}};
      })}));
      const documents = await run.extractor.generateDocuments(run.document);
      expect(documents[0].metadata.claimant).toBe("Morgan");
      expect(gradeSupportCase(run.item, {caseId: run.item.id, documents,
        availableEvidenceIds: run.item.evidence.map(unit => unit.id)}).passed).toBe(true);
      expect(run.semaphore.release).toHaveBeenCalledTimes(run.semaphore.acquire.mock.calls.length);
    });

    it("preserves a recommendation as a claim when a reviewer corrects a nonexistent treatment event", async () => {
      const run = replay("recommendation-is-not-treatment");
      agentMocks.createAgent.mockImplementation(() => ({invoke: vi.fn(async ({messages}) => {
        const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        return {structuredResponse: {decisions: candidates.map((candidate: any) => ({...unchanged(candidate.candidateId),
          keepOriginal: false, reason: "Therapy was recommended; treatment had not begun.",
          claims: [claim({statement: "Dr. Sam Reed recommended that Jordan begin therapy.", claimant: "Dr. Sam Reed",
            claimType: "opinion", who: ["Jordan"], whenStartedYear: null, whenStartedMonth: null, whenStartedDay: null,
            sourceQuote: candidate.item.sourceQuote})],
        }))}};
      })}));
      const documents = await run.extractor.generateDocuments(run.document);
      expect(documents).toHaveLength(1);
      expect(documents[0].metadata.tags).toContain("claim");
      expect(documents[0].metadata.tags).not.toContain("event");
      expect(gradeSupportCase(run.item, {caseId: run.item.id, documents,
        availableEvidenceIds: run.item.evidence.map(unit => unit.id)}).passed).toBe(true);
      expect(run.semaphore.release).toHaveBeenCalledTimes(run.semaphore.acquire.mock.calls.length);
    });

    it.each(["schema", "source-support", "citation", "date-format"])("classifies %s issues and releases permits on failure", async category => {
      const run = replay("dated-occurrence-control");
      vi.mocked(telemetryClient!.trackEvent).mockClear();
      agentMocks.createAgent.mockImplementation(() => ({invoke: vi.fn(async ({messages}) => {
        const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        return {structuredResponse: {decisions: candidates.map((candidate: any) => category === "schema"
          ? {candidateId: candidate.candidateId} : category === "source-support"
            ? {...unchanged(candidate.candidateId), verdict: "unresolved", keepOriginal: false, reason: "Core support remains indeterminate."}
            : {...unchanged(candidate.candidateId), keepOriginal: false, reason: "Broken proposed quotation.",
              corrections: category === "date-format" ? [correction("whenStartedMonth", {text: "2"}), correction("whenStartedDay", {text: "31"})]
                : [correction("sourceQuote", {text: "A sentence absent from this source."})]})}};
      })}));
      await expect(run.extractor.generateDocuments(run.document)).rejects.toThrow();
      expect(telemetryClient!.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
        name: "evidenceExtractor.reviewIssue", properties: expect.objectContaining({category, stage: "reconciliation"}),
      }));
      expect(run.semaphore.release).toHaveBeenCalledTimes(run.semaphore.acquire.mock.calls.length);
    });

    it("observes a missing context page without treating it as proof that the candidate is false", async () => {
      const run = replay("dated-occurrence-control");
      vi.mocked(telemetryClient!.trackEvent).mockClear();
      agentMocks.createAgent.mockImplementation(({tools}) => ({invoke: vi.fn(async ({messages}) => {
        await tools.find((tool: any) => tool.name === "read_source_page").invoke({pageNumber: 99, startOffset: 0});
        const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        return {structuredResponse: {decisions: candidates.map((candidate: any) => unchanged(candidate.candidateId))}};
      })}));
      expect(await run.extractor.generateDocuments(run.document)).toHaveLength(1);
      expect(telemetryClient!.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
        name: "evidenceExtractor.sourceContextAccess", properties: expect.objectContaining({outcome: "invalid-location"}),
      }));
      expect(run.semaphore.release).toHaveBeenCalledTimes(run.semaphore.acquire.mock.calls.length);
    });
  });

  function setupCorrections(original: EventExtractionResponse | FactExtractionResponse | ClaimExtractionResponse,
    kind: "event" | "fact" | "claim", corrections: unknown[]) {
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({ invoke: vi.fn(async () => {
      if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) return { structuredResponse: { decisions: [{
        candidateId: "1:0:candidate-0", verdict: "supported", keepOriginal: false, reason: "Source-backed field correction",
        corrections, events: [], facts: [], claims: [],
      }] } };
      return { structuredResponse: systemPrompt.includes("INDEPENDENT EXTRACTOR:") ? { events: [], facts: [], claims: [] }
        : systemPrompt.includes("EVENT WORKER:") ? { events: kind === "event" ? [original] : [] }
        : systemPrompt.includes("FACT WORKER:") ? { facts: kind === "fact" ? [original] : [] }
        : { claims: kind === "claim" ? [original] : [] } };
    }) }));
    return makeExtractor();
  }

  it("applies compact event category and date corrections without losing other fields or citations", async () => {
    const original = event({ sourceQuote: source.pageContent });
    const { extractor, semaphore } = setupCorrections(original, "event", [
      correction("eventType", { text: "communication" }), correction("whenEndedYear"),
      correction("facets", { facets: [{ namespace: "communication", value: "writtenNotice" }] }),
    ]);
    const [doc] = await extractor.generateDocuments(source);
    expect(doc.metadata).toMatchObject({ what: original.what, who: original.who, where: original.where,
      why: original.why, sourceQuote: original.sourceQuote, whenStarted: { year: "2020" }, whenEnded: { year: null } });
    expect(doc.metadata.tags).toContain("eventType:communication");
    expect(doc.metadata.sourceSpans).toEqual([{pageNumber: 1, sourceOffset: 0, sourceQuote: source.pageContent}]);
    expect(semaphore.acquire).toHaveBeenCalledTimes(5);
    expect(semaphore.release).toHaveBeenCalledTimes(5);
  });

  it("preserves claim polarity and qualifiers while correcting attribution and adding its supporting quote", async () => {
    const document = new Document({ pageContent: source.pageContent + "<!-- PageBreak -->Author: Jane.", metadata: { pages: [1, 2] } });
    const original = claim({ statement: "John may have stolen the vehicle.", polarity: "uncertain",
      claimant: "Unknown", sourceQuote: source.pageContent });
    const { extractor } = setupCorrections(original, "claim", [correction("claimant", { text: "Jane" }),
      correction("supportingQuotes", { supportingQuotes: [{pageNumber: 2, quote: "Author: Jane."}] })]);
    // Exercise the real review path for the first window without extracting unrelated page 2 evidence.
    const result = await (extractor as any).extractWindow(new EvidenceSource(document), new EvidenceSource(document).windows()[0]);
    expect(result.claims[0].item).toMatchObject({ ...original, claimant: "Jane",
      supportingQuotes: [{pageNumber: 2, quote: "Author: Jane."}] });
    expect(result.claims[0].sourceSpans).toHaveLength(2);
  });

  it("keeps assessment values intact while correcting a fact's subject", async () => {
    const original = staticFact({sourceQuote: source.pageContent});
    const { extractor } = setupCorrections(original, "fact", [correction("subject", {people: ["Casey"]})]);
    const [doc] = await extractor.generateDocuments(source);
    expect(doc.metadata).toMatchObject({what: original.what, subject: ["Casey"], reportedBy: original.reportedBy,
      factType: original.factType, sourceQuote: original.sourceQuote});
  });

  it.each([
    [[correction("eventType", {text: "email"})]],
    [[correction("claimant", {text: "Jane"})]],
    [[correction("where", {text: "Here"}), correction("where", {text: "There"})]],
    [[correction("where", {text: "Here", people: ["Unexpected"]})]],
    [[correction("sourceQuote")]],
    [[correction("whenStartedDay", {text: "35"})]],
  ])("rejects invalid field corrections and releases permits: %j", async (corrections) => {
    const {extractor, semaphore} = setupCorrections(event({sourceQuote: source.pageContent}), "event", corrections);
    await expect(extractor.generateDocuments(source)).rejects.toThrow();
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it("repairs a compact correction whose quote does not resolve, instead of indexing it", async () => {
    const {extractor, semaphore} = setupCorrections(event({sourceQuote: source.pageContent}), "event",
      [correction("sourceQuote", {text: "Not in the document"})]);
    await expect(extractor.generateDocuments(source)).rejects.toThrow("Unresolved evidence");
    expect(semaphore.release).toHaveBeenCalledTimes(6);
  });

  function stageStore() {
    const records = new Map<string, any>();
    const windows = new Map<string, unknown>();
    const key = (identity: {runFingerprint: string}, index: number, stage = "") => `${identity.runFingerprint}/${index}/${stage}`;
    const store: EvidenceCheckpointStore = {
      get: vi.fn(async (identity, index) => windows.get(key(identity, index)) ?? null),
      put: vi.fn(async (identity, index, value) => { windows.set(key(identity, index), structuredClone(value)); }),
      getStage: vi.fn(async (identity, index, stage) => records.get(key(identity, index, stage)) ?? null),
      putStage: vi.fn(async (identity, index, stage, value) => { records.set(key(identity, index, stage), structuredClone(value)); }),
      clearSource: vi.fn(async () => {}), clearAccount: vi.fn(async () => {}),
    };
    return {store, records, windows};
  }

  it("routes queued reconciliation repairs to the configured fallback model", async () => {
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "tasks-claude-haiku-5-5");
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "fast-tasks-model-router");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "configured");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK_DEPLOYMENT_NAME", "utility-model-router");
    const {extractor} = makeExtractor(stageStore().store);
    const evidenceSource = new EvidenceSource(source);
    const identity = await (extractor as any).checkpointIdentity(evidenceSource);
    const review = vi.spyOn((extractor as any).reviewer, "reviewBatchesWithFallback")
      .mockResolvedValue({events:[],facts:[],claims:[]});
    const task = {version:1 as const, component:"support-repair" as const,
      context:{identity,windowIndex:0},batchId:"routing",candidates:[],sourceArtifact:"artifact",
      initialReviewer:"reconciliation" as const,allowFailover:true};

    await extractor.executeReviewTask(task, evidenceSource, false);
    expect(review.mock.calls.at(-1)?.[4].deployment).toBe("fast-tasks-model-router");
    await extractor.executeReviewTask({...task,initialReviewer:"fallback"}, evidenceSource, false);
    expect(review.mock.calls.at(-1)?.[4].deployment).toBe("utility-model-router");
    await extractor.executeReviewTask(task, evidenceSource, true);
    expect(review.mock.calls.at(-1)?.[4].deployment).toBe("utility-model-router");
  });

  it("uses configured Sonnet rescue after a content-filter refusal without calling the utility router", async () => {
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "tasks-claude-haiku-5-5");
    vi.stubEnv("EVIDENCE_RECONCILIATION_RESCUE_DEPLOYMENT_NAME", "research-claude-sonnet-5-5");
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "fast-tasks-model-router");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "configured");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK_DEPLOYMENT_NAME", "utility-model-router");
    const {extractor} = makeExtractor();
    const evidenceSource = new EvidenceSource(source);
    const models: string[] = [];
    const filtered = Object.assign(new Error("filtered"), {status:400, code:"content_filter"});
    const result = await (extractor as any).reviewer.reconciliationComponent("source-support:0", [], evidenceSource,
      evidenceSource.windows()[0], "filtered", (extractor as any).reconciliationModel, true, undefined,
      async (reviewer: {deployment:string}) => {
        models.push(reviewer.deployment);
        if (reviewer.deployment !== "research-claude-sonnet-5-5") throw filtered;
        return "accepted";
      });
    expect(result).toBe("accepted");
    expect(models).toEqual(["fast-tasks-model-router", "research-claude-sonnet-5-5"]);
  });

  it("rescues a filtered queued utility review with Sonnet", async () => {
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "tasks-claude-haiku-5-5");
    vi.stubEnv("EVIDENCE_RECONCILIATION_RESCUE_DEPLOYMENT_NAME", "research-claude-sonnet-5-5");
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "fast-tasks-model-router");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "configured");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK_DEPLOYMENT_NAME", "utility-model-router");
    const {extractor} = makeExtractor(stageStore().store);
    const evidenceSource = new EvidenceSource(source);
    const identity = await (extractor as any).checkpointIdentity(evidenceSource);
    const models: string[] = [];
    vi.spyOn((extractor as any).reviewer, "reviewBatchesWithFallback").mockImplementation(async (
      _candidates: unknown, _source: unknown, _window: unknown, _id: unknown, reviewer: {deployment:string}) => {
      models.push(reviewer.deployment);
      if (reviewer.deployment === "utility-model-router")
        throw Object.assign(new Error("filtered"), {status:400, code:"content_filter"});
      return {events:[],facts:[],claims:[]};
    });
    const task = {version:1 as const, component:"support-repair" as const,
      context:{identity,windowIndex:0},batchId:"filtered-review",candidates:[],sourceArtifact:"artifact",
      initialReviewer:"fallback" as const,allowFailover:true};
    await extractor.executeReviewTask(task, evidenceSource, false);
    expect(models).toEqual(["utility-model-router", "research-claude-sonnet-5-5"]);
  });

  it.each(["support-repair", "classification"] as const)(
    "asks Sonnet to resolve %s entries left unresolved by the queued utility repair", async component => {
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "tasks-claude-haiku-5-5");
    vi.stubEnv("EVIDENCE_RECONCILIATION_RESCUE_DEPLOYMENT_NAME", "research-claude-sonnet-5-5");
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "fast-tasks-model-router");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "configured");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK_DEPLOYMENT_NAME", "utility-model-router");
    const {extractor} = makeExtractor(stageStore().store);
    const evidenceSource = new EvidenceSource(source);
    const identity = await (extractor as any).checkpointIdentity(evidenceSource);
    const models: string[] = [];
    const omissions: boolean[] = [];
    vi.spyOn((extractor as any).reviewer, "reviewBatchesWithFallback").mockImplementation(async (
      _candidates: unknown, _source: unknown, _window: unknown, _id: unknown, reviewer: {deployment:string},
      _context: unknown, _dateReview: unknown, omitUnresolvedCitations: boolean) => {
      models.push(reviewer.deployment);
      omissions.push(omitUnresolvedCitations);
      if (reviewer.deployment === "utility-model-router") throw new EvidenceUnresolvedError(4);
      return {events:[],facts:[],claims:[]};
    });
    const task = {version:1 as const, component,
      context:{identity,windowIndex:0},batchId:"unresolved-review",candidates:[],sourceArtifact:"artifact",
      initialReviewer:"fallback" as const,allowFailover:true};
    await extractor.executeReviewTask(task,evidenceSource,false);
    expect(models).toEqual(["utility-model-router", "research-claude-sonnet-5-5"]);
    expect(omissions).toEqual([false, true]);
  });

  function checkpointAgents(fail: (stage: string, candidates: any[]) => void,
    count = 1, visits = new Map<string, number>()) {
    agentMocks.createAgent.mockImplementation(({systemPrompt}) => ({invoke: vi.fn(async ({messages}) => {
      const stage = systemPrompt.includes("SOURCE SUPPORT REVIEWER:") ? "review"
        : systemPrompt.includes("INDEPENDENT EXTRACTOR:") ? "independent"
        : systemPrompt.includes("EVENT WORKER:") ? "events" : systemPrompt.includes("FACT WORKER:") ? "facts" : "claims";
      const candidates = stage === "review" ? JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]) : [];
      const visit = stage === "review" ? `review:${candidates[0]?.candidateId}` : stage;
      visits.set(visit, (visits.get(visit) || 0) + 1);
      fail(stage, candidates);
      if (stage === "review") return {structuredResponse: {decisions: candidates.map((candidate: any) => ({
        candidateId: candidate.candidateId, verdict: "supported", keepOriginal: true, corrections: [], reason: "",
        events: [], facts: [], claims: [],
      }))}};
      return {structuredResponse: stage === "events" ? {events: Array.from({length: count}, (_, index) =>
        event({what: `Occurrence ${index}`, sourceQuote: source.pageContent}))}
        : stage === "independent" ? {events: [], facts: [], claims: []} : stage === "facts" ? {facts: []} : {claims: []}};
    })}));
    return visits;
  }

  it("reuses three successful blind passes after one agent fails, without returning partial evidence", async () => {
    const {store, records, windows} = stageStore();
    let fail = true;
    const visits = checkpointAgents(stage => {if (stage === "events" && fail) throw new Error("temporary pass failure");});
    const first = makeExtractor(store);
    await expect(first.extractor.generateDocuments(source)).rejects.toThrow("temporary pass failure");
    expect(records.size).toBe(3);
    expect(windows.size).toBe(0);
    expect(first.semaphore.release).toHaveBeenCalledTimes(4);
    fail = false;
    const next = makeExtractor(store);
    await expect(next.extractor.generateDocuments(source)).resolves.toHaveLength(1);
    expect(visits.get("events")).toBe(2);
    for (const stage of ["facts", "claims", "independent"]) expect(visits.get(stage)).toBe(1);
    expect(next.semaphore.release).toHaveBeenCalledTimes(2);
    expect(windows.size).toBe(1);
  });

  it("reuses successful review batches and all four passes after a sibling batch fails", async () => {
    const {store, records, windows} = stageStore();
    let fail = true;
    const visits = checkpointAgents((stage, candidates) => {
      if (stage === "review" && candidates[0].candidateId.endsWith("candidate-16") && fail) throw new Error("review unavailable");
    }, 33);
    const first = makeExtractor(store);
    await expect(first.extractor.generateDocuments(source)).rejects.toThrow("review unavailable");
    expect(records.size).toBe(12); // Four units, four assembled passes, two decisions and two verified batches.
    expect(windows.size).toBe(0);
    expect(first.semaphore.release).toHaveBeenCalledTimes(7);
    fail = false;
    const next = makeExtractor(store);
    const docs = await next.extractor.generateDocuments(source);
    expect(docs).toHaveLength(33);
    expect(docs.map(doc => doc.metadata.what)).toEqual(Array.from({length: 33}, (_, index) => `Occurrence ${index}`));
    for (const stage of ["events", "facts", "claims", "independent"]) expect(visits.get(stage)).toBe(1);
    expect(visits.get("review:1:0:candidate-0")).toBe(1);
    expect(visits.get("review:1:0:candidate-16")).toBe(2);
    expect(visits.get("review:1:0:candidate-32")).toBe(1);
    expect(next.semaphore.release).toHaveBeenCalledTimes(1);
  });

  it.each(["value", "inputHash", "schema"])("rebuilds a damaged %s aggregate from validated unit checkpoints", async damage => {
    const {store, records, windows} = stageStore();
    const visits = checkpointAgents(() => {});
    await makeExtractor(store).extractor.generateDocuments(source);
    windows.clear();
    const saved = [...records.values()].find(record => record.stage === "primary-events");
    if (damage === "inputHash") saved.inputHash = "changed";
    else {
      saved.value.events[0].sourceQuote = damage === "schema" ? 123 : "A different quotation";
      if (damage === "schema") saved.valueHash = createHash("sha256").update(JSON.stringify(saved.value)).digest("hex");
    }
    await expect(makeExtractor(store).extractor.generateDocuments(source)).resolves.toHaveLength(1);
    expect(visits.get("events")).toBe(1);
    expect(visits.get("facts")).toBe(1);
  });

  it("revalidates restored review citations even when the stored value hash is consistent", async () => {
    const {store, records, windows} = stageStore();
    const visits = checkpointAgents(() => {});
    await makeExtractor(store).extractor.generateDocuments(source);
    windows.clear();
    const saved = [...records.values()].find(record => record.stage === "reconciliation:0");
    saved.value.events[0].sourceSpans[0].sourceOffset = 99;
    saved.valueHash = createHash("sha256").update(JSON.stringify(saved.value)).digest("hex");
    await expect(makeExtractor(store).extractor.generateDocuments(source)).resolves.toHaveLength(1);
    expect(visits.get("events")).toBe(1);
    expect(visits.get("review:1:0:candidate-0")).toBe(1); // Rebuild from the intact, revalidated decision checkpoint.
  });

  it("regenerates a review batch when regenerated pass output changes its candidates", async () => {
    const {store, records, windows} = stageStore();
    const visits = checkpointAgents(() => {});
    await makeExtractor(store).extractor.generateDocuments(source);
    windows.clear();
    const saved = [...records.values()].find(record => record.stage === "primary-events");
    saved.value.events[0].what = "A corrected occurrence";
    saved.valueHash = createHash("sha256").update(JSON.stringify(saved.value)).digest("hex");
    const docs = await makeExtractor(store).extractor.generateDocuments(source);
    expect(docs[0].metadata.what).toBe("A corrected occurrence");
    expect(visits.get("events")).toBe(1);
    expect(visits.get("review:1:0:candidate-0")).toBe(2);
  });

  it("propagates stage storage failures and waits for active passes to release their permits", async () => {
    const {store, windows} = stageStore();
    checkpointAgents(() => {});
    vi.mocked(store.putStage!).mockRejectedValue(new Error("checkpoint storage unavailable"));
    const {extractor, semaphore} = makeExtractor(store);
    await expect(extractor.generateDocuments(source)).rejects.toThrow("checkpoint storage unavailable");
    expect(windows.size).toBe(0);
    expect(semaphore.acquire).toHaveBeenCalledTimes(4);
    expect(semaphore.release).toHaveBeenCalledTimes(4);
  });

  function canonicalizationDocuments(extractor: EvidenceExtractor) {
    const sourceHash = new EvidenceSource(source).contentHash;
    const located = (what: string, extractedBy: string) => ({
      item: event({ what, sourceQuote: source.pageContent }), pageNumber: 1, sourceOffset: 0,
      sourceQuote: source.pageContent,
      sourceSpans: [{ pageNumber: 1, sourceOffset: 0, sourceQuote: source.pageContent }],
      extractedBy: [extractedBy],
    });
    return [
      (extractor as any).documentFactory.createEventDocument(located("A factual statement was recorded.", "primary:test"), source, sourceHash),
      (extractor as any).documentFactory.createEventDocument(located("A factual statement was recorded in the report.",
        "independent:test"), source, sourceHash),
    ] as Document[];
  }

  function decisionCheckpoints() {
    const saved = new Map<string, unknown>();
    const key = (identity: unknown, index: number, stage: string) => JSON.stringify([identity,index,stage]);
    const store: EvidenceCheckpointStore = {
      get:async()=>null,put:async()=>{},clearAccount:async()=>{},clearSource:async()=>{},
      getStage:async(identity,index,stage)=>structuredClone(saved.get(key(identity,index,stage)) ?? null),
      putStage:async(identity,index,stage,value)=>{saved.set(key(identity,index,stage),structuredClone(value));},
    };
    return {saved,store};
  }

  it("reviews identical candidates once and carries both extraction provenance entries into the result", async () => {
    const {extractor} = makeExtractor();
    const item = event({sourceQuote:source.pageContent});
    const candidates = [{id:"primary",kind:"event",item,extractedBy:["primary-events:model-a"]},
      {id:"independent",kind:"event",item:structuredClone(item),extractedBy:["independent:model-b"]}];
    const reviewed = vi.spyOn((extractor as any).reviewer, "reviewBatches").mockImplementation(async (items: any[]) => ({
      events:items.map(candidate=>({item:candidate.item,...new EvidenceSource(source).locate(new EvidenceSource(source).windows()[0],candidate.item.sourceQuote),
        sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:source.pageContent}],extractedBy:candidate.extractedBy})),facts:[],claims:[],
    }));
    const result = await (extractor as any).reconcileWindowCandidates(candidates,new EvidenceSource(source),new EvidenceSource(source).windows()[0]);
    expect(reviewed.mock.calls[0][0]).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].extractedBy).toEqual(["primary-events:model-a","independent:model-b"]);
    expect(result.events[0].sourceSpans).toEqual([{pageNumber:1,sourceOffset:0,sourceQuote:source.pageContent}]);
  });

  it("restores validated canonicalization decisions after restart without another model invocation", async () => {
    const {saved,store} = decisionCheckpoints();
    agentMocks.createAgent.mockReturnValue({invoke:vi.fn().mockResolvedValue({structuredResponse:{decisions:[{
      pairId:"0:1",relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:["in the report"],reason:"Same recorded statement.",
    }]}})});
    const first = makeExtractor(store).extractor;
    const documents = canonicalizationDocuments(first);
    const expected = await first.canonicalizeDocuments(documents,source);
    expect(expected.documents).toHaveLength(1);
    expect(saved.size).toBe(1);
    agentMocks.createAgent.mockClear();
    expect(await makeExtractor(store).extractor.canonicalizeDocuments(documents,source)).toEqual(expected);
    expect(agentMocks.createAgent).not.toHaveBeenCalled();
  });

  it("executes canonicalization on a separate review worker and checks source/configuration before reviewing", async () => {
    const {store} = decisionCheckpoints();
    const h = evidenceTaskHarness();
    const invoke = vi.fn().mockResolvedValue({structuredResponse:{decisions:[{
      pairId:"0:1",relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:["in the report"],reason:"Same recorded statement.",
    }]}});
    agentMocks.createAgent.mockReturnValue({invoke});
    const first = makeExtractor(store).extractor;
    const documents = canonicalizationDocuments(first);
    const run = () => withEvidenceReviewDispatcher(h.queue.dispatcher({accountId:"account-1",sourceId:"source-1",jobId:"job"}),
      () => makeExtractor(store).extractor.canonicalizeDocuments(documents,source));
    await expect(run()).rejects.toBeInstanceOf(EvidenceReviewPending);
    expect(invoke).not.toHaveBeenCalled();
    const [id, record] = [...h.records.entries()][0];
    const task = record.definition.payload as EvidenceReviewTask;
    const worker = makeExtractor(store).extractor;
    await expect(worker.executeReviewTask({...task,context:{...task.context,identity:{...task.context.identity,runFingerprint:"stale"}}},source,false))
      .rejects.toThrow("does not match this source/configuration/implementation");
    await expect(worker.executeReviewTask(task,source,true)).rejects.toThrow("Canonicalization requires its document review task");
    expect(invoke).not.toHaveBeenCalled();
    await h.queue.process(id,"review",()=>worker.executeReviewTask(task,source,false));
    expect(h.records.get(id)?.status).toBe("completed");
    const result = await run();
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.what).toBe("A factual statement was recorded in the report.");
    expect(result.documents[0].metadata.extractedBy).toEqual(expect.arrayContaining(["primary:test","independent:test"]));
    expect(invoke).toHaveBeenCalledOnce();
    expect(await run()).toEqual(result);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("uses the injected source lookup for canonicalization and invalidates decisions when its snapshot changes", async () => {
    const {store} = decisionCheckpoints();
    agentMocks.createAgent.mockReturnValue({invoke: vi.fn().mockResolvedValue({structuredResponse: {decisions: [{
      pairId: "0:1", relation: "same_assertion", leftOnlyDetails: [], rightOnlyDetails: ["in the report"], reason: "Same recorded statement.",
    }]}})});
    const lookup = {fingerprint: "snapshot-1", search: vi.fn(async () => ({passages: []})), verify: vi.fn(async () => {})};
    const make = () => {
      const extractor = makeExtractor(store).extractor;
      Object.assign(extractor, {sourceLookupFactory: async () => lookup});
      return extractor;
    };
    const documents = canonicalizationDocuments(make());
    await make().canonicalizeDocuments(documents, source, {sourceContext: "prefetch"});
    expect(lookup.search).toHaveBeenCalledTimes(2);
    expect(agentMocks.createAgent.mock.calls.at(-1)![0].tools.map(tool => tool.name)).toEqual(["read_source_page", "search_source_context"]);
    expect(lookup.verify).toHaveBeenCalled();
    agentMocks.createAgent.mockClear(); lookup.search.mockClear();
    await make().canonicalizeDocuments(documents, source, {sourceContext: "prefetch"});
    expect(agentMocks.createAgent).not.toHaveBeenCalled(); expect(lookup.search).not.toHaveBeenCalled();
    lookup.fingerprint = "snapshot-2";
    await make().canonicalizeDocuments(documents, source, {sourceContext: "prefetch"});
    expect(agentMocks.createAgent).toHaveBeenCalledOnce(); expect(lookup.search).toHaveBeenCalledTimes(2);
  });

  it.each([
    {provider: "openai", invocation: 1}, {provider: "openai", invocation: 2},
    {provider: "anthropic", invocation: 1}, {provider: "anthropic", invocation: 2},
  ])("stops $provider review after a swallowed source tool error on invocation $invocation without checkpointing", async ({provider, invocation}) => {
    const {store, saved} = decisionCheckpoints(), {extractor} = makeExtractor(store);
    Object.assign(extractor, {reconciliationModel: {...(extractor as any).reconciliationModel, provider},
      sourceLookupFactory: async () => ({fingerprint: "snapshot", verify: async () => {},
      search: async () => {throw new Error("Search unavailable");}})});
    let calls = 0;
    agentMocks.createAgent.mockImplementation(options => ({invoke: async () => {
      if (++calls < invocation) return {messages: [], structuredResponse: undefined};
      const tool = options.tools.find(tool => tool.name === "search_source_context");
      try {await tool.invoke({pageNumber: 1, query: "recorded statement", purpose: "review"});} catch { /* A model framework may return tool failures as messages. */ }
      return {structuredResponse: {decisions: [{pairId: "0:1", relation: "same_assertion", leftOnlyDetails: [],
        rightOnlyDetails: ["in the report"], reason: "Same recorded statement."}]}};
    }}));
    await expect(extractor.canonicalizeDocuments(canonicalizationDocuments(extractor), source)).rejects.toThrow("Source-context lookup failed");
    expect(agentMocks.createAgent).toHaveBeenCalledTimes(invocation); expect(saved.size).toBe(0);
  });

  it("uses injected embeddings for review and preserves semantic assessment through checkpoint replay", async () => {
    const {store} = decisionCheckpoints();
    const vectors = vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 0]));
    const assessment = {relationship: "right_entails_left", contextualDetails: []};
    agentMocks.createAgent.mockReturnValue({invoke:vi.fn().mockResolvedValue({structuredResponse:{decisions:[{
      pairId:"0:1",relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:["in the report"],
      reason:"Same recorded statement.",semanticAssessment:assessment,
    }]}})});
    const extractor = makeExtractor(store).extractor;
    Object.assign(extractor, {duplicateEmbeddings: {vectors}});
    const documents = canonicalizationDocuments(extractor);
    const result = await extractor.canonicalizeDocuments(documents, source);
    expect(vectors).toHaveBeenCalledWith(documents.map(document => document.metadata.what));
    expect(result.documents).toHaveLength(1);
    expect(result.pairs[0].matchReasons).toContain("embedding");
    expect(result.decisions[0].semanticAssessment).toEqual(assessment);
    agentMocks.createAgent.mockClear();
    expect(await extractor.canonicalizeDocuments(documents, source)).toEqual(result);
    expect(agentMocks.createAgent).not.toHaveBeenCalled();
  });

  it("reviews Search leads without new embeddings and reuses validated decisions after restart", async () => {
    const {store} = decisionCheckpoints();
    agentMocks.createAgent.mockReturnValue({invoke:vi.fn().mockResolvedValue({structuredResponse:{decisions:[{
      pairId:"0:1",relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:["in the report"],reason:"Same recorded statement.",
    }]}})});
    const extractor = makeExtractor(store).extractor;
    const vectors = vi.fn(async () => { throw new Error("Search review must not request embeddings"); });
    Object.assign(extractor, {duplicateEmbeddings:{vectors}, promptCompaction:"on"});
    const documents = canonicalizationDocuments(extractor);
    const options = {retrieval:{searchPairs:[{leftIndex:0,rightIndex:1}]}};
    const result = await extractor.canonicalizeDocuments(documents, source, options);
    expect(result.documents).toHaveLength(1);
    expect(result.pairs[0].matchReasons).toContain("search");
    expect(vectors).not.toHaveBeenCalled();
    agentMocks.createAgent.mockClear();
    const restarted = makeExtractor(store).extractor;
    Object.assign(restarted, {promptCompaction:"on"});
    expect(await restarted.canonicalizeDocuments(documents, source, options)).toEqual(result);
    expect(agentMocks.createAgent).not.toHaveBeenCalled();
  });

  it("does not review or remove evidence after an embedding spending stop", async () => {
    const extractor = makeExtractor().extractor;
    const error = new EvidenceBudgetError("evidence_budget_exhausted", "budget stop");
    Object.assign(extractor, {duplicateEmbeddings: {vectors: vi.fn().mockRejectedValue(error)}});
    agentMocks.createAgent.mockClear();
    await expect(extractor.canonicalizeDocuments(canonicalizationDocuments(extractor), source)).rejects.toBe(error);
    expect(agentMocks.createAgent).not.toHaveBeenCalled();
  });

  it.each(["provider unavailable", "Invalid evidence embedding response", "storage unavailable", "Invalid URL"])(
    "uses lexical review when duplicate embeddings fail: %s", async message => {
      const extractor = makeExtractor().extractor;
      Object.assign(extractor, {duplicateEmbeddings: {vectors: vi.fn().mockRejectedValue(new Error(message))}});
      agentMocks.createAgent.mockReturnValue({invoke: vi.fn().mockResolvedValue({structuredResponse: {decisions: [{
        pairId: "0:1", relation: "independent_assertions", leftOnlyDetails: [], rightOnlyDetails: [], reason: "Keep both.",
      }]}})});
      const result = await extractor.canonicalizeDocuments(canonicalizationDocuments(extractor), source);
      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0].matchReasons).not.toContain("embedding");
      expect(result.documents).toHaveLength(2);
      expect(agentMocks.createAgent).toHaveBeenCalledOnce();
      expect(telemetryClient.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
        name: "evidenceExtractor.canonicalizationEmbeddingFallback",
      }));
    });

  it("falls back to lexical review when duplicate vector dimensions differ", async () => {
    const extractor = makeExtractor().extractor;
    Object.assign(extractor, {duplicateEmbeddings: {vectors: vi.fn().mockResolvedValue([[1], [1, 0]])}});
    agentMocks.createAgent.mockReturnValue({invoke: vi.fn().mockResolvedValue({structuredResponse: {decisions: [{
      pairId: "0:1", relation: "independent_assertions", leftOnlyDetails: [], rightOnlyDetails: [], reason: "Keep both.",
    }]}})});
    const result = await extractor.canonicalizeDocuments(canonicalizationDocuments(extractor), source);
    expect(result.documents).toHaveLength(2);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].matchReasons).not.toContain("embedding");
  });

  it("propagates duplicate embedding cancellation", async () => {
    const extractor = makeExtractor().extractor;
    const error = new DOMException("Cancelled", "AbortError");
    Object.assign(extractor, {duplicateEmbeddings: {vectors: vi.fn().mockRejectedValue(error)}});
    await expect(extractor.canonicalizeDocuments(canonicalizationDocuments(extractor), source)).rejects.toBe(error);
    expect(agentMocks.createAgent).not.toHaveBeenCalled();
  });

  it("does not retry paid canonicalization reviews when saving a valid decision fails", async () => {
    const {store} = decisionCheckpoints();
    store.putStage = async()=>{throw new Error("storage unavailable");};
    agentMocks.createAgent.mockReturnValue({invoke:vi.fn().mockResolvedValue({structuredResponse:{decisions:[{
      pairId:"0:1",relation:"independent_assertions",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Distinct statements.",
    }]}})});
    const first = makeExtractor(store).extractor;
    await expect(first.canonicalizeDocuments(canonicalizationDocuments(first),source)).rejects.toThrow("storage unavailable");
    expect(agentMocks.createAgent).toHaveBeenCalledOnce();
  });
  it("does not split or swallow a canonicalization spending stop",async()=>{
    const {store}=decisionCheckpoints();
    const error=new EvidenceBudgetError("evidence_budget_exhausted","budget stop");
    agentMocks.createAgent.mockReturnValue({invoke:vi.fn().mockRejectedValue(error)});
    const extractor=makeExtractor(store).extractor;
    await expect(extractor.canonicalizeDocuments(repeatedCanonicalizationDocuments(extractor,4),source)).rejects.toBe(error);
    expect(agentMocks.createAgent).toHaveBeenCalledOnce();
  });

  function repeatedCanonicalizationDocuments(extractor: EvidenceExtractor, count: number) {
    const [document] = canonicalizationDocuments(extractor);
    return Array.from({length:count},()=>new Document({pageContent:document.pageContent,
      metadata:structuredClone(document.metadata)}));
  }

  function canonicalizationResponse(pairs: {pairId:string}[], invalid = false) {
    return {structuredResponse:{decisions:pairs.map(pair=>({pairId:pair.pairId,
      relation:"independent_assertions",leftOnlyDetails:[],rightOnlyDetails:[],reason:invalid?"":"Distinct assertions."}))}};
  }

  it("stops queued canonicalization batches and repairs, draining active reviews and uploads on storage failure", async () => {
    const {store} = decisionCheckpoints();
    const storageError = new Error("canonicalization upload failed");
    const upload = Promise.withResolvers<void>();
    let nextWrite = 0;
    store.putStage = vi.fn(async()=>{
      const index = nextWrite++;
      if (index === 0) throw storageError;
      if (index === 1) await upload.promise;
    });
    const reviews: {pairs:{pairId:string}[];result:ReturnType<typeof Promise.withResolvers<any>>}[] = [];
    agentMocks.createAgent.mockImplementation(()=>({invoke:async({messages}:any)=>{
      const review = {pairs:JSON.parse(messages[0].content).pairs,result:Promise.withResolvers<any>()};
      reviews.push(review);
      return review.result.promise;
    }}));
    const {extractor,semaphore} = makeExtractor(store);
    let settled = false;
    // 78 pairs fill four active batches and leave one batch queued.
    const running = extractor.canonicalizeDocuments(repeatedCanonicalizationDocuments(extractor,13),source)
      .catch(error=>{settled=true;return error;});
    await vi.waitFor(()=>expect(reviews).toHaveLength(4));
    expect(reviews.every(review=>review.pairs.length===16)).toBe(true);
    reviews[0].result.resolve(canonicalizationResponse(reviews[0].pairs));
    await vi.waitFor(()=>expect(store.putStage).toHaveBeenCalledTimes(16));
    expect(settled).toBe(false);
    // Neither invalid decisions nor a failed model response may schedule repairs
    // once another worker has reported the storage failure.
    reviews[1].result.resolve(canonicalizationResponse(reviews[1].pairs,true));
    reviews[2].result.reject(new Error("model unavailable"));
    reviews[3].result.resolve(canonicalizationResponse(reviews[3].pairs));
    await vi.waitFor(()=>expect(semaphore.release).toHaveBeenCalledTimes(4));
    expect(settled).toBe(false);
    expect(agentMocks.createAgent).toHaveBeenCalledTimes(4);
    upload.resolve();
    expect(await running).toBe(storageError);
    expect(agentMocks.createAgent).toHaveBeenCalledTimes(4);
    expect(store.putStage).toHaveBeenCalledTimes(32);
  });

  it.each(["batch fallback","pair repair"])("drains recursive %s reviews before propagating a checkpoint failure", async mode => {
    const {store} = decisionCheckpoints();
    const storageError = new Error("recursive checkpoint upload failed");
    store.putStage = vi.fn().mockRejectedValueOnce(storageError).mockResolvedValue(undefined);
    const reviews: {pairs:{pairId:string}[];result:ReturnType<typeof Promise.withResolvers<any>>}[] = [];
    let first = true;
    agentMocks.createAgent.mockImplementation(()=>({invoke:async({messages}:any)=>{
      const pairs = JSON.parse(messages[0].content).pairs;
      if (first) {
        first = false;
        if (mode === "batch fallback") throw new Error("model unavailable");
        return canonicalizationResponse(pairs,true);
      }
      const review = {pairs,result:Promise.withResolvers<any>()};
      reviews.push(review);
      return review.result.promise;
    }}));
    const {extractor,semaphore} = makeExtractor(store);
    let settled = false;
    // Six pairs create two bounded repair groups (or two parse-fallback groups).
    const running = extractor.canonicalizeDocuments(repeatedCanonicalizationDocuments(extractor,4),source)
      .catch(error=>{settled=true;return error;});
    await vi.waitFor(()=>expect(reviews).toHaveLength(2));
    reviews[0].result.resolve(canonicalizationResponse(reviews[0].pairs));
    await vi.waitFor(()=>expect(store.putStage).toHaveBeenCalled());
    expect(settled).toBe(false);
    reviews.slice(1).forEach(review=>review.result.resolve(canonicalizationResponse(review.pairs)));
    expect(await running).toBe(storageError);
    expect(semaphore.release).toHaveBeenCalledTimes(reviews.length+1);
    expect(agentMocks.createAgent).toHaveBeenCalledTimes(reviews.length+1);
  });

  it("drains checkpoint reads and starts no model reviews after a read failure", async () => {
    const {store} = decisionCheckpoints();
    const storageError = new Error("checkpoint read failed");
    const read = Promise.withResolvers<null>();
    store.getStage = vi.fn().mockRejectedValueOnce(storageError).mockReturnValueOnce(read.promise).mockResolvedValue(null);
    const {extractor} = makeExtractor(store);
    let settled = false;
    const running = extractor.canonicalizeDocuments(repeatedCanonicalizationDocuments(extractor,3),source)
      .catch(error=>{settled=true;return error;});
    await vi.waitFor(()=>expect(store.getStage).toHaveBeenCalledTimes(3));
    expect(settled).toBe(false);
    expect(agentMocks.createAgent).not.toHaveBeenCalled();
    read.resolve(null);
    expect(await running).toBe(storageError);
    expect(agentMocks.createAgent).not.toHaveBeenCalled();
  });

  it("revalidates damaged canonicalization output and preserves valid sibling decisions on retry", async () => {
    const {store} = decisionCheckpoints();
    let fail = true;
    const requested: string[][] = [];
    agentMocks.createAgent.mockImplementation(() => ({invoke:async ({messages}: any) => {
      const pairs = JSON.parse(messages[0].content).pairs;
      requested.push(pairs.map((pair:any)=>pair.pairId));
      return {structuredResponse:{decisions:pairs.map((pair:any)=>({pairId:pair.pairId,
        relation:"independent_assertions",leftOnlyDetails:[],rightOnlyDetails:[],reason:fail && pair.pairId==="0:2"?"":"Distinct assertions."}))}};
    }}));
    const first = makeExtractor(store).extractor;
    const documents = canonicalizationDocuments(first);
    const extra = new Document({pageContent:documents[1].pageContent,metadata:{...documents[1].metadata,what:"A factual statement was recorded in the report today."}});
    documents.push(extra);
    const incomplete = await first.canonicalizeDocuments(documents,source);
    expect(incomplete.failedPairIds).toEqual(["0:2"]);
    fail = false; requested.length = 0;
    const completed = await makeExtractor(store).extractor.canonicalizeDocuments(documents,source);
    expect(completed.failedPairIds).toEqual([]);
    expect(requested).toEqual([["0:2"]]);
    expect(completed.documents).toEqual(documents);
  });

  it.each([false,true])("retries unsupported metadata citations without repeating valid siblings (exhausted: %s)", async exhausted => {
    const {saved,store} = decisionCheckpoints();
    const {extractor} = makeExtractor(store);
    const sourceHash = new EvidenceSource(source).contentHash;
    const documents = ["Statement system","Statement","Statement"].map(subject => new Document({
      pageContent:source.pageContent, metadata:{accountId:"account-1",sourceId:"source-1",sourceContentHash:sourceHash,
        what:source.pageContent,who:[subject],subject:[subject],reportedBy:[],factType:"recordedValue",tags:["fact"],
        where:"Unknown",why:"Unknown",pages:[1],sourceQuote:source.pageContent,sourceOffset:0,
        sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:source.pageContent}]},
    }));
    const requested: string[][] = [];
    const feedback: string[] = [];
    let attempts = 0;
    agentMocks.createAgent.mockImplementation(() => ({invoke:async ({messages}: any) => {
      const pairs = JSON.parse(messages[0].content).pairs;
      requested.push(pairs.map((pair:any) => pair.pairId));
      return {structuredResponse:{decisions:pairs.map((pair:any) => {
        if (pair.pairId !== "0:1") return {pairId:pair.pairId,relation:"independent_assertions",
          leftOnlyDetails:[],rightOnlyDetails:[],reason:"A separate assertion."};
        attempts++;
        if (pair.validationFeedback) feedback.push(pair.validationFeedback);
        return {pairId:pair.pairId,relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:[],
          semanticAssessment:{relationship:"equivalent",contextualDetails:[]},reason:"The same scoring statement.",
          metadataResolutions:pair.metadataReview.fields.map((field:string) => ({field,explanation:"The same system label.",
            citations:[{side:"left",citationIndex:0,sourceQuote:source.pageContent},
              {side:"right",citationIndex:0,sourceQuote:exhausted || attempts === 1 ? "Invented supporting quotation." : source.pageContent}]}))};
      })}};
    }}));
    const result = await extractor.canonicalizeDocuments(documents,source);
    expect(requested[0]).toEqual(expect.arrayContaining(["0:1","0:2","1:2"]));
    expect(requested.slice(1).every(ids => ids.length === 1 && ids[0] === "0:1")).toBe(true);
    expect(attempts).toBeGreaterThan(1);
    expect(feedback.every(message => message.includes("Repair metadataResolutions"))).toBe(true);
    expect(feedback.length).toBeGreaterThan(0);
    expect(result.failedPairIds).toEqual(exhausted ? ["0:1"] : []);
    expect(result.documents).toHaveLength(exhausted ? 3 : 2);
    expect(result.reviewDecisions.some(row => row.pairId === "0:1" && row.verdict === "distinct")).toBe(false);
    expect(saved.size).toBe(exhausted ? 2 : 3);
    if (!exhausted) {
      expect(result.documents.some(doc => doc.metadata.metadataResolutions?.length)).toBe(true);
      agentMocks.createAgent.mockClear();
      expect(await makeExtractor(store).extractor.canonicalizeDocuments(documents,source)).toEqual(result);
      expect(agentMocks.createAgent).not.toHaveBeenCalled();
    }
  });

  it.each(["source","model","candidate","cache"])("invalidates canonicalization reuse when %s changes", async change => {
    const {saved,store} = decisionCheckpoints();
    agentMocks.createAgent.mockReturnValue({invoke:vi.fn().mockResolvedValue({structuredResponse:{decisions:[{
      pairId:"0:1",relation:"independent_assertions",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Distinct statements.",
    }]}})});
    const first = makeExtractor(store).extractor;
    const documents = canonicalizationDocuments(first);
    await first.canonicalizeDocuments(documents,source);
    agentMocks.createAgent.mockClear();
    let changedSource = source;
    if(change==="source") {
      changedSource = new Document({pageContent:source.pageContent+" Additional source.",metadata:source.metadata});
      documents.forEach(doc=>{doc.metadata.sourceContentHash=new EvidenceSource(changedSource).contentHash;});
    }
    if(change==="model") vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME","other-model");
    if(change==="candidate") documents[1].metadata.what += " today";
    if(change==="cache") for(const [key,value] of saved) saved.set(key,{...(value as object),valueHash:"damaged"});
    await makeExtractor(store).extractor.canonicalizeDocuments(documents,changedSource);
    expect(agentMocks.createAgent).toHaveBeenCalled();
  });

  it("reviews document-level paraphrases without page-read tools and releases its permit", async () => {
    agentMocks.createAgent.mockReturnValue({ invoke: vi.fn().mockResolvedValue({ structuredResponse: {
      decisions: [{ pairId: "0:1", relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:["in the report"], reason: "Same recorded statement." }],
    } }) });
    const { extractor, semaphore } = makeExtractor();
    const documents = canonicalizationDocuments(extractor);

    const result = await extractor.canonicalizeDocuments(documents, source);

    expect(result.documents).toHaveLength(1);
    expect(result.applied).toHaveLength(1);
    expect(result.documents[0].metadata.extractedBy).toEqual(["independent:test", "primary:test"]);
    expect(agentMocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      tools: [], systemPrompt: expect.stringContaining("DOCUMENT-LEVEL CANONICALIZATION REVIEWER:"),
    }));
    expect(findSchemaRefs(toJsonSchema(agentMocks.createAgent.mock.calls[0][0].responseFormat))).toEqual([]);
    expect(semaphore.acquire).toHaveBeenCalledTimes(1);
    expect(semaphore.release).toHaveBeenCalledTimes(1);
  });

  it("keeps every record when canonicalization review fails", async () => {
    agentMocks.createAgent.mockReturnValue({ invoke: vi.fn().mockRejectedValue(new Error("model unavailable")) });
    const { extractor, semaphore } = makeExtractor();
    const documents = canonicalizationDocuments(extractor);

    const result = await extractor.canonicalizeDocuments(documents, source);

    expect(result.documents).toEqual(documents);
    expect(result.failedBatches).toBe(1);
    expect(semaphore.acquire).toHaveBeenCalledTimes(1);
    expect(semaphore.release).toHaveBeenCalledTimes(1);
  });

  it.each(["lost-detail", "atomic-compound"])("blocks %s through agent invocation without retrying a substantive conflict", async kind => {
    agentMocks.createAgent.mockReturnValue({invoke:vi.fn().mockResolvedValue({structuredResponse:{decisions:[{
      pairId:"0:1",relation:"same_assertion",leftOnlyDetails:[],
      rightOnlyDetails:kind === "lost-detail" ? ["all results were average"] : [],
      verdict:"duplicate",survivor:kind === "lost-detail" ? "left" : "right",reason:"Same evidence.",
    }]}})});
    const {extractor,semaphore} = makeExtractor();
    const documents = canonicalizationDocuments(extractor);
    const statements = kind === "lost-detail"
      ? ["The scale had no elevated results.","The scale had no elevated results; all results were average."]
      : ["The worker attended the safety course.","The worker attended the safety course and passed the examination."];
    documents.forEach((document,index) => {
      document.metadata.what = statements[index];
      document.pageContent = formatEvidenceContent(document.metadata);
    });
    const before = JSON.stringify(documents);
    const result = await extractor.canonicalizeDocuments(documents,source);
    expect(result.documents).toEqual(documents);
    expect(JSON.stringify(documents)).toBe(before);
    expect(result.reviewDecisions[0]).toMatchObject({verdict:"distinct",survivor:"none"});
    expect(result.failedPairIds).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(semaphore.acquire).toHaveBeenCalledTimes(1);
    expect(semaphore.release).toHaveBeenCalledTimes(1);
  });

  it.each(["repaired", "invalid", "invocation-failed"])("reuses valid identity decisions when one pair is %s", async outcome => {
    const requests: any[] = [];
    agentMocks.createAgent.mockImplementation(() => ({invoke:vi.fn(async ({messages}) => {
      const request = JSON.parse(messages[0].content);
      requests.push(request);
      if (requests.length === 1) return {structuredResponse:{decisions:[
        {pairId:"0:1", relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:["in the report"],reason:"Same assertion with all details retained."},
        {pairId:"0:2", relation:"invalid",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Invalid relation."},
        {pairId:"1:2", relation:"uncertain",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Identity uncertain."},
      ]}};
      if (outcome === "invocation-failed") throw new Error("review unavailable");
      return {structuredResponse:{decisions:[outcome === "repaired"
        ? {pairId:"0:2", relation:"uncertain",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Keep both assertions."}
        : {pairId:"0:2", relation:"invalid",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Still malformed."}]}};
    })}));
    const {extractor,semaphore} = makeExtractor();
    const documents = canonicalizationDocuments(extractor);
    const metadata = {...documents[0].metadata,where:"Unknown",what:"A factual statement was recorded in a report."};
    documents.push(new Document({metadata,pageContent:formatEvidenceContent(metadata)}));
    const result = await extractor.canonicalizeDocuments(documents,source);
    expect(requests).toHaveLength(2);
    expect(requests[0].pairs).toHaveLength(3);
    expect(requests[1].pairs.map((pair:any) => pair.pairId)).toEqual(["0:2"]);
    expect(requests[1].pairs[0]).not.toHaveProperty("allowedSurvivors");
    expect(requests[1].pairs[0].validationFeedback).toContain('relation (same_assertion/independent_assertions/uncertain)');
    expect(result.applied).toEqual([{pairId:"0:1",survivorIndex:1,removedIndex:0}]);
    expect(result.documents).toHaveLength(2);
    expect(result.failedPairIds).toEqual(outcome === "repaired" ? [] : ["0:2"]);
    expect(result.failedBatches).toBe(outcome === "repaired" ? 0 : 1);
    expect(result.reviewDecisions.map(row => row.pairId)).toEqual(outcome === "repaired" ? ["0:1","0:2","1:2"] : ["0:1","1:2"]);
    expect(semaphore.acquire).toHaveBeenCalledTimes(2);
    expect(semaphore.release).toHaveBeenCalledTimes(2);
  });

  it.each(["reported","omitted"])("keeps an additional property separate through agent invocation when differences are %s", async inventory => {
    agentMocks.createAgent.mockReturnValue({invoke:vi.fn().mockResolvedValue({structuredResponse:{decisions:[{
      pairId:"0:1",relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:inventory === "reported" ? ["adequate social skills"] : [],
      reason:"The model wrongly calls the extra property compatible enrichment.",
    }]}})});
    const {extractor,semaphore} = makeExtractor();
    const documents = canonicalizationDocuments(extractor);
    const statements=["Scores suggest no pervasive developmental disorder.",
      "Scores suggest adequate social skills with no pervasive developmental disorder."];
    documents.forEach((document,index) => {
      document.metadata.what=statements[index];document.pageContent=formatEvidenceContent(document.metadata);
    });
    const result=await extractor.canonicalizeDocuments(documents,source);
    expect(result.pairs).toHaveLength(1);
    expect(result.documents).toEqual(documents);
    expect(result.reviewDecisions[0]).toMatchObject({verdict:"distinct",survivor:"none",
      reason:expect.stringContaining(inventory === "reported" ? "unrecognized enrichment" : "inventory omits")});
    expect(result.failedPairIds).toEqual([]);
    expect(semaphore.acquire).toHaveBeenCalledTimes(1);
    expect(semaphore.release).toHaveBeenCalledTimes(1);
  });

  it("normalizes display quotes around an exact inventory excerpt without another model call", async () => {
    agentMocks.createAgent.mockReturnValue({invoke:vi.fn().mockResolvedValue({structuredResponse:{decisions:[{
      pairId:"0:1",relation:"same_assertion",leftOnlyDetails:[],rightOnlyDetails:['"in the report"'],reason:"Same recorded statement.",
    }]}})});
    const {extractor,semaphore}=makeExtractor();
    const result=await extractor.canonicalizeDocuments(canonicalizationDocuments(extractor),source);
    expect(result.applied).toHaveLength(1);
    expect(result.decisions[0].rightOnlyDetails).toEqual(["in the report"]);
    expect(semaphore.acquire).toHaveBeenCalledTimes(1);
    expect(semaphore.release).toHaveBeenCalledTimes(1);
  });

  it("retries an invented excerpt with the rejected text and actual assertion, then releases both permits", async () => {
    const requests: {pairs:{validationFeedback?:string}[]}[]=[];
    agentMocks.createAgent.mockReturnValue({invoke:vi.fn(async ({messages}) => {
      requests.push(JSON.parse(messages[0].content));
      return {structuredResponse:{decisions:[{pairId:"0:1",relation:"independent_assertions",
        leftOnlyDetails:requests.length===1 ? ["detail copied from a different quotation"] : [],rightOnlyDetails:[],reason:"Keep the assertions separate."}]}};
    })});
    const {extractor,semaphore}=makeExtractor(),documents=canonicalizationDocuments(extractor);
    const result=await extractor.canonicalizeDocuments(documents,source);
    expect(result.failedPairIds).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1].pairs[0].validationFeedback).toContain('Rejected excerpts: ["detail copied from a different quotation"]');
    expect(requests[1].pairs[0].validationFeedback).toContain(JSON.stringify(documents[0].metadata.what));
    expect(semaphore.acquire).toHaveBeenCalledTimes(2);
    expect(semaphore.release).toHaveBeenCalledTimes(2);
  });

  it("keeps the assertion separate from source text and includes later supporting citations", async () => {
    let request: any;
    agentMocks.createAgent.mockImplementation(() => ({invoke:vi.fn(async ({messages}) => {
      request = JSON.parse(messages[0].content);
      return {structuredResponse:{decisions:[{pairId:"0:1", relation:"uncertain",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Review context."}]}};
    })}));
    const {extractor} = makeExtractor();
    const documents = canonicalizationDocuments(extractor);
    // The fourth supporting citation is the continuation previously omitted.
    const secondPage = "Context one. Context two. high average social";
    const extended = new Document({pageContent:source.pageContent + "<!-- PageBreak -->" + secondPage
      + "<!-- PageBreak -->cooperation skills.", metadata:source.metadata});
    documents.forEach(document => document.metadata.sourceContentHash = new EvidenceSource(extended).contentHash);
    documents[1].metadata.sourceSpans.push(...["Context one.","Context two.","high average social"].map(quote => ({
      pageNumber:2,sourceOffset:secondPage.indexOf(quote),sourceQuote:quote})),
    {pageNumber:3,sourceOffset:0,sourceQuote:"cooperation skills."});
    await extractor.canonicalizeDocuments(documents,extended);
    const right = request.pairs[0].right;
    expect(right.assertion.what).toBe(documents[1].metadata.what);
    expect(right.assertion).not.toHaveProperty("sourceQuote");
    expect(right.evidenceContext.primary.sourceQuote).toBe(source.pageContent);
    expect(right.evidenceContext.supportingQuotes.at(-1)).toMatchObject({citationIndex:4,sourceQuote:"cooperation skills."});
  });

  it.each(["distinct", "uncertain"])("retains both records for an explicit %s canonicalization decision", async verdict => {
    agentMocks.createAgent.mockReturnValue({invoke:vi.fn().mockResolvedValue({structuredResponse:{
      decisions:[{pairId:"0:1", relation:verdict === "distinct" ? "independent_assertions" : "uncertain",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Neither survivor preserves both statements."}],
    }})});
    const {extractor,semaphore} = makeExtractor();
    const documents = canonicalizationDocuments(extractor);
    const result = await extractor.canonicalizeDocuments(documents, source);
    expect(result.documents).toEqual(documents);
    expect(result.applied).toEqual([]);
    expect(result.failedBatches).toBe(0);
    expect(semaphore.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    {decisions:[{pairId:"0:1", relation:"invalid",leftOnlyDetails:[],rightOnlyDetails:[],reason:"No survivor is valid."}]},
    {decisions:[{pairId:"0:1", relation:"invalid",leftOnlyDetails:[],rightOnlyDetails:[],reason:"No survivor is valid."}]},
    {decisions:[]},
  ])("preserves records when identity assessments are invalid or missing: %j", async ({decisions}) => {
    agentMocks.createAgent.mockReturnValue({invoke:vi.fn().mockResolvedValue({structuredResponse:{decisions}})});
    const {extractor,semaphore} = makeExtractor();
    const documents = canonicalizationDocuments(extractor);
    const result = await extractor.canonicalizeDocuments(documents, source);
    expect(result.documents).toEqual(documents);
    expect(result.applied).toEqual([]);
    expect(result.failedBatches).toBe(1);
    expect(semaphore.release).toHaveBeenCalledTimes(2);
  });

  it("retries a failed canonicalization batch in smaller parts", async () => {
    let calls = 0;
    agentMocks.createAgent.mockImplementation(() => ({ invoke: vi.fn(async ({messages}) => {
      if (++calls === 1) throw new Error("invalid large response");
      return { structuredResponse: { decisions: JSON.parse(messages[0].content).pairs.map((pair:any) => ({
        pairId:pair.pairId, relation:"uncertain",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Equivalence is uncertain."})) } };
    }) }));
    const { extractor, semaphore } = makeExtractor();
    const documents = canonicalizationDocuments(extractor);
    const metadata = { ...documents[0].metadata, what: "A factual statement was recorded in a report." };
    documents.push(new Document({ metadata, pageContent: formatEvidenceContent(metadata) }));

    const result = await extractor.canonicalizeDocuments(documents, source);

    expect(result.documents).toHaveLength(3);
    expect(result.failedBatches).toBe(0);
    expect(calls).toBe(3);
    expect(semaphore.acquire).toHaveBeenCalledTimes(3);
    expect(semaphore.release).toHaveBeenCalledTimes(3);
  });

  it("preserves records and releases permits when structured review output stays invalid", async () => {
    let calls = 0;
    agentMocks.createAgent.mockImplementation(() => ({ invoke: vi.fn(async ({messages}) => {
      calls++;
      return { structuredResponse: calls < 3
        ? { decisions: [{ pairId: "0:1", relation:"invalid",leftOnlyDetails:[],rightOnlyDetails:[], reason: "Invalid survivor." }] }
        : { decisions: JSON.parse(messages[0].content).pairs.map((pair:any) => ({
          pairId:pair.pairId, relation:"uncertain",leftOnlyDetails:[],rightOnlyDetails:[],reason:"Equivalence is uncertain."})) } };
    }) }));
    const { extractor, semaphore } = makeExtractor();
    const documents = canonicalizationDocuments(extractor);
    const metadata = { ...documents[0].metadata, what: "A factual statement was recorded in a report." };
    documents.push(new Document({ metadata, pageContent: formatEvidenceContent(metadata) }));

    const result = await extractor.canonicalizeDocuments(documents, source);

    expect(result.documents).toEqual(documents);
    expect(result.applied).toEqual([]);
    expect(result.failedBatches).toBe(1);
    expect(result.failedPairIds).toHaveLength(3);
    expect(calls).toBe(2);
    expect(semaphore.acquire).toHaveBeenCalledTimes(2);
    expect(semaphore.release).toHaveBeenCalledTimes(2);
  });

  it("runs canonicalization after ordinary deduplication when enabled", async () => {
    vi.stubEnv("EVIDENCE_CANONICALIZATION_MODE", "review");
    const { extractor } = makeExtractor();
    const documents = canonicalizationDocuments(extractor);
    vi.spyOn(extractor as any, "generateEvidence").mockResolvedValue({ events: [], facts: [], claims: [] });
    const review = vi.spyOn(extractor, "canonicalizeDocuments").mockResolvedValue({
      documents, pairs: [], decisions: [], reviewDecisions: [], applied: [], failedBatches: 0, failedPairIds: [],
    });

    await extractor.generateDocuments(source);

    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0][0]).toEqual([]);
  });

  it.each(["off", "annotate"])("converts all response formats without references with event structure %s", async mode => {
    vi.stubEnv("EVIDENCE_EVENT_STRUCTURE_MODE", mode);
    const primaryEvent = event({ sourceQuote: source.pageContent,
      ...(mode === "annotate" ? {eventStructure: {trigger: "", roles: []}} : {}) });
    agentMocks.createAgent.mockImplementation(({ responseFormat }) => {
      const fields = jsonResponseFormat(responseFormat).properties as Record<string, unknown>;
      const structuredResponse = "decisions" in fields
        ? { decisions: [{ candidateId: "1:0:candidate-0", verdict: "supported", corrections: [], keepOriginal: true,
          reason: "", events: [], facts: [], claims: [] }] }
        : "events" in fields && "facts" in fields ? { events: [], facts: [], claims: [] }
        : "events" in fields ? { events: [primaryEvent] }
        : "facts" in fields ? { facts: [] } : { claims: [] };
      return {
        invoke: vi.fn().mockResolvedValue({ structuredResponse }),
      };
    });
    const { extractor } = makeExtractor();

    await expect(extractor.generateDocuments(source)).resolves.toHaveLength(1);
    const formats = agentMocks.createAgent.mock.calls.map(([options]) => options.responseFormat);
    expect(formats.map((format) => Object.keys(jsonResponseFormat(format).properties).sort().join(",")).sort())
      .toEqual(["claims", "claims,events,facts", "decisions", "events", "facts"]);
    for (const format of formats) {
      const json = jsonResponseFormat(format);
      expect(findSchemaRefs(json)).toEqual([]);
      const eventSchema = json.properties.events?.items ?? json.properties.decisions?.items.properties.events.items;
      if (eventSchema) {
        expect(Object.hasOwn(eventSchema.properties, "eventStructure")).toBe(mode === "annotate");
        if (mode === "annotate") expect(eventSchema.required).toContain("eventStructure");
      }
    }
  });

  describe("event structure benchmark replay through agent invocation", () => {
    const suite = validateSupportSuite(JSON.parse(readFileSync(new URL("./fixtures/evidence-event-structure.json", import.meta.url), "utf8")));
    it.each(suite.cases)("applies and preserves annotations for $id", async testCase => {
      vi.stubEnv("EVIDENCE_EVENT_STRUCTURE_MODE", "annotate");
      vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "off");
      vi.stubEnv("EVIDENCE_CANONICALIZATION_MODE", "off");
      const input = supportCaseInput(testCase);
      const semaphore = {acquire: vi.fn(async () => true), release: vi.fn()};
      const readPages: number[] = [];
      // Controlled responses exercise application behavior. They do not measure model accuracy.
      agentMocks.createAgent.mockImplementation(({systemPrompt, tools}) => ({invoke: vi.fn(async ({messages}) => {
        expect(systemPrompt).toContain("EVENT STRUCTURE:");
        const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        const decisions = [];
        for (const candidate of candidates) {
          const item = structuredClone(candidate.item);
          if (item.sourceQuote.includes("W-17")) {
            const context = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[0]);
            expect(context.citedContext.some((passage: any) => passage.pageNumber === 1 && passage.sourceQuote.includes("Morgan Vale"))).toBe(true);
            const page = JSON.parse(await tools.find((tool: any) => tool.name === "read_source_page").invoke({pageNumber: 1, startOffset: 0}));
            readPages.push(page.pageNumber);
            item.supportingQuotes = [{pageNumber: 1, quote: page.text}];
          }
          const citations = item.supportingQuotes.length ? [0, 1] : [0];
          item.eventStructure = item.eventType === "payment"
            ? {trigger: item.sourceQuote.includes(" paid ") ? "paid" : "payment of 500 dollars", roles: [
              {role: "payer", participant: 0, citations}, {role: "payee", participant: 1, citations: [0]}]}
            : item.sourceQuote.includes(" sent ") ? {trigger: "sent", roles: [
              {role: "sender", participant: 0, citations: [0]}, {role: "recipient", participant: 1, citations: [0]}]}
              : item.sourceQuote.includes(" stated:") ? {trigger: "stated", roles: [{role: "speaker", participant: 0, citations: [0]}]}
                : item.eventType === "employmentAction" ? {trigger: "dismissal", roles: [{role: "affectedPerson", participant: 0, citations: [0]}]}
                  : {trigger: "", roles: [{role: "subject", participant: 0, citations: [0]}]};
          decisions.push({candidateId: candidate.candidateId, verdict: "supported", keepOriginal: false,
            reason: "Source-supported trigger and participant roles.", corrections: [], events: [item], facts: [], claims: []});
        }
        return {structuredResponse: {decisions}};
      })}));
      const extractor = new EvidenceExtractor("synthetic", "event-structure", semaphore, undefined, input.store);
      const documents = await extractor.generateDocuments(input.document);
      expect(gradeSupportCase(testCase, {caseId: testCase.id, documents,
        availableEvidenceIds: testCase.contextMode === "document" ? null : testCase.evidence.map(unit => unit.id)}).passed).toBe(true);
      if (testCase.contextMode === "document") expect(readPages).toEqual([1]);
      expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
    });

    it("retains a supported event when the optional trigger phrase is ambiguous", async () => {
      vi.stubEnv("EVIDENCE_EVENT_STRUCTURE_MODE", "annotate");
      vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "off");
      const testCase = suite.cases.find(item => item.id === "repeated-payment-mentions")!;
      const input = supportCaseInput(testCase);
      const semaphore = {acquire: vi.fn(async () => true), release: vi.fn()};
      agentMocks.createAgent.mockImplementation(() => ({invoke: vi.fn(async ({messages}) => {
        const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        return {structuredResponse: {decisions: candidates.map((candidate: any) => ({candidateId: candidate.candidateId,
          verdict: "supported", keepOriginal: false, reason: "Supported payment with a trigger annotation.", corrections: [], facts: [], claims: [],
          events: [{...candidate.item, eventStructure: {trigger: candidate.item.sourceQuote.includes(" paid ") ? "paid" : "payment",
            roles: [{role: "payer", participant: 0, citations: [0]}, {role: "payee", participant: 1, citations: [0]}]}}],
        }))}};
      })}));
      const documents = await new EvidenceExtractor("synthetic", "event-structure", semaphore, undefined, input.store).generateDocuments(input.document);
      expect(documents).toHaveLength(2);
      expect(documents.find(document => document.metadata.pages[0] === 2)!.metadata.eventStructure)
        .toMatchObject({trigger: null, triggerIssue: "ambiguous"});
      expect(semaphore.acquire).toHaveBeenCalledTimes(2);
      expect(semaphore.release).toHaveBeenCalledTimes(2);
    });

    it("rejects invalid role references through the reviewer and releases every permit", async () => {
      vi.stubEnv("EVIDENCE_EVENT_STRUCTURE_MODE", "annotate");
      vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "off");
      const testCase = suite.cases[0], input = supportCaseInput(testCase);
      const semaphore = {acquire: vi.fn(async () => true), release: vi.fn()};
      agentMocks.createAgent.mockImplementation(() => ({invoke: vi.fn(async ({messages}) => {
        const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        return {structuredResponse: {decisions: candidates.map((candidate: any) => ({candidateId: candidate.candidateId,
          verdict: "supported", keepOriginal: false, reason: "Invalid indexed role.", corrections: [], facts: [], claims: [],
          events: [{...candidate.item, eventStructure: {trigger: "paid", roles: [{role: "payer", participant: 99, citations: [0]}]}}],
        }))}};
      })}));
      await expect(new EvidenceExtractor("synthetic", "event-structure", semaphore, undefined, input.store)
        .generateDocuments(input.document)).rejects.toThrow("Unresolved evidence remains");
      expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
    });
  });

  it("rejects an agent invocation failure and releases all four acquired permits", async () => {
    const failure = new Error("agent unavailable");
    const invoke = vi.fn().mockRejectedValue(failure);
    agentMocks.createAgent.mockReturnValue({ invoke });
    const { extractor, semaphore } = makeExtractor();

    await expect(extractor.generateDocuments(source)).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(semaphore.acquire).toHaveBeenCalledTimes(4);
    expect(semaphore.release).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["missing facets", undefined],
    ["unknown namespace", [{ namespace: "anything", value: "assessment" }]],
    ["blank facet", [{ namespace: "medical", value: " " }]],
  ])("rejects a claim with %s at the agent boundary", async (_description, facets) => {
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({
      invoke: vi.fn().mockResolvedValue({ structuredResponse: systemPrompt.includes("INDEPENDENT EXTRACTOR:")
        ? { events: [], facts: [], claims: [] }
        : systemPrompt.includes("EVENT WORKER:") ? { events: [] }
        : systemPrompt.includes("FACT WORKER:") ? { facts: [] }
        : { claims: [{ ...claim({ sourceQuote: source.pageContent }), facets }] } }),
    }));
    const { extractor, semaphore } = makeExtractor();

    await expect(extractor.generateDocuments(source)).rejects.toBeInstanceOf(ZodError);
    expect(semaphore.release).toHaveBeenCalledTimes(4);
  });

  it("retries a missing GPT tool output once with a fresh agent and read budget", async () => {
    const failure = Object.assign(new Error("400 No tool output found for function call call_example."), { status: 400 });
    let claimInvocations = 0;
    const claimTools: unknown[] = [];
    agentMocks.createAgent.mockImplementation(({ systemPrompt, tools }) => {
      const isClaim = systemPrompt.includes("CLAIM WORKER:");
      if (isClaim) claimTools.push(tools[0]);
      return { invoke: vi.fn(async () => {
        if (isClaim && ++claimInvocations === 1) throw failure;
        const structuredResponse = systemPrompt.includes("INDEPENDENT EXTRACTOR:")
          ? { events: [], facts: [], claims: [] }
          : systemPrompt.includes("EVENT WORKER:") ? { events: [] }
          : systemPrompt.includes("FACT WORKER:") ? { facts: [] } : { claims: [] };
        return { structuredResponse };
      }) };
    });
    const { extractor, semaphore } = makeExtractor();

    await expect(extractor.generateDocuments(source)).resolves.toEqual([]);
    expect(claimInvocations).toBe(2);
    expect(claimTools).toHaveLength(2);
    expect(claimTools[0]).not.toBe(claimTools[1]);
    expect(agentMocks.createAgent).toHaveBeenCalledTimes(5);
    expect(semaphore.acquire).toHaveBeenCalledTimes(4);
    expect(semaphore.release).toHaveBeenCalledTimes(4);
  });

  it.each(["recovered", "exhausted", "tool-then-missing", "truncated"])(
    "bounds missing structured response retries within the failed extraction stage: %s", async outcome => {
      let eventCalls = 0;
      const toolsSeen: unknown[] = [];
      agentMocks.createAgent.mockImplementation(({systemPrompt,tools}) => {
        const eventWorker = systemPrompt.includes("EVENT WORKER:");
        if (eventWorker) toolsSeen.push(tools[0]);
        return {invoke:vi.fn(async () => {
          if (eventWorker) {
            eventCalls++;
            if (outcome === "tool-then-missing" && eventCalls === 1)
              throw Object.assign(new Error("400 No tool output found for function call call_example."),{status:400});
            if (outcome === "truncated") return {structuredResponse:undefined,messages:[{response_metadata:{finish_reason:"length"}}]};
            if (eventCalls === 1 || outcome !== "recovered") return {structuredResponse:undefined};
          }
          return {structuredResponse:systemPrompt.includes("INDEPENDENT EXTRACTOR:") ? {events:[],facts:[],claims:[]}
            : eventWorker ? {events:[]} : systemPrompt.includes("FACT WORKER:") ? {facts:[]} : {claims:[]}};
        })};
      });
      const {extractor,semaphore} = makeExtractor();
      const result = extractor.generateDocuments(source);
      if (outcome === "recovered") await expect(result).resolves.toEqual([]);
      else if (outcome === "truncated") await expect(result).rejects.toThrow("output token limit");
      else await expect(result).rejects.toMatchObject({name:"EvidenceStructuredResponseError",reason:"missing"});
      expect(eventCalls).toBe(outcome === "truncated" ? 1 : 2);
      if (toolsSeen.length === 2) expect(toolsSeen[0]).not.toBe(toolsSeen[1]);
      expect(semaphore.acquire).toHaveBeenCalledTimes(4);
      expect(semaphore.release).toHaveBeenCalledTimes(4);
      expect(agentMocks.createAgent).toHaveBeenCalledTimes(outcome === "truncated" ? 4 : 5);
    });

  it.each([
    ["malformed JSON", "not JSON", SyntaxError],
    ["invalid evidence fields", "{}", ZodError],
  ])("rejects Claude %s and releases every acquired permit", async (_case, payload, errorType) => {
    vi.stubEnv("EVIDENCE_PRIMARY_DEPLOYMENT_NAME", "tasks-claude-haiku-5-5");
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "research-claude-sonnet-5-5");
    agentMocks.createAgent.mockImplementation(({ responseFormat }) => ({
      invoke: vi.fn().mockResolvedValue({ structuredResponse: responseFormat.schema.shape
        ? { payload } : { [Object.keys(responseFormat.schema.properties)[0]]: [] } }),
    }));
    const { extractor, semaphore } = makeExtractor();

    await expect(extractor.generateDocuments(source)).rejects.toBeInstanceOf(errorType);
    expect(agentMocks.createAgent).toHaveBeenCalledTimes(5);
    expect(semaphore.acquire).toHaveBeenCalledTimes(4);
    expect(semaphore.release).toHaveBeenCalledTimes(4);
  });

  it("repairs one invalid Claude payload and validates the corrected claim", async () => {
    vi.stubEnv("EVIDENCE_PRIMARY_DEPLOYMENT_NAME", "tasks-claude-haiku-5-5");
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "research-claude-sonnet-5-5");
    const supported = claim({ sourceQuote: source.pageContent });
    let independentCalls = 0;
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({
      invoke: vi.fn(async ({ messages }) => {
        let payload: unknown;
        if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
          const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
          payload = { decisions: candidates.map((candidate: { candidateId: string }) => ({
            candidateId: candidate.candidateId, verdict: "supported", corrections: [], keepOriginal: false, reason: "Anchored in target",
            events: [], facts: [], claims: [supported],
          })) };
        } else if (systemPrompt.includes("INDEPENDENT EXTRACTOR:")) {
          independentCalls++;
          if (independentCalls === 2) {
            expect(systemPrompt).toContain("REPAIR:");
            expect(messages[0].content).toContain("claims.0.statement: Required");
          }
          payload = independentCalls === 1
            ? { events: [], facts: [], claims: [{ claimant: "Jane", sourceQuote: source.pageContent }] }
            : { events: [], facts: [], claims: [supported] };
        } else if (systemPrompt.includes("EVENT WORKER:")) payload = { events: [] };
        else if (systemPrompt.includes("FACT WORKER:")) payload = { facts: [] };
        else payload = { claims: [] };
        return { structuredResponse: systemPrompt.includes("INDEPENDENT EXTRACTOR:")
          || systemPrompt.includes("SOURCE SUPPORT REVIEWER:")
          ? { payload: JSON.stringify(payload) } : payload };
      }),
    }));
    const { extractor, semaphore } = makeExtractor();

    const documents = await extractor.generateDocuments(source);

    expect(documents).toHaveLength(1);
    expect(documents[0].metadata.tags).toContain("claim");
    expect(independentCalls).toBe(2);
    expect(semaphore.acquire).toHaveBeenCalledTimes(5);
    expect(semaphore.release).toHaveBeenCalledTimes(5);
  });

  it("uses Claude's raw response when the structured envelope is unavailable", async () => {
    vi.stubEnv("EVIDENCE_PRIMARY_DEPLOYMENT_NAME", "tasks-claude-haiku-5-5");
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "research-claude-sonnet-5-5");
    const raw = '{"payload":"unfinished';
    let independentCalls = 0;
    agentMocks.createAgent.mockImplementation(({ systemPrompt, responseFormat }) => ({
      invoke: vi.fn(async ({ messages }, options) => {
        if (systemPrompt.includes("INDEPENDENT EXTRACTOR:")) {
          independentCalls++;
          if (independentCalls === 1) {
            const capture = options.callbacks.find((callback: { name: string }) => callback.name === "structured-response-capture");
            await capture.handleLLMEnd({ generations: [[{ message: { content: raw, response_metadata: { stop_reason: "end_turn" } } }]] });
            return { structuredResponse: undefined, messages: [] };
          }
          expect(messages[0].content).toContain(raw);
          expect(messages[0].content).not.toContain("undefined");
          return { structuredResponse: { payload: '{"events":[],"facts":[],"claims":[]}' } };
        }
        return { structuredResponse: { [Object.keys(responseFormat.schema.properties)[0]]: [] } };
      }),
    }));
    const { extractor, semaphore } = makeExtractor();

    await expect(extractor.generateDocuments(source)).resolves.toEqual([]);
    expect(independentCalls).toBe(2);
    expect(semaphore.release).toHaveBeenCalledTimes(4);
  });

  it("reports Claude output truncation and releases acquired permits", async () => {
    vi.stubEnv("EVIDENCE_PRIMARY_DEPLOYMENT_NAME", "tasks-claude-haiku-5-5");
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "research-claude-sonnet-5-5");
    agentMocks.createAgent.mockImplementation(({ systemPrompt, responseFormat }) => ({
      invoke: vi.fn(async (_request, options) => {
        if (systemPrompt.includes("EVENT WORKER:")) {
          const capture = options.callbacks.find((callback: { name: string }) => callback.name === "structured-response-capture");
          await capture.handleLLMEnd({ generations: [[{ message: { content: "partial", response_metadata: { stop_reason: "max_tokens" } } }]] });
          throw new Error("provider parsing failed");
        }
        return { structuredResponse: responseFormat.schema.shape
          ? { payload: '{"events":[],"facts":[],"claims":[]}' }
          : { [Object.keys(responseFormat.schema.properties)[0]]: [] } };
      }),
    }));
    const { extractor, semaphore } = makeExtractor();

    await expect(extractor.generateDocuments(source)).rejects.toThrow(/output token limit/);
    expect(semaphore.acquire).toHaveBeenCalledTimes(4);
    expect(semaphore.release).toHaveBeenCalledTimes(4);
  });

  it("treats omitted nullable Claude date parts as unknown while validating the remaining evidence", async () => {
    vi.stubEnv("EVIDENCE_PRIMARY_DEPLOYMENT_NAME", "tasks-claude-haiku-5-5");
    vi.stubEnv("EVIDENCE_INDEPENDENT_DEPLOYMENT_NAME", "research-claude-sonnet-5-5");
    const incompleteEvent = { ...event({ sourceQuote: source.pageContent }) };
    const incompleteFact = { ...staticFact({ sourceQuote: source.pageContent, asOfYear: "2025" }) };
    const incompleteClaim = { ...claim({ sourceQuote: source.pageContent }) };
    delete (incompleteEvent as Partial<EventExtractionResponse>).whenStartedQuarter;
    delete (incompleteFact as Partial<FactExtractionResponse>).asOfDay;
    delete (incompleteClaim as Partial<ClaimExtractionResponse>).whenStartedMonth;
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({
      invoke: vi.fn(async ({ messages }) => {
        let payload: unknown;
        if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
          const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
          payload = { decisions: candidates.map((candidate: { candidateId: string; kind: string }) => ({
            candidateId: candidate.candidateId, verdict: "supported", corrections: [], keepOriginal: false, reason: "Anchored in target",
            events: candidate.kind === "event" ? [incompleteEvent] : [],
            facts: candidate.kind === "fact" ? [incompleteFact] : [],
            claims: candidate.kind === "claim" ? [incompleteClaim] : [],
          })) };
        } else if (systemPrompt.includes("INDEPENDENT EXTRACTOR:")) {
          payload = { events: [incompleteEvent], facts: [incompleteFact], claims: [incompleteClaim] };
        } else if (systemPrompt.includes("EVENT WORKER:")) payload = { events: [] };
        else if (systemPrompt.includes("FACT WORKER:")) payload = { facts: [] };
        else payload = { claims: [] };
        return { structuredResponse: systemPrompt.includes("INDEPENDENT EXTRACTOR:")
          || systemPrompt.includes("SOURCE SUPPORT REVIEWER:")
          ? { payload: JSON.stringify(payload) } : payload };
      }),
    }));
    const { extractor, semaphore } = makeExtractor();

    const documents = await extractor.generateDocuments(source);

    expect(documents).toHaveLength(3);
    expect(documents.find(doc => doc.metadata.tags.includes("event"))?.metadata.whenStarted.quarter).toBeNull();
    expect(documents.find(doc => doc.metadata.factType === "assessmentResult")?.metadata.asOf)
      .toMatchObject({ year: "2025", day: null });
    expect(documents.find(doc => doc.metadata.tags.includes("claim"))?.metadata.whenStarted)
      .toMatchObject({ year: "2025", month: null, day: "28" });
    expect(semaphore.release).toHaveBeenCalledTimes(5);
  });

  it("rejects invalid reviewer output and releases every acquired permit", async () => {
    agentMocks.createAgent.mockImplementation(({ responseFormat }) => {
      const fields = jsonResponseFormat(responseFormat).properties as Record<string, unknown>;
      const structuredResponse = "decisions" in fields
        ? {} // Reconciliation output is invalid because decisions is missing.
        : "events" in fields && "facts" in fields ? { events: [], facts: [], claims: [] }
        : "events" in fields ? { events: [event({ sourceQuote: source.pageContent })] }
        : "facts" in fields ? { facts: [] } : { claims: [] };
      return { invoke: vi.fn().mockResolvedValue({ structuredResponse }) };
    });
    const { extractor, semaphore } = makeExtractor();

    await expect(extractor.generateDocuments(source)).rejects.toBeInstanceOf(ZodError);
    expect(agentMocks.createAgent).toHaveBeenCalledTimes(5);
    expect(semaphore.acquire).toHaveBeenCalledTimes(5);
    expect(semaphore.release).toHaveBeenCalledTimes(5);
  });

  it("keeps independent discovery blind and retains supported evidence from either pass", async () => {
    const primary = event({ what: "PRIMARY_ONLY_SUMMARY", sourceQuote: source.pageContent });
    const secondary = claim({ statement: "INDEPENDENT_ONLY_SUMMARY", sourceQuote: source.pageContent });
    let independentPrompt = "";
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({
      invoke: vi.fn(async ({ messages }) => {
        if (systemPrompt.includes("INDEPENDENT EXTRACTOR:")) {
          independentPrompt = messages[0].content;
          return { structuredResponse: { events: [], facts: [], claims: [secondary] } };
        }
        if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
          const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
          return { structuredResponse: { decisions: candidates.map((candidate: any) => ({
            candidateId: candidate.candidateId, verdict: "supported", corrections: [], keepOriginal: true, reason: "",
            events: [], facts: [], claims: [],
          })) } };
        }
        return { structuredResponse: systemPrompt.includes("EVENT WORKER:") ? { events: [primary] }
          : systemPrompt.includes("FACT WORKER:") ? { facts: [] } : { claims: [] } };
      }),
    }));
    const { extractor, semaphore } = makeExtractor();

    const documents = await extractor.generateDocuments(source);

    expect(independentPrompt).toContain(source.pageContent);
    expect(independentPrompt).not.toContain(primary.what);
    expect(independentPrompt).not.toContain("CANDIDATES");
    expect(documents.map(doc => doc.metadata.what)).toEqual([primary.what, secondary.statement]);
    expect(documents[0].metadata.extractedBy.some((role: string) => role.startsWith("primary-events:"))).toBe(true);
    expect(documents[1].metadata.extractedBy).toContain("independent:research-gpt-6.1-sol");
    expect(semaphore.release).toHaveBeenCalledTimes(5);
  });

  it("lets the reviewer reclassify a score candidate from event to static fact", async () => {
    const row = "Anxious-Depressed | Borderline | 65 | 93";
    const source = new Document({ pageContent: row, metadata: { pages: [1], sourceId: "source-1" } });
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({
      invoke: vi.fn(async () => {
        if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
          return { structuredResponse: { decisions: [{ candidateId: "1:0:candidate-0", verdict: "supported",
            corrections: [], keepOriginal: false, reason: "The table gives a static score, not an occurrence", events: [], facts: [staticFact()], claims: [] }] } };
        }
        if (systemPrompt.includes("INDEPENDENT EXTRACTOR:")) {
          return { structuredResponse: { events: [], facts: [], claims: [] } };
        }
        if (systemPrompt.includes("EVENT WORKER:")) {
          return { structuredResponse: { events: [event({ what: "The score was recorded", eventType: "observation", sourceQuote: row })] } };
        }
        return { structuredResponse: systemPrompt.includes("FACT WORKER:") ? { facts: [] } : { claims: [] } };
      }),
    }));
    const { extractor, semaphore } = makeExtractor();

    const documents = await extractor.generateDocuments(source);

    expect(documents).toHaveLength(1);
    expect(documents[0].metadata.tags).toContain("factType:assessmentResult");
    expect(documents[0].metadata.tags).not.toContain("event");
    expect(semaphore.release).toHaveBeenCalledTimes(5);
  });

  it.each([
    ["assessment", "Casey completed the reading assessment.", { namespace: "education", value: "academicAssessment" }],
    ["conflict", "Casey and Jordan argued over their shared property.", { namespace: "legal", value: "propertyDispute" }],
    ["avoidance", "Casey deliberately avoided calls to evade payment of the invoice.", { namespace: "financial", value: "paymentAvoidance" }],
    ["accident", "Casey accidentally fell down the stairs.", { namespace: "medical", value: "fall" }],
    ["death", "Casey died.", { namespace: "medical", value: "death" }],
  ] as const)("retains a reviewed %s classification within the existing support pass", async (eventType, quote, facet) => {
    const source = new Document({ pageContent: quote, metadata: { pages: [1] } });
    const original = event({ what: quote, sourceQuote: quote, whenStartedYear: null });
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({
      invoke: vi.fn(async ({ messages }) => {
        if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
          const [candidate] = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
          expect(candidate.classificationIssues).toEqual([
            expect.stringContaining("Type is other"), expect.stringContaining("No domain facets"),
          ]);
          return { structuredResponse: { decisions: [{ candidateId: candidate.candidateId,
            verdict: "supported", corrections: [], keepOriginal: false, reason: "The source supports a specific occurrence category.",
            events: [{ ...original, eventType, facets: [facet] }],
            facts: [], claims: [] }] } };
        }
        return { structuredResponse: systemPrompt.includes("INDEPENDENT EXTRACTOR:")
          ? { events: [], facts: [], claims: [] }
          : systemPrompt.includes("EVENT WORKER:") ? { events: [original] }
          : systemPrompt.includes("FACT WORKER:") ? { facts: [] } : { claims: [] } };
      }),
    }));
    const { extractor, semaphore } = makeExtractor();

    const [document] = await extractor.generateDocuments(source);

    expect(document.metadata.tags).toEqual(["fact", "event", "eventType:" + eventType, `facet:${facet.namespace}:${facet.value}`]);
    expect(document.metadata.whenStarted.year).toBeNull();
    expect(document.metadata.sourceQuote).toBe(quote);
    expect(agentMocks.createAgent).toHaveBeenCalledTimes(5);
    expect(semaphore.release).toHaveBeenCalledTimes(5);
  });

  it("rejects an item found only in neighboring context and keeps its own page's extraction", async () => {
    const secondPage = "Meeting held on Friday.";
    const source = new Document({ pageContent: "Cover note.<!-- PageBreak -->" + secondPage,
      metadata: { pages: [1, 2], sourceId: "source-1" } });
    const meeting = event({ what: "A meeting was held on Friday.", whenStartedYear: null, sourceQuote: secondPage });
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({
      invoke: vi.fn(async ({ messages }) => {
        const [prompt, candidateText] = messages[0].content.split("\nCANDIDATES:\n");
        const page = JSON.parse(prompt).target.pageNumber;
        if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
          expect(systemPrompt).toContain("If its item appears only in precedingContext, followingContext");
          const candidates = JSON.parse(candidateText);
          return { structuredResponse: { decisions: candidates.map((candidate: { candidateId: string }) => ({
            candidateId: candidate.candidateId,
            verdict: page === 1 ? "unsupported" : "supported",
            corrections: [], keepOriginal: page !== 1,
            reason: page === 1 ? "Only the following page contains this meeting" : "",
            events: [], facts: [], claims: [],
          })) } };
        }
        if (systemPrompt.includes("INDEPENDENT EXTRACTOR:")) {
          return { structuredResponse: { events: [], facts: [], claims: [] } };
        }
        return { structuredResponse: systemPrompt.includes("EVENT WORKER:")
          ? { events: [meeting] } : systemPrompt.includes("FACT WORKER:") ? { facts: [] } : { claims: [] } };
      }),
    }));
    const { extractor, semaphore } = makeExtractor();

    const documents = await extractor.generateDocuments(source);

    expect(documents).toHaveLength(1);
    expect(documents[0].metadata.pages).toEqual([2]);
    expect(documents[0].metadata.sourceQuote).toBe(secondPage);
    expect(semaphore.acquire).toHaveBeenCalledTimes(semaphore.release.mock.calls.length);
  });

  it("rejects unresolved citations after repair instead of returning incomplete evidence", async () => {
    const invalid = event({ sourceQuote: "This quotation is absent." });
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({
      invoke: vi.fn(async () => {
        if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
          return { structuredResponse: { decisions: [{ candidateId: "1:0:candidate-0", verdict: "supported",
            corrections: [], keepOriginal: false, reason: "Still invalid", events: [invalid], facts: [], claims: [] }] } };
        }
        if (systemPrompt.includes("INDEPENDENT EXTRACTOR:")) return { structuredResponse: { events: [], facts: [], claims: [] } };
        return { structuredResponse: systemPrompt.includes("EVENT WORKER:") ? { events: [invalid] }
          : systemPrompt.includes("FACT WORKER:") ? { facts: [] } : { claims: [] } };
      }),
    }));
    const { extractor, semaphore } = makeExtractor();

    await expect(extractor.generateDocuments(source)).rejects.toThrow("Unresolved evidence remains");
    expect(semaphore.acquire).toHaveBeenCalledTimes(6);
    expect(semaphore.release).toHaveBeenCalledTimes(6);
  });

  it("omits unresolved candidates individually after the final rescue and preserves accepted evidence", async () => {
    const { extractor } = makeExtractor();
    const evidenceSource = new EvidenceSource(source);
    const window = evidenceSource.windows()[0];
    const valid = staticFact({ what: source.pageContent, sourceQuote: source.pageContent });
    const span = evidenceSource.locate(window, valid.sourceQuote)!;
    const accepted = { events: [], facts: [{ item: valid, ...span, sourceSpans: [span], extractedBy: ["primary"] }], claims: [] };
    const invalidCandidate = { id: "invalid-citation", kind: "event", item: event({ sourceQuote: "Absent quotation." }),
      extractedBy: ["primary"] };
    const validCitationCandidate = { id: "unresolved-support", kind: "fact", item: valid,
      extractedBy: ["primary"] };
    const plan = (pending: unknown[]) => ({ accepted, pending, escalated: [], dateCandidates: [],
      classificationCandidates: [], attributionCandidates: [] });
    const complete = (pending: unknown[], omitUnresolvedCandidates: boolean) =>
      (extractor as any).reviewer.completeReconciliationPlan(plan(pending), evidenceSource, window, "test",
        (extractor as any).reconciliationRescue, false, undefined, "defer", omitUnresolvedCandidates);
    vi.mocked(telemetryClient!.trackEvent).mockClear();

    await expect(complete([invalidCandidate], false)).rejects.toThrow("Unresolved evidence remains");
    expect(telemetryClient!.trackEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      name: "evidenceExtractor.candidateRejected",
    }));

    const result = await complete([invalidCandidate, validCitationCandidate], true);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].item.sourceQuote).toBe(source.pageContent);
    expect(telemetryClient!.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "evidenceExtractor.candidateRejected",
      properties: expect.objectContaining({ candidateId: "invalid-citation", reason: "citation-unresolved-after-rescue" }),
    }));
    expect(telemetryClient!.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "evidenceExtractor.candidateRejected",
      properties: expect.objectContaining({ candidateId: "unresolved-support", reason: "review-unresolved-after-rescue" }),
    }));
  });

  it("gives the reviewer match offsets and surrounding text to repair a repeated quote", async () => {
    const text = "First context repeated phrase. Second context repeated phrase.";
    const document = new Document({ pageContent: text, metadata: { pages: [1] } });
    const ambiguous = event({ sourceQuote: "repeated phrase.", what: "A phrase occurred.",
      whenStartedYear: null, whenEndedYear: null });
    const corrected = { ...ambiguous, sourceQuote: "First context repeated phrase." };
    let reviews = 0;
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({
      invoke: vi.fn(async ({ messages }) => {
        if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
          reviews++;
          const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
          const errors = candidates[0].citationErrors.join(" ");
          expect(errors).toContain("matched 2 passages");
          expect(errors).toContain("zero-based offsets");
          expect(errors).toContain("First context");
          expect(errors).toContain("Second context");
          if (reviews === 2) expect(candidates[0].feedback).toContain("matched 2 passages");
          return { structuredResponse: { decisions: [{ candidateId: candidates[0].candidateId,
            verdict: "supported", corrections: [], keepOriginal: reviews === 1, reason: reviews === 1 ? "" : "Unique citation",
            events: reviews === 1 ? [] : [corrected], facts: [], claims: [],
          }] } };
        }
        if (systemPrompt.includes("EVENT WORKER:")) return { structuredResponse: { events: [ambiguous] } };
        return { structuredResponse: systemPrompt.includes("INDEPENDENT EXTRACTOR:")
          ? { events: [], facts: [], claims: [] } : systemPrompt.includes("FACT WORKER:") ? { facts: [] } : { claims: [] } };
      }),
    }));

    const documents = await makeExtractor().extractor.generateDocuments(document);
    expect(reviews).toBe(2);
    expect(documents).toHaveLength(1);
    expect(documents[0].metadata.sourceQuote).toBe("First context repeated phrase.");
  });

  it("accepts a short citation choice without a second model invocation or an arbitrary occurrence", async () => {
    const text = "## Discussed\n\n- Daily reading.\n\n## Agreed Upon\n\n- Daily reading.";
    const document = new Document({pageContent: text,metadata:{pages:[1]}});
    const original = event({what:"Daily reading was agreed upon.",sourceQuote:"- Daily reading."});
    agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const [candidate] = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        expect(candidate.citationChoices).toHaveLength(2);
        expect(systemPrompt).toContain("do not select arbitrarily");
        return {structuredResponse:{decisions:[{candidateId:candidate.candidateId,verdict:"supported",keepOriginal:false,
          reason:"The second occurrence is under Agreed Upon.",corrections:[correction("sourceQuote",{text:candidate.citationChoices[1].id})],events:[],facts:[],claims:[]}]}};
      }
      return {structuredResponse:systemPrompt.includes("EVENT WORKER:")?{events:JSON.parse(messages[0].content).target.text.includes("Agreed Upon")?[original]:[]}
        :systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}:systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[]}};
    })}));
    const {extractor,semaphore}=makeExtractor();
    const [result]=await extractor.generateDocuments(document);
    expect(result.metadata.sourceQuote).not.toContain("cite:");
    expect(result.metadata.what).toBe(original.what);
    expect(text.slice(result.metadata.sourceOffset,result.metadata.sourceOffset+result.metadata.sourceQuote.length)).toBe(result.metadata.sourceQuote);
    expect(semaphore.acquire).toHaveBeenCalledTimes(5);
    expect(semaphore.release).toHaveBeenCalledTimes(5);
  });

  it.each(["event", "fact", "claim"])("repairs a misquoted %s using a selected source passage, including kind changes", async kind => {
    const exact = "I asked how he knew she lied to the court but he did not answer my question.";
    const misquoted = exact.replace("I asked how", "I asked him how");
    const document = new Document({pageContent: exact, metadata: {pages: [16]}});
    const original = kind === "event" ? event({sourceQuote: misquoted})
      : kind === "fact" ? staticFact({sourceQuote: misquoted}) : claim({sourceQuote: misquoted});
    let reviews = 0;
    agentMocks.createAgent.mockImplementation(({systemPrompt}) => ({invoke: vi.fn(async ({messages}) => {
      if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        reviews++;
        const [candidate] = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        expect(candidate.item.sourceQuote).toBe(misquoted);
        expect(candidate.citationErrors.join(" ")).toContain("was not found on source page 16");
        expect(candidate.citationChoices).toHaveLength(1);
        expect(candidate.citationChoices[0].sourceQuote).toBe(exact);
        expect(systemPrompt).toContain("A close wording match alone never establishes support");
        return {structuredResponse: {decisions: [{candidateId: candidate.candidateId, verdict: "supported", keepOriginal: false,
          reason: "The source records an unanswered question; remove the added word from the citation.", corrections: [],
          events: [event({what: "The interviewer asked a question and received no answer.", eventType: "communication",
            sourceQuote: candidate.citationChoices[0].id})], facts: [], claims: []}]}};
      }
      return {structuredResponse: systemPrompt.includes("INDEPENDENT EXTRACTOR:") ? {events: [], facts: [], claims: []}
        : systemPrompt.includes("EVENT WORKER:") ? {events: kind === "event" ? [original] : []}
          : systemPrompt.includes("FACT WORKER:") ? {facts: kind === "fact" ? [original] : []} : {claims: kind === "claim" ? [original] : []}};
    })}));
    const {extractor, semaphore} = makeExtractor();
    const [result] = await extractor.generateDocuments(document);
    expect(reviews).toBe(1);
    expect(result.metadata.sourceQuote).toBe(exact);
    expect(result.metadata.pages).toEqual([16]);
    expect(result.metadata.what).toBe("The interviewer asked a question and received no answer.");
    expect(semaphore.acquire).toHaveBeenCalledTimes(semaphore.release.mock.calls.length);
  });

  it("still fails when a reviewer keeps an invalid quote despite available repair choices", async () => {
    const exact = "The witness said that the delivery happened on Monday morning.";
    const document = new Document({pageContent: exact, metadata: {pages: [1]}});
    const original = event({sourceQuote: exact.replace("Monday", "Tuesday")});
    let reviews = 0;
    agentMocks.createAgent.mockImplementation(({systemPrompt}) => ({invoke: vi.fn(async ({messages}) => {
      if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        reviews++;
        const [candidate] = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        expect(candidate.citationChoices).toHaveLength(1);
        return {structuredResponse: {decisions: [{candidateId: candidate.candidateId, verdict: "supported", keepOriginal: true,
          reason: "", corrections: [], events: [], facts: [], claims: []}]}};
      }
      return {structuredResponse: systemPrompt.includes("EVENT WORKER:") ? {events: [original]}
        : systemPrompt.includes("INDEPENDENT EXTRACTOR:") ? {events: [], facts: [], claims: []}
          : systemPrompt.includes("FACT WORKER:") ? {facts: []} : {claims: []}};
    })}));
    await expect(makeExtractor().extractor.generateDocuments(document)).rejects.toThrow("Unresolved evidence remains");
    expect(reviews).toBe(2);
  });

  it("retains semantic corrections when a citation needs another repair", async () => {
    const original=claim({sourceQuote:source.pageContent,claimant:"Unknown"});
    let reviews=0;
    agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const [candidate]=JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        reviews++;
        if(reviews===2)expect(candidate.item.claimant).toBe("Jane");
        return {structuredResponse:{decisions:[{candidateId:candidate.candidateId,verdict:"supported",keepOriginal:false,
          reason:"Citation repair",corrections:reviews===1?[correction("claimant",{text:"Jane"}),correction("sourceQuote",{text:"Absent quote"})]
            :[correction("sourceQuote",{text:source.pageContent})],events:[],facts:[],claims:[]}]}};
      }
      return {structuredResponse:systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}
        :systemPrompt.includes("EVENT WORKER:")?{events:[]}:systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[original]}};
    })}));
    const {extractor,semaphore}=makeExtractor();
    const [document]=await extractor.generateDocuments(source);
    expect(document.metadata.claimant).toBe("Jane");
    expect(semaphore.acquire).toHaveBeenCalledTimes(6);
    expect(semaphore.release).toHaveBeenCalledTimes(6);
  });

  it.each([true, false])("repairs invalid citation-choice IDs through fallback without weakening validation: %s", enabled => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", enabled ? "independent" : "off");
    agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const candidates=JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        const fallback=!!candidates[0].feedback?.includes("Independently");
        return {structuredResponse:{decisions:candidates.map((c:any)=>({candidateId:c.candidateId,verdict:"supported",keepOriginal:fallback,
          reason:fallback?"":"Invalid choice",corrections:fallback?[]:[correction("sourceQuote",{text:"cite:support:6:0"})],events:[],facts:[],claims:[]}))}};
      }
      return {structuredResponse:systemPrompt.includes("EVENT WORKER:")?{events:[event({sourceQuote:source.pageContent})]}
        :systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}:systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[]}};
    })}));
    const {extractor,semaphore}=makeExtractor();
    return (async()=>{
      if(enabled){const [doc]=await extractor.generateDocuments(source);expect(doc.metadata.sourceQuote).toBe(source.pageContent);}
      else await expect(extractor.generateDocuments(source)).rejects.toThrow("Unresolved evidence");
      expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
    })();
  });

  it.each(["unsupported", "unresolved", "clearedDate"])("sends only %s exceptions to the independent fallback", async verdict => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME","recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK","independent");
    const original=event({sourceQuote:source.pageContent});
    let reviews=0;
    agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const candidates=JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        const isFallback=!!candidates[0].feedback?.includes("Independently");
        reviews++;
        return {structuredResponse:{decisions:candidates.map((c:any)=>({candidateId:c.candidateId,
          verdict:isFallback?"supported":verdict==="clearedDate"?"supported":verdict,
          keepOriginal:isFallback,reason:isFallback?"":"Needs independent review",
          corrections:!isFallback&&verdict==="clearedDate"?[correction("whenStartedYear")]:[],events:[],facts:[],claims:[]}))}};
      }
      return {structuredResponse:systemPrompt.includes("EVENT WORKER:")?{events:[original]}
        :systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}:systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[]}};
    })}));
    const {extractor,semaphore}=makeExtractor();
    const [doc]=await extractor.generateDocuments(source);
    expect(doc.metadata.whenStarted.year).toBe("2020");
    expect(doc.metadata.extractedBy).toContain("reconciliation:research-gpt-6.1-sol");
    expect(reviews).toBe(verdict==="unresolved"?3:2);
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it("still fails when the independent fallback cannot resolve an exception", async () => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME","recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK","independent");
    agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const candidates=JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        return {structuredResponse:{decisions:candidates.map((c:any)=>({candidateId:c.candidateId,verdict:"unresolved",keepOriginal:false,
          reason:"Cannot resolve",corrections:[],events:[],facts:[],claims:[]}))}};
      }
      return {structuredResponse:systemPrompt.includes("EVENT WORKER:")?{events:[event({sourceQuote:source.pageContent})]}
        :systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}:systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[]}};
    })}));
    const {extractor,semaphore}=makeExtractor();
    await expect(extractor.generateDocuments(source)).rejects.toThrow("Unresolved evidence");
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it.each([true, false])("reviews boundary evidence before rejection without auto-accepting it: %s", supported => {
    return (async () => {
      vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME","recon-test-gpt-6-luna");
      vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK","independent");
      const before="The assessment score was 129 and ", after="the percentile was 97.";
      const document=new Document({pageContent:before+"<!-- PageBreak -->"+after});
      let fallbackCalls=0, reviewCalls=0;
      agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
        if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
          reviewCalls++;
          const candidates=JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
          const independent=candidates[0].feedback?.includes("Independently");
          if(independent){fallbackCalls++;expect(candidates[0].boundaryContext[0].target.sourceQuote).toBe(after);}
          return {structuredResponse:{decisions:candidates.map((candidate:any)=>({candidateId:candidate.candidateId,
            verdict:independent&&supported?"supported":"unsupported",keepOriginal:false,reason:"Review the boundary fragments",
            corrections:independent&&supported?[correction("sourceQuote",{text:after}),
              correction("supportingQuotes",{supportingQuotes:[{pageNumber:1,quote:before}]})]:[],events:[],facts:[],claims:[]}))}};
        }
        const page=JSON.parse(messages[0].content).target.pageNumber;
        return {structuredResponse:systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}
          :systemPrompt.includes("EVENT WORKER:")?{events:[]}:systemPrompt.includes("FACT WORKER:")
            ?{facts:page===2?[staticFact({what:"The score was 129, at the 97th percentile.",sourceQuote:before+after})]:[]}:{claims:[]}};
      })}));
      const {extractor,semaphore}=makeExtractor();
      const docs=await extractor.generateDocuments(document);
      expect(docs).toHaveLength(supported?1:0);
      if(supported)expect(docs[0].metadata.sourceSpans.map((span:any)=>span.pageNumber)).toEqual([2,1]);
      expect(fallbackCalls).toBe(1);
      expect(reviewCalls).toBe(supported?2:3);
      expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
    })();
  });

  it.each(["claim", "event", "failure"])("reviews questionable events before date lookup: %s", outcome => {
    return (async()=>{
      vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME","recon-test-gpt-6-luna");
      vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK","independent");
      const text="When tasks are challenging, Casey will say, 'I cannot do that.'";
      const document=new Document({pageContent:text});
      const original=undatedEvent(text);original.sourceQuote=text;
      const order:string[]=[];
      agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
        if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
          const candidates=JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
          const independent=candidates[0].feedback?.includes("Independently");
          if(independent){order.push("classification");if(outcome==="failure")throw new Error("Classification reviewer unavailable");}
          return {structuredResponse:{decisions:candidates.map((candidate:any)=>({candidateId:candidate.candidateId,
            verdict:"supported",keepOriginal:!independent||outcome==="event",reason:independent&&outcome==="claim"?"Habitual behavior is an attributed assertion":"",
            corrections:[],events:[],facts:[],claims:independent&&outcome==="claim"?[claim({statement:text,sourceQuote:text})]:[]}))}};
        }
        if(systemPrompt.includes("EVENT DATE RESOLVER:")) {
          order.push("dates");const request=JSON.parse(messages[0].content);
          return {structuredResponse:{decisions:request.candidates.map((c:any)=>dateDecision(c.candidateId))}};
        }
        return {structuredResponse:systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}
          :systemPrompt.includes("EVENT WORKER:")?{events:[original]}:systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[]}};
      })}));
      const {extractor,semaphore}=makeExtractor();
      if(outcome==="failure")await expect(extractor.generateDocuments(document)).rejects.toThrow("Classification reviewer unavailable");
      else {
        const [doc]=await extractor.generateDocuments(document);
        expect(doc.metadata.tags).toContain(outcome === "event" ? "fact" : outcome);
        if (outcome === "event") {
          expect(doc.metadata.factType).toBe("undatedOccurrence");
          expect(doc.metadata.tags).not.toContain("event");
        }
        expect(order).toEqual(outcome==="claim"?["classification"]:["classification","dates"]);
      }
      expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
    })();
  });

  it("falls back for an invalid reconciliation response without accepting invalid evidence", async () => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME","recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK","independent");
    agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const candidates=JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        if(!candidates[0].feedback?.includes("Independently"))return {structuredResponse:undefined};
        return {structuredResponse:{decisions:candidates.map((c:any)=>({candidateId:c.candidateId,verdict:"supported",keepOriginal:true,
          reason:"",corrections:[],events:[],facts:[],claims:[]}))}};
      }
      return {structuredResponse:systemPrompt.includes("EVENT WORKER:")?{events:[event({sourceQuote:source.pageContent})]}
        :systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}:systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[]}};
    })}));
    const {extractor,semaphore}=makeExtractor();
    const [doc]=await extractor.generateDocuments(source);
    expect(doc.metadata.extractedBy).toContain("reconciliation:research-gpt-6.1-sol");
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it.each(["missing", "duplicate", "unexpected", "inconsistent"])("routes %s review decisions to fallback and accounts for every candidate", async failure => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "independent");
    const reviewedIds: string[][] = [];
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({ invoke: vi.fn(async ({ messages }) => {
      if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        const fallback = !!candidates[0].feedback?.includes("Independently");
        const decisions = candidates.map((c: any) => ({ candidateId: c.candidateId, verdict: "supported", keepOriginal: true,
          reason: "", corrections: [], events: [], facts: [], claims: [] }));
        if (fallback) reviewedIds.push(candidates.map((c: any) => c.candidateId));
        else if (failure === "missing") decisions.pop();
        else if (failure === "duplicate") decisions.push(decisions[0]);
        else if (failure === "unexpected") decisions[0].candidateId = "invented-id";
        else decisions[0].keepOriginal = false;
        return { structuredResponse: { decisions } };
      }
      return { structuredResponse: systemPrompt.includes("EVENT WORKER:") ? { events: [event({ sourceQuote: source.pageContent })] }
        : systemPrompt.includes("INDEPENDENT EXTRACTOR:") ? { events: [], facts: [], claims: [] }
        : systemPrompt.includes("FACT WORKER:") ? { facts: [] } : { claims: [] } };
    }) }));
    const { extractor, semaphore } = makeExtractor();
    const [doc] = await extractor.generateDocuments(source);
    expect(doc.metadata.extractedBy).toContain("reconciliation:research-gpt-6.1-sol");
    expect(reviewedIds).toEqual([["1:0:candidate-0"]]);
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it("fails and releases permits when fallback also omits a review decision", async () => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "independent");
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({ invoke: vi.fn(async () => {
      if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) return { structuredResponse: { decisions: [] } };
      return { structuredResponse: systemPrompt.includes("EVENT WORKER:") ? { events: [event({ sourceQuote: source.pageContent })] }
        : systemPrompt.includes("INDEPENDENT EXTRACTOR:") ? { events: [], facts: [], claims: [] }
        : systemPrompt.includes("FACT WORKER:") ? { facts: [] } : { claims: [] } };
    }) }));
    const { extractor, semaphore } = makeExtractor();
    await expect(extractor.generateDocuments(source)).rejects.toThrow("Reconciliation must account for every candidate exactly once");
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it("sends malformed compact corrections to fallback without accepting invalid fields", async () => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME","recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK","independent");
    agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const candidates=JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        const fallback=!!candidates[0].feedback?.includes("Independently");
        return {structuredResponse:{decisions:candidates.map((c:any)=>({candidateId:c.candidateId,verdict:"supported",keepOriginal:fallback,
          reason:fallback?"":"Invalid people payload",corrections:fallback?[]:[correction("who",{text:"Jane",people:["Jane"]})],events:[],facts:[],claims:[]}))}};
      }
      return {structuredResponse:systemPrompt.includes("EVENT WORKER:")?{events:[event({sourceQuote:source.pageContent})]}
        :systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}:systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[]}};
    })}));
    const {extractor,semaphore}=makeExtractor();
    const [doc]=await extractor.generateDocuments(source);
    expect(doc.metadata.who).toEqual(event().who);
    expect(doc.metadata.extractedBy).toContain("reconciliation:research-gpt-6.1-sol");
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it("recovers valid rows from a provider parsing failure and escalates only the malformed candidate", async () => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "independent");
    const fallbackIds: string[][] = [];
    agentMocks.createAgent.mockImplementation(({systemPrompt}) => ({invoke: vi.fn(async ({messages}, options) => {
      if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        const decisions = candidates.map((candidate: any) => ({candidateId:candidate.candidateId,
          verdict:"supported",keepOriginal:true,reason:"",corrections:[],events:[],facts:[],claims:[]}));
        if (candidates[0].feedback?.includes("Independently")) {
          fallbackIds.push(candidates.map((candidate: any) => candidate.candidateId));
          return {structuredResponse:{decisions}};
        }
        decisions[1] = {...decisions[1],keepOriginal:false,reason:"Malformed replacement",events:[event({where:123 as any})]};
        for (const callback of options.callbacks ?? []) await callback.handleLLMEnd?.({generations:[[{message:{
          content:JSON.stringify({decisions}),response_metadata:{finish_reason:"stop"},
        }}]]}, "raw-response");
        throw new StructuredOutputParsingError("extract", ["Model output did not satisfy the provided response schema."]);
      }
      return {structuredResponse:systemPrompt.includes("EVENT WORKER:")
        ? {events:[event({what:"First occurrence",sourceQuote:source.pageContent}),event({what:"Second occurrence",sourceQuote:source.pageContent})]}
        : systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}
          :systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[]}};
    })}));
    const {extractor,semaphore} = makeExtractor();
    const docs = await extractor.generateDocuments(source);
    expect(docs).toHaveLength(2);
    expect(fallbackIds).toEqual([["1:0:candidate-1"]]);
    expect(docs.find(doc=>doc.metadata.what==="First occurrence")!.metadata.extractedBy)
      .not.toContain("reconciliation:research-gpt-6.1-sol");
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it.each(["missing", "duplicate", "inconsistent"])("retains a valid neighboring decision when one candidate is %s", async failure => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME","recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK","independent");
    const fallbackIds: string[][]=[];
    agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const candidates=JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        const decisions=candidates.map((candidate:any)=>({candidateId:candidate.candidateId,verdict:"supported",
          keepOriginal:true,reason:"",corrections:[],events:[],facts:[],claims:[]}));
        if(candidates[0].feedback?.includes("Independently"))fallbackIds.push(candidates.map((candidate:any)=>candidate.candidateId));
        else if(failure==="missing")decisions.pop();
        else if(failure==="duplicate")decisions.push(decisions[1]);
        else decisions[1].keepOriginal=false;
        return {structuredResponse:{decisions}};
      }
      return {structuredResponse:systemPrompt.includes("EVENT WORKER:")?{events:[
        event({what:"First",sourceQuote:source.pageContent}),event({what:"Second",sourceQuote:source.pageContent})]}
        :systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}
          :systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[]}};
    })}));
    const docs=await makeExtractor().extractor.generateDocuments(source);
    expect(docs).toHaveLength(2);
    expect(fallbackIds).toEqual([["1:0:candidate-1"]]);
  });

  it("supplies cited attribution context without automatically assigning the document author", async () => {
    const document=new Document({pageContent:source.pageContent+"<!-- PageBreak -->Author: Dr. North.\n\nMother reported that Casey was tired."});
    agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const [context,candidateText]=messages[0].content.split("\nCANDIDATES:\n");
        expect(JSON.parse(context).citedContext.some((passage:any)=>passage.sourceQuote.includes("Author: Dr. North."))).toBe(true);
        const candidates=JSON.parse(candidateText);
        expect(candidates[0].item.claimant).toBe("Unknown");
        return {structuredResponse:{decisions:candidates.map((candidate:any)=>({candidateId:candidate.candidateId,
          verdict:"supported",keepOriginal:true,reason:"",corrections:[],events:[],facts:[],claims:[]}))}};
      }
      const page=JSON.parse(messages[0].content).target.pageNumber;
      return {structuredResponse:systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}
        :systemPrompt.includes("EVENT WORKER:")?{events:[]}:systemPrompt.includes("FACT WORKER:")?{facts:[]}
          :{claims:page===1?[claim({claimant:"Unknown",sourceQuote:source.pageContent})]:[]}};
    })}));
    const [doc]=await makeExtractor().extractor.generateDocuments(document);
    expect(doc.metadata.claimant).toBe("Unknown");
  });

  it.each(["resolved","unknown","invalidCitation","failure","disabled"])("reviews generic attribution through agent invocation: %s", async outcome => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME","recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK",outcome==="disabled"?"off":"independent");
    const identity="Examiner: Dr. North.";
    const quote="Extra time may help Casey.";
    const document=new Document({pageContent:identity+"<!-- PageBreak -->"+quote});
    const original=claim({statement:quote,sourceQuote:quote,claimant:"Document author",polarity:"uncertain"});
    let attributionCalls=0;
    agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
      if(systemPrompt.includes("CLAIM ATTRIBUTION RESOLVER:")) {
        attributionCalls++;
        if(outcome==="failure")throw new Error("Attribution unavailable");
        const request=JSON.parse(messages[0].content);
        expect(request.attributionContext.some((p:any)=>p.sourceQuote===identity)).toBe(true);
        expect(request.candidates[0].statement).toBe(quote);
        return {structuredResponse:{decisions:request.candidates.map((c:any)=>({candidateId:c.candidateId,
          status:outcome==="unknown"?"unknown":"resolved",claimant:outcome==="unknown"?"":"Dr. North",
          explanation:"Reviewed the speaker and report identity.",
          supportingQuotes:outcome==="unknown"?[]:[{pageNumber:outcome==="invalidCitation"?2:1,quote:identity}]}))}};
      }
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const [context,raw]=messages[0].content.split("\nCANDIDATES:\n");
        expect(JSON.parse(context).attributionContext.some((p:any)=>p.sourceQuote===identity)).toBe(true);
        return {structuredResponse:{decisions:JSON.parse(raw).map((c:any)=>({candidateId:c.candidateId,verdict:"supported",
          keepOriginal:true,reason:"",corrections:[],events:[],facts:[],claims:[]}))}};
      }
      const page=JSON.parse(messages[0].content).target.pageNumber;
      return {structuredResponse:systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}
        :systemPrompt.includes("EVENT WORKER:")?{events:[]}:systemPrompt.includes("FACT WORKER:")?{facts:[]}
          :{claims:page===2?[original]:[]}};
    })}));
    const {extractor,semaphore}=makeExtractor();
    if(outcome==="failure")await expect(extractor.generateDocuments(document)).rejects.toThrow();
    else {
      const [doc]=await extractor.generateDocuments(document);
      expect(doc.metadata.claimant).toBe(outcome==="resolved"?"Dr. North":outcome==="invalidCitation"?"Unknown":"Document author");
      expect(doc.metadata.what).toBe(quote);
      expect(doc.metadata.claimPolarity).toBe("uncertain");
      if(outcome==="resolved")expect(doc.metadata.sourceSpans.map((s:any)=>s.pageNumber)).toEqual([2,1]);
    }
    // Invalid decisions get a repair on each reviewer; an API failure goes
    // directly to the component's independent failover.
    expect(attributionCalls).toBe(outcome==="disabled"?0:outcome==="invalidCitation"?4:outcome==="failure"?2:1);
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it.each(["off", "skills", "failure"])("reviews named nested attribution only in skill mode: %s", async mode => {
    vi.stubEnv("EVIDENCE_SPECIALIST_MODE", mode === "failure" ? "skills" : mode);
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "independent");
    const text = "Priya stated that the supervisor instructed the crew to leave.";
    const original = claim({claimant:"supervisor", statement:"The supervisor instructed the crew to leave.",
      sourceQuote:"the supervisor instructed the crew to leave."});
    let reviews = 0;
    agentMocks.createAgent.mockImplementation(({systemPrompt, middleware}) => ({invoke:vi.fn(async ({messages}) => {
      if (systemPrompt.includes("CLAIM ATTRIBUTION RESOLVER:")) {
        reviews++;
        expect(middleware.map((m:any) => m.name)).toEqual(["FilesystemMiddleware", "SkillsMiddleware"]);
        expect(systemPrompt).toContain("Required procedure already loaded: claim-attribution");
        if (mode === "failure") throw new Error("Specialist unavailable");
        return {structuredResponse:{decisions:JSON.parse(messages[0].content).candidates.map((c:any) => ({
          candidateId:c.candidateId,status:"resolved",claimant:"Priya",explanation:"Priya reports the alleged instruction.",
          supportingQuotes:[{pageNumber:1,quote:text}],
        }))}};
      }
      expect(middleware).toBeUndefined();
      if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) return {structuredResponse:{decisions:
        JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]).map((c:any) => ({candidateId:c.candidateId,
          verdict:"supported",keepOriginal:true,reason:"",corrections:[],events:[],facts:[],claims:[]}))}};
      return {structuredResponse:systemPrompt.includes("INDEPENDENT EXTRACTOR:") ? {events:[],facts:[],claims:[]}
        : systemPrompt.includes("EVENT WORKER:") ? {events:[]} : systemPrompt.includes("FACT WORKER:") ? {facts:[]} : {claims:[original]}};
    })}));
    const {extractor,semaphore} = makeExtractor();
    const document = new Document({pageContent:text,metadata:{pages:[1]}});
    if (mode === "failure") await expect(extractor.generateDocuments(document)).rejects.toThrow("Specialist unavailable");
    else {
      const [output] = await extractor.generateDocuments(document);
      expect(output.metadata.claimant).toBe(mode === "skills" ? "Priya" : "supervisor");
      expect(output.metadata.what).toBe(original.statement);
      if (mode === "skills") expect(output.metadata.sourceSpans.some((span:any) => span.sourceQuote === text)).toBe(true);
    }
    expect(reviews).toBe(mode === "off" ? 0 : mode === "failure" ? 2 : 1);
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it("includes specialist mode and skill resources in checkpoint identity", async () => {
    const store = {get:vi.fn(),put:vi.fn(),delete:vi.fn()};
    const source = new EvidenceSource(new Document({pageContent:"Evidence."}));
    vi.stubEnv("EVIDENCE_SPECIALIST_MODE", "off");
    const original = await (makeExtractor(store).extractor as any).checkpointIdentity(source);
    vi.stubEnv("EVIDENCE_SPECIALIST_MODE", "skills");
    const specialist = await (makeExtractor(store).extractor as any).checkpointIdentity(source);
    expect(original.runFingerprint).not.toBe(specialist.runFingerprint);
  });

  it("keeps a validated claimant when a neighboring attribution remains unresolved", async () => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME","recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK","independent");
    const identity="Author: Dr. North.",quote="Extra time may help Casey.";
    const document=new Document({pageContent:identity+"\n\n"+quote});
    const original=claim({statement:quote,sourceQuote:quote,claimant:"Report author"});
    const visits:string[][]=[];
    let extractions=0;
    agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
      if(systemPrompt.includes("CLAIM ATTRIBUTION RESOLVER:")) {
        const request=JSON.parse(messages[0].content);visits.push(request.candidates.map((c:any)=>c.candidateId));
        return {structuredResponse:{decisions:request.candidates.map((c:any)=>({candidateId:c.candidateId,status:"resolved",
          claimant:c.candidateId.includes("candidate-1")?"Missing person":"Dr. North",explanation:"Author's own recommendation.",
          supportingQuotes:[{pageNumber:1,quote:identity}]}))}};
      }
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:"))return {structuredResponse:{decisions:
        JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]).map((c:any)=>({candidateId:c.candidateId,verdict:"supported",
          keepOriginal:true,reason:"",corrections:[],events:[],facts:[],claims:[]}))}};
      extractions++;
      return {structuredResponse:systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}
        :systemPrompt.includes("EVENT WORKER:")?{events:[]}:systemPrompt.includes("FACT WORKER:")?{facts:[]}
          :{claims:[original,{...original,statement:"Casey may benefit from extra time."}]}};
    })}));
    const {store}=stageStore();
    const docs=await makeExtractor(store).extractor.generateDocuments(document);
    expect(docs).toHaveLength(2);
    expect(docs.map(doc=>doc.metadata.claimant).sort()).toEqual(["Dr. North","Unknown"]);
    expect(extractions).toBe(4);
    expect(visits.map(ids=>ids.length)).toEqual([2,1,2,1]);
    expect(visits[3][0]).toContain("candidate-1");
  });

  it.each(["recovers","disabled","fallbackFails","apiFailure"])("bounds review-loop fallback and releases permits: %s", async outcome => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME","recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK",outcome==="disabled"?"off":"independent");
    let reviewCalls=0,fallbackCalls=0;
    agentMocks.createAgent.mockImplementation(({systemPrompt,responseFormat})=>({invoke:vi.fn(async({messages})=>{
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        reviewCalls++;
        expect(responseFormat[0].options.handleError).toBe(false);
        const candidates=JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        if(candidates[0].feedback?.includes("Independently")) {
          fallbackCalls++;
          if(outcome==="fallbackFails")throw new GraphRecursionError("Fallback step limit");
          return {structuredResponse:{decisions:candidates.map((c:any)=>({candidateId:c.candidateId,verdict:"supported",
            keepOriginal:true,reason:"",corrections:[],events:[],facts:[],claims:[]}))}};
        }
        if(outcome==="apiFailure")throw new Error("API unavailable");
        throw new GraphRecursionError("Reconciliation step limit");
      }
      return {structuredResponse:systemPrompt.includes("EVENT WORKER:")?{events:[event({sourceQuote:source.pageContent})]}
        :systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}:systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[]}};
    })}));
    const {extractor,semaphore}=makeExtractor();
    if(outcome==="recovers")await expect(extractor.generateDocuments(source)).resolves.toHaveLength(1);
    else await expect(extractor.generateDocuments(source)).rejects.toThrow();
    expect(fallbackCalls).toBe(["recovers","fallbackFails"].includes(outcome)?1:0);
    expect(reviewCalls).toBe(outcome==="apiFailure"?2:fallbackCalls+1);
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it.each(["invalid-enum", "omitted-lists", "missing-replacement", "explicit-null", "contradiction"])(
    "recovers valid review rows without retrying omitted empty lists: %s", async outcome => {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME","recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK","independent");
    const fallbackIds:string[][]=[];
    let lunaCalls=0;
    agentMocks.createAgent.mockImplementation(({systemPrompt,responseFormat})=>({invoke:vi.fn(async({messages},options)=>{
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const candidates=JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        const decisions=candidates.map((c:any)=>({candidateId:c.candidateId,verdict:"supported",keepOriginal:true,
          reason:"",corrections:[],events:[],facts:[],claims:[]}));
        if(candidates[0].feedback?.includes("Independently")) {
          fallbackIds.push(candidates.map((c:any)=>c.candidateId));return {structuredResponse:{decisions}};
        }
        lunaCalls++;
        for (const decision of decisions) for (const key of ["corrections", "events", "facts", "claims"]) delete decision[key];
        if (outcome === "invalid-enum") decisions[1].verdict="invalid-enum";
        if (outcome === "missing-replacement") Object.assign(decisions[1], {keepOriginal:false,reason:"Correction needed"});
        if (outcome === "explicit-null") decisions[1].events=null;
        if (outcome === "contradiction") decisions[1].events=[event({sourceQuote:source.pageContent})];
        expect(responseFormat[0].options.handleError).toBe(false);
        for(const callback of options.callbacks)await callback.handleLLMEnd?.({generations:[[{message:{content:"",
          tool_calls:[{name:responseFormat[0].name,args:{decisions}}],response_metadata:{finish_reason:"tool_calls"}}}]]},"raw-tool");
        throw new StructuredOutputParsingError(responseFormat[0].name,["Invalid verdict"]);
      }
      return {structuredResponse:systemPrompt.includes("EVENT WORKER:")?{events:[event({sourceQuote:source.pageContent}),
        event({what:"Second occurrence",sourceQuote:source.pageContent})]}
        :systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}:systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[]}};
    })}));
    const {extractor,semaphore}=makeExtractor();
    await expect(extractor.generateDocuments(source)).resolves.toHaveLength(2);
    expect(lunaCalls).toBe(1);
    expect(fallbackIds).toEqual(outcome === "omitted-lists" ? [] : [["1:0:candidate-1"]]);
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  const emptyParts = () => ({year:"",month:"",day:"",season:"",quarter:""});
  const undatedEvent = (what = "Casey completed an assessment") => event({what,sourceQuote:source.pageContent,
    whenStartedYear:null,whenStartedMonth:null,whenStartedDay:null,whenStartedSeason:null,whenStartedQuarter:null,
    whenEndedYear:null,whenEndedMonth:null,whenEndedDay:null,whenEndedSeason:null,whenEndedQuarter:null});
  const dateDecision = (candidateId: string, overrides: Record<string,unknown> = {}) => ({candidateId,
    status:"unknown",relation:"unknown",start:emptyParts(),end:emptyParts(),qualifier:"",
    explanation:"No occurrence date was established in the examined passages.",supportingQuotes:[],...overrides});

  function dateAgents(originals: EventExtractionResponse[], resolve: (candidates: any[], options: any) => Promise<unknown>) {
    vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "recon-test-gpt-6-luna");
    vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "independent");
    const calls: string[][] = [];
    agentMocks.createAgent.mockImplementation(({systemPrompt,responseFormat})=>({invoke:vi.fn(async ({messages},options)=>{
      if (systemPrompt.includes("EVENT DATE RESOLVER:")) {
        const request = JSON.parse(messages[0].content);
        calls.push(request.candidates.map((candidate: any)=>candidate.candidateId));
        expect(jsonResponseFormat(responseFormat)).toEqual(toJsonSchema(EventDateResponseSchema));
        expect(request.candidates[0]).not.toHaveProperty("eventType");
        return {structuredResponse:await resolve(request.candidates,options)};
      }
      if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const candidates=JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        return {structuredResponse:{decisions:candidates.map((candidate: any)=>({candidateId:candidate.candidateId,
          verdict:"supported",keepOriginal:true,reason:"",corrections:[],events:[],facts:[],claims:[]}))}};
      }
      const page = JSON.parse(messages[0].content).target.pageNumber;
      return {structuredResponse:systemPrompt.includes("EVENT WORKER:")?{events:page===1?originals:[]}
        :systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}
          :systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[]}};
    })}));
    return calls;
  }

  it("recovers a partial date with cross-page citations while preserving all other event fields", async () => {
    const original = undatedEvent();
    const dateQuote = "Casey completed the assessment in March 2025.";
    const document = new Document({pageContent:source.pageContent+"<!-- PageBreak -->"+dateQuote});
    const calls = dateAgents([original],async candidates=>({decisions:candidates.map(candidate=>dateDecision(candidate.candidateId,{
      status:"dated",relation:"point",start:{...emptyParts(),year:"2025",month:"3"},
      explanation:"The assessment passage identifies March 2025.",supportingQuotes:[{pageNumber:2,quote:dateQuote}],
    }))}));
    const {extractor,semaphore}=makeExtractor();
    const [doc]=await extractor.generateDocuments(document);
    expect(calls).toHaveLength(1);
    expect(doc.metadata).toMatchObject({what:original.what,who:original.who,where:original.where,why:original.why,
      whenStarted:{year:"2025",month:"3",day:null},eventDateResolution:{relation:"point"}});
    expect(doc.metadata.sourceSpans).toHaveLength(2);
    expect(doc.pageContent).toContain("Event start date: March 2025");
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it.each(["dated", "unknown", "conflict", "invalid", "apiFailure", "fromFact"])(
    "runs bounded date resolution after fallback acceptance: %s", async outcome => {
      vi.stubEnv("EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME", "recon-test-gpt-6-luna");
      vi.stubEnv("EVIDENCE_RECONCILIATION_FALLBACK", "independent");
      vi.stubEnv("EVIDENCE_EVENT_STRUCTURE_MODE", "annotate");
      const quote = "Casey completed an assessment.";
      const identity = "Casey is Casey Cole.";
      const dateQuote = "Casey completed the assessment in March 2025.";
      const document = new Document({pageContent:quote + "\n\n" + identity + "<!-- PageBreak -->" + dateQuote});
      const original = {...undatedEvent(quote), sourceQuote:quote, who:["Casey Cole"],
        supportingQuotes:[{pageNumber:1,quote:identity},{pageNumber:1,quote:identity}],
        eventStructure:{trigger:"completed",roles:[{role:"actor" as const,participant:0,citations:[2]}]}};
      let dateCalls = 0, reviewCalls = 0;
      agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async ({messages})=>{
        if (systemPrompt.includes("EVENT DATE RESOLVER:")) {
          dateCalls++;
          expect(dateCalls).toBeLessThanOrEqual(outcome === "invalid" ? 2 : 1);
          if (outcome === "apiFailure") throw new Error("Date API unavailable");
          const candidates = JSON.parse(messages[0].content).candidates;
          return {structuredResponse:{decisions:candidates.map((c:any)=>dateDecision(c.candidateId,
            outcome === "conflict" ? {status:"conflict",explanation:"Conflicting session descriptions need review."}
              : outcome === "unknown" ? {} : {status:"dated",relation:"point",
                start:{...emptyParts(),year:"2025",month:"3"},
                supportingQuotes:[{pageNumber:2,quote:outcome === "invalid" ? "Absent quotation." : dateQuote}]}))}};
        }
        if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
          reviewCalls++;
          const candidates = JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
          if (!candidates[0].feedback?.includes("Independently")) {
            return {structuredResponse:{decisions:candidates.map((c:any)=>({candidateId:c.candidateId}))}};
          }
          if (reviewCalls === 2) expect(systemPrompt).toContain("dedicated date resolver");
          else expect(systemPrompt).not.toContain("dedicated date resolver");
          return {structuredResponse:{decisions:candidates.map((c:any)=>({candidateId:c.candidateId,
            verdict:"supported",keepOriginal:outcome !== "fromFact",reason:outcome === "fromFact" ? "This is a completed assessment." : "",
            corrections:[],events:outcome === "fromFact" ? [original] : [],facts:[],claims:[]}))}};
        }
        const page = JSON.parse(messages[0].content).target.pageNumber;
        return {structuredResponse:systemPrompt.includes("INDEPENDENT EXTRACTOR:") ? {events:[],facts:[],claims:[]}
          : systemPrompt.includes("EVENT WORKER:") ? {events:page === 1 && outcome !== "fromFact" ? [original] : []}
            : systemPrompt.includes("FACT WORKER:") ? {facts:page === 1 && outcome === "fromFact"
              ? [staticFact({what:quote,sourceQuote:quote})] : []} : {claims:[]}};
      })}));
      const {extractor,semaphore} = makeExtractor();
      if (outcome === "apiFailure") await expect(extractor.generateDocuments(document)).rejects.toThrow();
      else {
        const [doc] = await extractor.generateDocuments(document);
        expect(doc.metadata.what).toBe(quote);
        expect(doc.metadata.eventStructure.roles[0]).toMatchObject({role:"actor",participant:"Casey Cole"});
        const identitySpan = doc.metadata.sourceSpans.find((span:any)=>span.sourceQuote === identity);
        const citationId = "cite:" + createHash("sha256").update(JSON.stringify([
          identitySpan.pageNumber,identitySpan.sourceOffset,identitySpan.sourceQuote])).digest("hex");
        expect(doc.metadata.eventStructure.roles[0].citationIds).toEqual([citationId]);
        if (["dated", "fromFact"].includes(outcome)) {
          expect(doc.metadata.tags).toContain("event");
          expect(doc.metadata.whenStarted).toMatchObject({year:"2025",month:"3",day:null});
          expect(doc.pageContent).toContain("Event start date: March 2025");
        } else {
          expect(doc.metadata.tags).toContain("fact");
          expect(doc.metadata.tags).not.toContain("event");
          expect(doc.metadata.factType).toBe("undatedOccurrence");
          expect(doc.metadata.whenStarted.year).toBeNull();
          if (["unknown", "invalid"].includes(outcome)) {
            expect(doc.metadata.eventDateResolution.status).toBe("unknown");
            if (outcome === "invalid") expect(doc.metadata.eventDateResolution.explanation).toContain("did not produce a valid decision");
          } else expect(telemetryClient!.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
            name:"evidenceExtractor.eventDateConflictReviewed"}));
        }
      }
      expect(dateCalls).toBe(outcome === "invalid" ? 2 : 1);
      expect(reviewCalls).toBe(outcome === "conflict" ? 3 : 2);
      expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
    });

  it("retains uncertain bounds without storing or presenting them as actual duration", async () => {
    const quote="Sessions occurred July 18 and August 21, 2025; the specific assessment session is unknown.";
    const document=new Document({pageContent:source.pageContent+"\n\n"+quote});
    dateAgents([undatedEvent()],async candidates=>({decisions:candidates.map(candidate=>dateDecision(candidate.candidateId,{
      status:"dated",relation:"bounded",start:{...emptyParts(),year:"2025",month:"7",day:"18"},
      end:{...emptyParts(),year:"2025",month:"8",day:"21"},qualifier:"Specific assessment session unknown",
      explanation:"The occurrence is bounded by the two possible sessions.",supportingQuotes:[{pageNumber:1,quote}],
    }))}));
    const [doc]=await makeExtractor().extractor.generateDocuments(document);
    expect(doc.metadata.whenStarted.year).toBeNull();
    expect(doc.metadata.whenEnded).toBeNull();
    expect(doc.metadata.tags).toContain("event");
    expect(doc.pageContent).toContain("Earliest possible occurrence: 18 July 2025");
    expect(doc.pageContent).not.toContain("Event start date:");
  });

  it("reclassifies supported undated occurrences after an unsuccessful date search without a fallback loop", async () => {
    const original=undatedEvent();
    const calls=dateAgents([original],async candidates=>({decisions:candidates.map(candidate=>dateDecision(candidate.candidateId))}));
    const [doc]=await makeExtractor().extractor.generateDocuments(source);
    expect(calls).toHaveLength(1);
    expect(doc.metadata.what).toBe(original.what);
    expect(doc.metadata.whenStarted.year).toBeNull();
    expect(doc.metadata.eventDateResolution.status).toBe("unknown");
    expect(doc.metadata.factType).toBe("undatedOccurrence");
    expect(doc.metadata.tags).not.toContain("event");
  });

  it("supplies the temporal-link rule to agents and retains undated consent as a fact beside examination dates", async () => {
    const quote = "The child and parents consented to the evaluation.";
    const document = new Document({pageContent:"Examination dates: May 15 and August 21, 2018.\n\n" + quote});
    const original = {...undatedEvent(quote), sourceQuote:quote};
    dateAgents([original], async candidates => ({decisions:candidates.map(candidate=>dateDecision(candidate.candidateId))}));
    const {extractor,semaphore}=makeExtractor();
    const [doc]=await extractor.generateDocuments(document);
    expect(doc.metadata.what).toBe(quote);
    expect(doc.metadata.whenStarted.year).toBeNull();
    expect(doc.metadata.whenEnded).toBeNull();
    expect(doc.metadata.factType).toBe("undatedOccurrence");
    expect(doc.pageContent).not.toContain("2018");
    for (const [options] of agentMocks.createAgent.mock.calls) {
      expect(options.systemPrompt).toContain("Topic, section proximity");
      expect(options.systemPrompt).toContain("Both endpoints need temporal support");
    }
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it("retains a cited treatment duration with unknown calendar dates through agent invocation", async () => {
    const text="Casey received therapy for three to four months.";
    const original={...undatedEvent(text),sourceQuote:text};
    const calls=dateAgents([original],async candidates=>({decisions:candidates.map(candidate=>dateDecision(candidate.candidateId,{
      relation:"duration",qualifier:"three to four months",supportingQuotes:[{pageNumber:1,quote:text}],
    }))}));
    const {extractor,semaphore}=makeExtractor();
    const [doc]=await extractor.generateDocuments(new Document({pageContent:text}));
    expect(calls).toHaveLength(1);
    expect(doc.metadata.whenStarted.year).toBeNull();
    expect(doc.metadata.whenEnded).toBeNull();
    expect(doc.metadata.factType).toBe("undatedOccurrence");
    expect(doc.pageContent).toContain("Relative timing (calendar date unknown): three to four months");
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it("resumes valid date decisions after another candidate fails without rerunning successful model work", async () => {
    const {store}=stageStore();
    let attempt=0;
    const calls=dateAgents([undatedEvent("First occurrence"),undatedEvent("Second occurrence")],async candidates=>{
      attempt++;
      if(attempt===2||attempt===3)throw new Error("date model unavailable");
      return {decisions:candidates.map((candidate,index)=>dateDecision(candidate.candidateId,
        attempt===1&&index===1?{status:"dated",relation:"point",start:{...emptyParts(),year:"2025"},
          supportingQuotes:[{pageNumber:1,quote:"A fabricated supporting quotation."}]}:{}))};
    });
    const first=makeExtractor(store);
    await expect(first.extractor.generateDocuments(source)).rejects.toThrow("date model unavailable");
    expect(first.semaphore.release).toHaveBeenCalledTimes(first.semaphore.acquire.mock.calls.length);
    const beforeResume = agentMocks.createAgent.mock.calls.length;
    const docs=await makeExtractor(store).extractor.generateDocuments(source);
    expect(docs).toHaveLength(2);
    expect(calls).toEqual([["1:0:candidate-0","1:0:candidate-1"],["1:0:candidate-1"],
      ["1:0:candidate-0","1:0:candidate-1"],["1:0:candidate-1"]]);
    expect(agentMocks.createAgent.mock.calls.length-beforeResume).toBe(1);
  });

  it("retains cited occurrences without a date after incomplete date responses", async () => {
    dateAgents([undatedEvent()],async()=>({decisions:[]}));
    const {extractor,semaphore}=makeExtractor();
    const [doc] = await extractor.generateDocuments(source);
    expect(doc.metadata.factType).toBe("undatedOccurrence");
    expect(doc.metadata.eventDateResolution).toMatchObject({status:"unknown",relation:"unknown"});
    expect(doc.metadata.sourceSpans).toHaveLength(1);
    expect(telemetryClient!.trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name:"evidenceExtractor.eventDateFallbackReviewed",
      properties:expect.objectContaining({outcome:"retained-undated-invalid-response"}),
    }));
    expect(semaphore.release).toHaveBeenCalledTimes(semaphore.acquire.mock.calls.length);
  });

  it("keeps valid dated peers when one date decision remains invalid", async () => {
    const quote="Casey completed the assessment in March 2025.";
    const document=new Document({pageContent:source.pageContent+"<!-- PageBreak -->"+quote});
    const calls=dateAgents([undatedEvent("First occurrence"),undatedEvent("Second occurrence")],async candidates=>({
      decisions:candidates.map((candidate:any)=>candidate.candidateId.endsWith("candidate-0")
        ? dateDecision(candidate.candidateId,{status:"dated",relation:"point",
          start:{...emptyParts(),year:"2025",month:"3"},supportingQuotes:[{pageNumber:2,quote}]})
        : {candidateId:candidate.candidateId,status:"dated"}),
    }));
    const documents=await makeExtractor().extractor.generateDocuments(document);
    expect(documents).toHaveLength(2);
    expect(documents.find(doc=>doc.metadata.what==="First occurrence")?.metadata.whenStarted.year).toBe("2025");
    const undated=documents.find(doc=>doc.metadata.what==="Second occurrence");
    expect(undated?.metadata.factType).toBe("undatedOccurrence");
    expect(undated?.metadata.whenStarted.year).toBeNull();
    expect(calls).toEqual([["1:0:candidate-0","1:0:candidate-1"],["1:0:candidate-1"],
      ["1:0:candidate-0","1:0:candidate-1"],["1:0:candidate-1"]]);
  });

  it("does not cache invalid calendar decisions that would prevent recovery on a later attempt", async () => {
    const {store}=stageStore();
    let broken=true;
    const reviews: string[][]=[];
    agentMocks.createAgent.mockImplementation(({systemPrompt})=>({invoke:vi.fn(async({messages})=>{
      if(systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
        const candidates=JSON.parse(messages[0].content.split("\nCANDIDATES:\n")[1]);
        reviews.push(candidates.map((candidate:any)=>candidate.candidateId));
        return {structuredResponse:{decisions:candidates.map((candidate:any)=>({candidateId:candidate.candidateId,
          verdict:"supported",keepOriginal:!broken,reason:broken?"Date correction":"",events:[],facts:[],claims:[],
          corrections:broken?[correction("whenStartedYear",{text:"2025"}),correction("whenStartedMonth",{text:"2"}),
            correction("whenStartedDay",{text:"30"})]:[]}))}};
      }
      return {structuredResponse:systemPrompt.includes("EVENT WORKER:")?{events:[event({sourceQuote:source.pageContent})]}
        :systemPrompt.includes("INDEPENDENT EXTRACTOR:")?{events:[],facts:[],claims:[]}
          :systemPrompt.includes("FACT WORKER:")?{facts:[]}:{claims:[]}};
    })}));
    await expect(makeExtractor(store).extractor.generateDocuments(source)).rejects.toThrow("Unresolved evidence");
    broken=false;
    await expect(makeExtractor(store).extractor.generateDocuments(source)).resolves.toHaveLength(1);
    expect(reviews).toHaveLength(3);
  });

  it.each([
    { corrections: [], keepOriginal: true, events: [event({ sourceQuote: source.pageContent })], facts: [], claims: [], reason: "", verdict: "supported" },
    { corrections: [], keepOriginal: false, events: [], facts: [], claims: [], reason: "", verdict: "supported" },
    { corrections: [], keepOriginal: true, events: [], facts: [], claims: [], reason: "Unsupported", verdict: "unsupported" },
    { corrections: [correction("where", {text: "Here"})], keepOriginal: true, events: [], facts: [], claims: [], reason: "", verdict: "supported" },
    { corrections: [correction("where", {text: "Here"})], keepOriginal: false, events: [event({sourceQuote: source.pageContent})], facts: [], claims: [], reason: "Mixed outputs", verdict: "supported" },
    { corrections: [correction("where", {text: "Here"})], keepOriginal: false, events: [], facts: [], claims: [], reason: "Unsupported", verdict: "unsupported" },
  ])("rejects contradictory compact review decisions: %j", async (decision) => {
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({
      invoke: vi.fn(async () => {
        if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) return { structuredResponse: {
          decisions: [{ candidateId: "1:0:candidate-0", ...decision }],
        } };
        if (systemPrompt.includes("EVENT WORKER:")) return { structuredResponse: { events: [event({ sourceQuote: source.pageContent })] } };
        return { structuredResponse: systemPrompt.includes("INDEPENDENT EXTRACTOR:")
          ? { events: [], facts: [], claims: [] } : systemPrompt.includes("FACT WORKER:") ? { facts: [] } : { claims: [] } };
      }),
    }));
    const { extractor, semaphore } = makeExtractor();

    await expect(extractor.generateDocuments(source)).rejects.toThrow("Reconciliation decision is inconsistent");
    expect(semaphore.acquire).toHaveBeenCalledTimes(semaphore.release.mock.calls.length);
  });

  it("runs at most four review batches concurrently and merges results in candidate order", async () => {
    const document = new Document({ pageContent: "A distinctive citation.", metadata: { pages: [1] } });
    const evidenceSource = new EvidenceSource(document);
    const window = evidenceSource.windows()[0];
    const candidates = Array.from({ length: 65 }, (_, index) => ({
      id: String(index), kind: "event" as const,
      item: event({ what: `Event ${index}`, sourceQuote: document.pageContent }), extractedBy: ["primary-events:test"],
    }));
    const { extractor } = makeExtractor();
    const started: number[] = [];
    const pending = new Map<number, () => void>();
    let active = 0;
    let maximumActive = 0;
    vi.spyOn((extractor as any).reviewer, "reconcile").mockImplementation((batch) => {
      const first = Number(batch[0].id);
      started.push(first);
      active++;
      maximumActive = Math.max(maximumActive, active);
      return new Promise(resolve => pending.set(first, () => {
        active--;
        resolve({ events: [{ item: batch[0].item, pageNumber: 1, sourceOffset: 0,
          sourceQuote: document.pageContent,
          sourceSpans: [{ pageNumber: 1, sourceOffset: 0, sourceQuote: document.pageContent }],
          extractedBy: ["primary-events:test"] }], facts: [], claims: [] });
      }));
    });

    const work = (extractor as any).reviewer.reviewBatches(candidates, evidenceSource, window);
    expect(started).toEqual([0, 16, 32, 48]);
    pending.get(32)!();
    await vi.waitFor(() => expect(started).toEqual([0, 16, 32, 48, 64]));
    for (const index of [64, 48, 16, 0]) pending.get(index)!();
    const result = await work;

    expect(maximumActive).toBe(4);
    expect(result.events.map((item: { item: EventExtractionResponse }) => item.item.what))
      .toEqual(["Event 0", "Event 16", "Event 32", "Event 48", "Event 64"]);
  });

  it("drains already active review batches before a failure escapes", async () => {
    const evidenceSource = new EvidenceSource(source);
    const candidates = Array.from({ length: 65 }, (_, index) => ({
      id: String(index), kind: "event" as const, item: event({ sourceQuote: source.pageContent }),
      extractedBy: ["primary-events:test"],
    }));
    const { extractor } = makeExtractor();
    const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
    const started: number[] = [];
    vi.spyOn((extractor as any).reviewer, "reconcile").mockImplementation((batch) => {
      const first = Number(batch[0].id);
      started.push(first);
      return new Promise((resolve, reject) => pending.set(first, {
        resolve: () => resolve({ events: [], facts: [], claims: [] }), reject,
      }));
    });

    const work = (extractor as any).reviewer.reviewBatches(candidates, evidenceSource, evidenceSource.windows()[0]);
    let settled = false;
    void work.finally(() => { settled = true; }).catch(() => {});
    expect(started).toEqual([0, 16, 32, 48]);
    pending.get(16)!.reject(new Error("review failed"));
    await Promise.resolve();
    expect(settled).toBe(false);
    for (const index of [0, 32, 48]) pending.get(index)!.resolve();

    await expect(work).rejects.toThrow("review failed");
    expect(started).toEqual([0, 16, 32, 48]);
    expect(settled).toBe(true);
  });

  it("resumes verified windows and invalidates checkpoints for changed source, settings, or citations", async () => {
    vi.stubEnv("EVIDENCE_PRIMARY_REASONING", "medium");
    const document = new Document({ pageContent: "Page one occurred.<!-- PageBreak -->Page two occurred.",
      metadata: { pages: [1, 2], title: "test.md", sourceId: "source-1" } });
    const saved = new Map<string, unknown>();
    const key = (identity: { runFingerprint: string }, index: number) => `${identity.runFingerprint}/${index}`;
    const checkpointStore: EvidenceCheckpointStore = {
      get: vi.fn(async (identity, index) => saved.get(key(identity, index)) ?? null),
      put: vi.fn(async (identity, index, value) => { saved.set(key(identity, index), value); }),
      clearSource: vi.fn(async () => {}), clearAccount: vi.fn(async () => {}),
    };
    const eventVisits: number[] = [];
    let failPageTwo = true;
    agentMocks.createAgent.mockImplementation(({ systemPrompt }) => ({
      invoke: vi.fn(async ({ messages }) => {
        const [prompt, candidateJson] = messages[0].content.split("\nCANDIDATES:\n");
        const target = JSON.parse(prompt).target;
        if (systemPrompt.includes("SOURCE SUPPORT REVIEWER:")) {
          const candidates = JSON.parse(candidateJson);
          return { structuredResponse: { decisions: candidates.map((candidate: { candidateId: string }) => ({
            candidateId: candidate.candidateId, verdict: "supported", corrections: [], keepOriginal: true,
            reason: "", events: [], facts: [], claims: [],
          })) } };
        }
        if (systemPrompt.includes("EVENT WORKER:")) {
          eventVisits.push(target.pageNumber);
          if (target.pageNumber === 2 && failPageTwo) throw new Error("temporary model failure");
          return { structuredResponse: { events: [event({ sourceQuote: target.text,
            what: `Occurrence on page ${target.pageNumber}`, whenStartedYear: null, whenEndedYear: null })] } };
        }
        return { structuredResponse: systemPrompt.includes("INDEPENDENT EXTRACTOR:")
          ? { events: [], facts: [], claims: [] } : systemPrompt.includes("FACT WORKER:") ? { facts: [] } : { claims: [] } };
      }),
    }));

    await expect(makeExtractor(checkpointStore).extractor.generateDocuments(document))
      .rejects.toThrow("temporary model failure");
    expect(saved.size).toBe(1);
    failPageTwo = false;
    const resumed = await makeExtractor(checkpointStore).extractor.generateDocuments(document);
    expect(resumed.map(item => item.metadata.pages[0])).toEqual([1, 2]);
    expect(eventVisits).toEqual([1, 2, 2]);
    expect(saved.size).toBe(2);

    const firstKey = [...saved.keys()].find(entry => entry.endsWith("/0"))!;
    const damaged = structuredClone(saved.get(firstKey)) as any;
    damaged.evidence.events[0].sourceSpans[0].sourceOffset = 99;
    saved.set(firstKey, damaged);
    await makeExtractor(checkpointStore).extractor.generateDocuments(document);
    expect(eventVisits).toEqual([1, 2, 2, 1]);

    const changed = new Document({ pageContent: "Page one occurred.<!-- PageBreak -->Page two changed.",
      metadata: document.metadata });
    await makeExtractor(checkpointStore).extractor.generateDocuments(changed);
    expect(eventVisits.slice(-2)).toEqual([1, 2]);

    vi.stubEnv("EVIDENCE_PRIMARY_REASONING", "high");
    await makeExtractor(checkpointStore).extractor.generateDocuments(document);
    expect(eventVisits.slice(-2)).toEqual([1, 2]);
  });
});
