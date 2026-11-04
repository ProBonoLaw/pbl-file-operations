import type { TelemetryClient } from "applicationinsights";
import { AzureOpenAIEmbeddings } from "@langchain/openai";
import { budgetedEvidenceFetch } from "./evidence/evidenceBudgetFetch.js";

function safeNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function errorProps(err: any): Record<string, string> {
  // Best-effort extraction; shapes vary by SDK/version
  const status =
    err?.status ??
    err?.statusCode ??
    err?.response?.status ??
    err?.cause?.status;

  const code =
    err?.code ??
    err?.error?.code ??
    err?.response?.data?.error?.code;

  return {
    error_name: String(err?.name ?? "Error"),
    error_message: String(err?.message ?? "unknown"),
    error_code: code ? String(code) : "",
    http_status: status ? String(status) : "",
  };
}

export class AzureOpenAIEmbeddingsWithTelemetry extends AzureOpenAIEmbeddings {
  constructor(
    private readonly telemetry: TelemetryClient,
    private readonly accountId: string,
    private readonly sourceId: string,
    fields: ConstructorParameters<typeof AzureOpenAIEmbeddings>[0]
  ) {
    super({...fields,configuration:{...fields?.configuration,
      fetch:budgetedEvidenceFetch({provider:"openai",deployment:fields?.azureOpenAIApiEmbeddingsDeploymentName
        ||fields?.azureOpenAIApiDeploymentName||fields?.model||"text-embedding-ada-002"},fields?.configuration?.fetch),
    }});
  }

  /** Match embedQuery preprocessing and validate response indexes explicitly. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.embeddingWithRetry({model:this.model,
      input:this.stripNewLines ? texts.map(text => text.replace(/\n/g, " ")) : texts,
      ...(this.dimensions ? {dimensions:this.dimensions} : {}), encoding_format:"float"});
    const rows = response.data as {index: number; embedding: number[]}[];
    if (!Array.isArray(rows) || rows.length !== texts.length || new Set(rows.map(row => row.index)).size !== texts.length
      || rows.some(row => !Number.isInteger(row.index) || row.index < 0 || row.index >= texts.length))
      throw new Error("Invalid embedding response indexes");
    return [...rows].sort((a, b) => a.index - b.index).map(row => row.embedding);
  }

  protected override async embeddingWithRetry(request: any): Promise<any> {
    const startTime = Date.now();
    const inputCount = Array.isArray(request?.input) ? request.input.length : 1;

    try {
      const res = await super.embeddingWithRetry(request);

      const usage = res?.usage ?? {};
      const promptTokens = safeNum(usage.prompt_tokens);
      const totalTokens = safeNum(usage.total_tokens ?? usage.prompt_tokens);

      this.telemetry.trackEvent({
        name: "aoai.embeddings.tokens",
        properties: {
          accountId: this.accountId,
          sourceId: this.sourceId,
          model: this.model,
          outcome: "success",
          inputCount: String(inputCount),
        },
        measurements: {
          inputTokens: promptTokens,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: totalTokens,
          durationMs: Date.now() - startTime,
        },
      });

      return res;
    } catch (err: any) {
      // Track the exception itself (stack + type)
      this.telemetry.trackException({
        exception: err,
        properties: {
          accountId: this.accountId,
          sourceId: this.sourceId,
          component: "AzureOpenAIEmbeddings",
          model: this.model,
          inputCount: String(inputCount),
          ...errorProps(err),
        },
      });

      // Also emit a failure event (useful for KQL aggregations)
      this.telemetry.trackEvent({
        name: "aoai.embeddings.tokens",
        properties: {
          accountId: this.accountId,
          sourceId: this.sourceId,
          model: this.model,
          outcome: "failure",
          inputCount: String(inputCount),
          ...errorProps(err),
        },
        measurements: {
          durationMs: Date.now() - startTime,
        },
      });

      throw err; // preserve behavior
    }
  }
}
