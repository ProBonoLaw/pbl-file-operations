import { ChatAnthropic } from "@langchain/anthropic";
import { setTimeout as delay } from "node:timers/promises";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI, type OpenAIClient } from "@langchain/openai";
import { positiveIntegerSetting } from "./evidenceRetryPolicy.js";
import { budgetedEvidenceFetch } from "./evidenceBudgetFetch.js";

export interface EvidenceModel {
  client: BaseChatModel;
  deployment: string;
  provider: "openai" | "anthropic" | "mistral" | "deepseek";
  timeoutMs: number;
}

/** Foundry Mistral rejects LangChain's assistant message name on tool rounds. */
export const mistralFetch: typeof fetch = async (input, init) => {
  if (typeof init?.body === "string") {
    const body = JSON.parse(init.body) as {messages?: Record<string, unknown>[]};
    if (Array.isArray(body.messages)) {
      body.messages = body.messages.map(message => {
        if (message.role !== "assistant") return message;
        const copy = {...message};
        delete copy.name;
        return copy;
      });
      init = {...init, body: JSON.stringify(body)};
    }
  }
  return fetch(input, init);
};

function pacedCompletionsFetch(intervalMs: number, transport: typeof fetch): typeof fetch {
  let queued = Promise.resolve();
  let lastStarted = 0;
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const turn = queued.then(async () => {
      signal?.throwIfAborted();
      const remaining = Math.max(0, lastStarted + intervalMs - Date.now());
      if (remaining) await delay(remaining, undefined, {signal: signal ?? undefined});
      signal?.throwIfAborted();
      lastStarted = Date.now();
    });
    queued = turn.catch(() => {});
    await turn;
    return transport(input, init);
  };
}

