import type appInsights from "applicationinsights";
import type { LLMResult } from "@langchain/core/outputs";
import { describe, expect, it, vi } from "vitest";
import { AppInsightsTokenUsageHandler } from "../src/processors/evidence/appInsightsTokenUsageHandler.ts";

function llmResult(input: number, output: number, reasoning: number): LLMResult {
  return {
    generations: [[{
      message: {
        usage_metadata: {
          input_tokens: input,
          output_tokens: output,
          total_tokens: input + output,
          output_token_details: { reasoning },
        },
      },
    }]],
  } as unknown as LLMResult;
}

function setup() {
  const trackEvent = vi.fn();
  const trackException = vi.fn();
  const client = { trackEvent, trackException } as unknown as appInsights.TelemetryClient;
  const handler = new AppInsightsTokenUsageHandler(client, () => ({
    accountId: "account-123",
    sourceId: "source-456",
  }));
  const requestEvents = () => trackEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.name === "llm.request.token_usage");

  return { handler, trackEvent, trackException, requestEvents };
}

describe("AppInsightsTokenUsageHandler", () => {
  it("aggregates child LLM usage under the chain run and clears it after completion", async () => {
    const { handler, trackEvent, requestEvents } = setup();

    await handler.handleChainStart({}, {}, "chain-1");
    await handler.handleLLMEnd(llmResult(5, 3, 2), "llm-1", "chain-1");
    await handler.handleLLMEnd(llmResult(7, 4, 1), "llm-2", "chain-1");
    await handler.handleChainEnd({}, "chain-1");

    expect(trackEvent).toHaveBeenCalledTimes(3);
    expect(trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "llm.call.token_usage",
      properties: {
        accountId: "account-123",
        sourceId: "source-456",
        runId: "llm-1",
        parentRunId: "chain-1",
      },
    }));
    expect(requestEvents()).toEqual([{
      name: "llm.request.token_usage",
      properties: { accountId: "account-123", sourceId: "source-456", runId: "chain-1" },
      measurements: { inputTokens: 12, outputTokens: 7, reasoningTokens: 3, totalTokens: 19 },
    }]);

    await handler.handleChainStart({}, {}, "chain-2");
    await handler.handleLLMEnd(llmResult(2, 1, 0), "llm-3", "chain-2");
    await handler.handleChainEnd({}, "chain-2");

    expect(requestEvents()[1].measurements).toEqual({
      inputTokens: 2,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 3,
    });
  });

  it("rolls nested chain usage up to its outer request", async () => {
    const { handler, requestEvents } = setup();

    await handler.handleChainStart({}, {}, "root");
    await handler.handleChainStart({}, {}, "child");
    await handler.handleLLMEnd(llmResult(4, 2, 1), "llm-child", "child");
    await handler.handleChainEnd({}, "child", "root");
    expect(requestEvents()).toEqual([]);

    await handler.handleLLMEnd(llmResult(3, 2, 0), "llm-root", "root");
    await handler.handleChainEnd({}, "root");

    expect(requestEvents()).toEqual([expect.objectContaining({
      properties: expect.objectContaining({ runId: "root" }),
      measurements: { inputTokens: 7, outputTokens: 4, reasoningTokens: 1, totalTokens: 11 },
    })]);
  });

  it("records the processing tier actually returned by the model", async () => {
    const { handler, trackEvent } = setup();
    const output = llmResult(11, 5, 0);
    (output.generations[0][0] as any).message.response_metadata = { service_tier: "default" };

    await handler.handleLLMEnd(output, "llm-priority");

    expect(trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "llm.call.token_usage",
      properties: expect.objectContaining({ serviceTier: "default" }),
    }));
  });

  it("records cached input and tool turns for each model call", async () => {
    const { handler, trackEvent } = setup();
    const output = llmResult(11, 5, 0);
    const message = (output.generations[0][0] as any).message;
    message.usage_metadata.input_token_details = { cache_read: 7, cache_creation: 2 };
    message.tool_calls = [{ name: "read_source_page" }, { name: "extract" }];

    await handler.handleLLMEnd(output, "llm-tools");

    expect(trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "llm.call.token_usage",
      measurements: expect.objectContaining({
        cachedInputTokens: 7, cacheWriteTokens: 2, toolCalls: 2, pageReadCalls: 1,
      }),
    }));
  });

  it("preserves spent tokens from a failed child chain and clears a failed root", async () => {
    const { handler, trackException, requestEvents } = setup();

    await handler.handleChainStart({}, {}, "root");
    await handler.handleChainStart({}, {}, "child");
    await handler.handleLLMEnd(llmResult(4, 2, 0), "llm-child", "child");
    const childError = new Error("child failed");
    await handler.handleChainError(childError, "child", "root");
    await handler.handleChainEnd({}, "root");

    expect(trackException).toHaveBeenCalledWith({
      exception: childError,
      properties: { accountId: "account-123", sourceId: "source-456", runId: "child" },
    });
    expect(requestEvents()[0].measurements.totalTokens).toBe(6);

    await handler.handleChainStart({}, {}, "failed-root");
    await handler.handleLLMEnd(llmResult(9, 1, 0), "llm-failed", "failed-root");
    await handler.handleChainError(new Error("root failed"), "failed-root");
    await handler.handleChainStart({}, {}, "failed-root");
    await handler.handleLLMEnd(llmResult(1, 1, 0), "llm-retry", "failed-root");
    await handler.handleChainEnd({}, "failed-root");

    expect(requestEvents()[1].measurements).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2,
    });
  });
});
