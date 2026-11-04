import type { TelemetryClient } from "applicationinsights";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AzureOpenAIEmbeddingsWithTelemetry } from "../src/processors/azureOpenAIEmbeddingsWithTelemetry.ts";

const embeddingWithRetry = vi.hoisted(() => vi.fn());

vi.mock("@langchain/openai", () => ({
  AzureOpenAIEmbeddings: class {
    model = "test-model";

    embeddingWithRetry(request: unknown) {
      return embeddingWithRetry(request);
    }
  },
}));

class TestEmbeddings extends AzureOpenAIEmbeddingsWithTelemetry {
  run(request: unknown) {
    return this.embeddingWithRetry(request);
  }
}

function setup() {
  const trackEvent = vi.fn();
  const trackException = vi.fn();
  const telemetry = { trackEvent, trackException } as unknown as TelemetryClient;
  const embeddings = new TestEmbeddings(telemetry, "account-123", "source-456", {} as any);

  return { embeddings, trackEvent, trackException };
}

beforeEach(() => vi.clearAllMocks());

describe("AzureOpenAIEmbeddingsWithTelemetry", () => {
  it("maps out-of-order provider rows back to the original batch and matches query normalization", async () => {
    const {embeddings} = setup();
    Object.assign(embeddings,{stripNewLines:true,dimensions:2});
    embeddingWithRetry.mockResolvedValue({data:[{index:1,embedding:[3,4]},{index:0,embedding:[1,2]}]});
    expect(await embeddings.embedBatch(["First\nline","Second"])).toEqual([[1,2],[3,4]]);
    expect(embeddingWithRetry).toHaveBeenCalledWith({model:"test-model",input:["First line","Second"],dimensions:2,encoding_format:"float"});
  });
  it.each([
    [{index:0,embedding:[1]},{index:0,embedding:[2]}],
    [{index:0,embedding:[1]},{index:2,embedding:[2]}],
    [{index:0,embedding:[1]}],
  ])("rejects missing, duplicate or out-of-range embedding indexes", async (...data) => {
    const {embeddings} = setup();
    embeddingWithRetry.mockResolvedValue({data});
    await expect(embeddings.embedBatch(["First","Second"])).rejects.toThrow("Invalid embedding response indexes");
  });
  it("records durationMs for a successful embedding call", async () => {
    const { embeddings, trackEvent } = setup();
    const response = { usage: { prompt_tokens: 5, total_tokens: 5 } };
    embeddingWithRetry.mockResolvedValue(response);

    await expect(embeddings.run({ input: ["first", "second"] })).resolves.toBe(response);

    expect(trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "aoai.embeddings.tokens",
      properties: expect.objectContaining({
        accountId: "account-123",
        sourceId: "source-456",
        outcome: "success",
      }),
      measurements: expect.objectContaining({ durationMs: expect.any(Number) }),
    }));
    expect(trackEvent.mock.calls[0][0].measurements).not.toHaveProperty("duration_ms");
  });

  it("records durationMs for a failed embedding call and rethrows the error", async () => {
    const { embeddings, trackEvent, trackException } = setup();
    const error = new Error("embedding failed");
    embeddingWithRetry.mockRejectedValue(error);

    await expect(embeddings.run({ input: ["first"] })).rejects.toBe(error);

    expect(trackException).toHaveBeenCalledWith(expect.objectContaining({ exception: error }));
    expect(trackEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "aoai.embeddings.tokens",
      properties: expect.objectContaining({
        accountId: "account-123",
        sourceId: "source-456",
        outcome: "failure",
      }),
      measurements: { durationMs: expect.any(Number) },
    }));
  });
});