export function createEvidenceModel(role: "PRIMARY" | "INDEPENDENT" | "RECONCILIATION" | "RECONCILIATION_FALLBACK" | "RECONCILIATION_RESCUE" | "FAST" | "FAST_FALLBACK", fallbackDeployment: string,
  options?: {maxRetries: 0; timeoutMs?: number}): EvidenceModel {
  const prefix = `EVIDENCE_${role}_`;
  const deployment = process.env[prefix + "DEPLOYMENT_NAME"]?.trim() || fallbackDeployment;
  const configuredProvider = (process.env[prefix + "PROVIDER"]?.trim()
    || (role === "FAST_FALLBACK" ? process.env.EVIDENCE_INDEPENDENT_PROVIDER?.trim() : undefined))?.toLowerCase();
  if (configuredProvider && !["openai", "anthropic", "mistral", "deepseek"].includes(configuredProvider)) {
    throw new Error(`${prefix}PROVIDER must be openai, anthropic, mistral, or deepseek`);
  }
  const provider: EvidenceModel["provider"] = configuredProvider
    ? configuredProvider as EvidenceModel["provider"]
    : /(?:^|[-_/])claude(?:[-_/]|$)/i.test(deployment) ? "anthropic"
      : /(?:^|[-_/])mistral(?:[-_/]|$)/i.test(deployment) ? "mistral"
        : /(?:^|[-_/])deepseek(?:[-_/]|$)/i.test(deployment) ? "deepseek" : "openai";
  const endpoint = process.env[prefix + "ENDPOINT"]?.trim()
    || (role === "FAST_FALLBACK" ? process.env.EVIDENCE_INDEPENDENT_ENDPOINT?.trim() : undefined)
    || process.env.AZURE_OPENAI_LLM_ENDPOINT;
  const apiKey = process.env[prefix + "API_KEY"]
    || (role === "FAST_FALLBACK" ? process.env.EVIDENCE_INDEPENDENT_API_KEY : undefined)
    || process.env.AZURE_OPENAI_LLM_API_KEY;
  const configuredServiceTier = role === "RECONCILIATION" ? process.env[prefix + "SERVICE_TIER"]?.trim() : undefined;
  if (configuredServiceTier && configuredServiceTier !== "default" && configuredServiceTier !== "priority") {
    throw new Error(`${prefix}SERVICE_TIER must be default or priority`);
  }
  const serviceTier = configuredServiceTier as "default" | "priority" | undefined;
  if (serviceTier && provider !== "openai") {
    throw new Error(`${prefix}SERVICE_TIER requires an OpenAI model`);
  }
  if (!apiKey) throw new Error(`${prefix}API_KEY or AZURE_OPENAI_LLM_API_KEY is required`);
  if (!endpoint) throw new Error(`${prefix}ENDPOINT or AZURE_OPENAI_LLM_ENDPOINT is required`);
  const configuredURL = new URL(endpoint);
  const configuredPath = configuredURL.pathname.replace(/\/+$/, "");
  // Foundry model-router Responses calls use the project route. Preserve that
  // path when a role points at a project, while keeping account endpoints as is.
  const projectPath = /^\/api\/projects\/[^/]+(?:\/openai\/v1)?$/.test(configuredPath)
    ? configuredPath.replace(/\/openai\/v1$/, "") : null;
  const baseURL = provider === "anthropic" ? new URL("/anthropic", configuredURL)
    : projectPath ? new URL(`${projectPath}/openai/v1/`, configuredURL)
      : new URL("/openai/v1/", configuredURL);
  if (baseURL.protocol !== "https:") throw new Error(`${prefix}ENDPOINT must use HTTPS`);
  const fast = role === "FAST" || role === "FAST_FALLBACK";
  const fastMaxTokens = Number(process.env.EVIDENCE_FAST_MAX_OUTPUT_TOKENS || 8192);
  if (fast && (!Number.isSafeInteger(fastMaxTokens) || fastMaxTokens < 1))
    throw new Error("EVIDENCE_FAST_MAX_OUTPUT_TOKENS must be a positive integer");
  const configuredMaxOutput = process.env[prefix + "MAX_OUTPUT_TOKENS"]?.trim();
  const maxOutputTokens = configuredMaxOutput === undefined ? (fast ? fastMaxTokens : undefined) : Number(configuredMaxOutput);
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1))
    throw new Error(`${prefix}MAX_OUTPUT_TOKENS must be a positive integer`);
  const timeout = options?.timeoutMs ?? (fast ? positiveIntegerSetting("EVIDENCE_FAST_TIMEOUT_MS", 120_000) : 180_000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)
    throw new Error(`${fast ? "EVIDENCE_FAST_TIMEOUT_MS" : "Evidence model timeout"} must be a positive integer within the timer limit`);
  const maxRetries = options?.maxRetries ?? (fast ? 0 : 2);
  if (provider === "anthropic") {
    return {
      deployment,
      provider,
      timeoutMs: timeout,
      client: new ChatAnthropic({
        model: deployment,
        apiKey,
        clientOptions: { baseURL: baseURL.toString(), timeout, fetch:budgetedEvidenceFetch({deployment,provider}) },
        maxTokens: maxOutputTokens ?? 16_384,
        maxRetries,
      }),
    };
  }
  if (provider === "mistral" || provider === "deepseek") {
    const maxTokens = maxOutputTokens ?? 8192;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
      throw new Error(`${prefix}MAX_OUTPUT_TOKENS must be a positive integer`);
    }
    const intervalMs = Number(process.env[prefix + "REQUEST_INTERVAL_MS"] || 0);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
      throw new Error(`${prefix}REQUEST_INTERVAL_MS must be a nonnegative integer`);
    }
    const transport = provider === "mistral" ? mistralFetch : fetch;
    return {
      deployment,
      provider,
      timeoutMs: timeout,
      client: new ChatOpenAI({
        model: deployment,
        apiKey,
        configuration: { baseURL: baseURL.toString(), fetch:budgetedEvidenceFetch({deployment,provider},
          intervalMs ? pacedCompletionsFetch(intervalMs, transport) : transport) },
        useResponsesApi: false,
        maxTokens,
        timeout,
        maxRetries,
        n: 1,
      }),
    };
  }
  const effort = process.env[prefix + "REASONING"] || (fast ? "low" : process.env.AZURE_OPENAI_REASONING)
    || (role === "PRIMARY" ? "high" : "low");
  if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(effort)) {
    throw new Error(`${prefix}REASONING is not a supported reasoning effort`);
  }
  const verbosity = process.env.AZURE_OPENAI_VERBOSITY;
  return {
    deployment,
    provider,
    timeoutMs: timeout,
    client: new ChatOpenAI({
      model: deployment,
      apiKey,
      configuration: { baseURL: baseURL.toString(), fetch:budgetedEvidenceFetch({deployment,provider}) },
      useResponsesApi: true,
      reasoning: { effort: effort as OpenAIClient.Chat.ChatCompletionReasoningEffort },
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      maxTokens: maxOutputTokens ?? -1,
      timeout,
      n: 1,
      maxRetries,
      ...(["low", "medium", "high"].includes(verbosity ?? "")
        ? { verbosity: verbosity as "low" | "medium" | "high" } : {}),
    }),
  };
}
