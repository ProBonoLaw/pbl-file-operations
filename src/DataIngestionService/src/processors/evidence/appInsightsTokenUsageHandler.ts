import type appInsights from "applicationinsights";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

type TokenRollup = { input: number; output: number; reasoning: number; total: number };

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export class AppInsightsTokenUsageHandler extends BaseCallbackHandler {
  name = "appinsights-token-usage";

  private rollups = new Map<string, TokenRollup>();
  private activeChains = new Set<string>();

  constructor(
    private client: appInsights.TelemetryClient,
    private commonProps: () => Record<string, string>,
  ) {
    super();
  }

  private add(runId: string, delta: Partial<TokenRollup>) {
    const curr = this.rollups.get(runId) ?? { input: 0, output: 0, reasoning: 0, total: 0 };
    this.rollups.set(runId, {
      input: curr.input + (delta.input ?? 0),
      output: curr.output + (delta.output ?? 0),
      reasoning: curr.reasoning + (delta.reasoning ?? 0),
      total: curr.total + (delta.total ?? 0),
    });
  }

  async handleChainStart(_: any, __: any, runId: string): Promise<void> {
    this.activeChains.add(runId);
  }

  private finishChain(runId: string, parentRunId?: string): TokenRollup | undefined {
    const usage = this.rollups.get(runId);
    this.rollups.delete(runId);
    this.activeChains.delete(runId);

    if (usage && parentRunId && this.activeChains.has(parentRunId)) {
      this.add(parentRunId, usage);
      return undefined;
    }

    return usage;
  }

  async handleLLMEnd(output: LLMResult, runId: string, parentRunId?: string): Promise<void> {
    // Most reliable place in LangChain JS is the AIMessage in generations[0][0].message
    const generation: { message?: { usage_metadata?: any; response_metadata?: any;
      tool_calls?: Array<{ name: string }> } } | undefined =
      output.generations?.[0]?.[0] as any;
    const msg = generation?.message;

    const usage = msg?.usage_metadata ?? {};
    const input = toNum(usage.input_tokens);
    const out = toNum(usage.output_tokens);
    const total = toNum(usage.total_tokens ?? (input + out));

    // Reasoning tokens (if present)
    // 1) Responses API mapping in LangChain
    const reasoningFromUsageMetadata = toNum(usage.output_token_details?.reasoning);

    // 2) Fallbacks if your provider/client surfaces Azure's completion_tokens_details directly
    const reasoningFromAzureDetails =
      toNum(msg?.response_metadata?.tokenUsage?.completionTokensDetails?.reasoningTokens) ||
      toNum(msg?.response_metadata?.tokenUsage?.completion_tokens_details?.reasoning_tokens);

    const reasoning = reasoningFromUsageMetadata || reasoningFromAzureDetails;
    const serviceTier = msg?.response_metadata?.service_tier;
    const cachedInput = usage.input_token_details?.cache_read;
    const cacheWrite = usage.input_token_details?.cache_creation;
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    const pageReadCalls = toolCalls.filter((call) => call.name === "read_source_page").length;
    const contextSearchCalls = toolCalls.filter((call) => call.name === "search_source_context").length;

    if (parentRunId && this.activeChains.has(parentRunId)) {
      this.add(parentRunId, { input, output: out, total, reasoning });
    }

    // Optional: emit per-call metrics too (sometimes useful)
    this.client.trackEvent({
      name: "llm.call.token_usage",
      properties: { ...this.commonProps(), runId, ...(parentRunId ? { parentRunId } : {}),
        ...(typeof serviceTier === "string" ? { serviceTier } : {}) },
      measurements: {
        inputTokens: input,
        outputTokens: out,
        reasoningTokens: reasoning,
        totalTokens: total,
        ...(typeof cachedInput === "number" ? { cachedInputTokens: cachedInput } : {}),
        ...(typeof cacheWrite === "number" ? { cacheWriteTokens: cacheWrite } : {}),
        toolCalls: toolCalls.length,
        pageReadCalls,
        contextSearchCalls,
      },
    });
  }

  async handleChainEnd(_: any, runId: string, parentRunId?: string): Promise<void> {
    const r = this.finishChain(runId, parentRunId);
    if (!r) return;

    this.client.trackEvent({
      name: "llm.request.token_usage",
      properties: { ...this.commonProps(), runId },
      measurements: {
        inputTokens: r.input,
        outputTokens: r.output,
        reasoningTokens: r.reasoning,
        totalTokens: r.total,
      },
    });
  }

  async handleChainError(err: any, runId: string, parentRunId?: string): Promise<void> {
    this.finishChain(runId, parentRunId);
    this.client.trackException({ exception: err, properties: { ...this.commonProps(), runId } });
  }
}
