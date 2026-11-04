import type { Embeddings } from "@langchain/core/embeddings";
import { describe, expect, it, vi } from "vitest";
import { SemanticChunker } from "../src/processors/semanticChunker.ts";

describe("SemanticChunker", () => {
  it.each(["percentile", "gradient"] as const)(
    "processes multiple sentences with the default %s quantile",
    async (thresholdType) => {
      const text = "First sentence. Second sentence. Third sentence. Fourth sentence.";
      const vectors = [[1, 0], [0.8, 0.2], [0, 1], [-1, 0]];
      const embeddings = {
        embedDocuments: vi.fn(async (texts: string[]) => texts.map((_, index) => vectors[index])),
      };
      const chunker = thresholdType === "percentile"
        ? new SemanticChunker(embeddings as unknown as Embeddings)
        : new SemanticChunker(embeddings as unknown as Embeddings, 1, false, "gradient");

      const documents = await chunker.createDocuments([text]);

      expect(embeddings.embedDocuments).toHaveBeenCalledOnce();
      expect(documents.map((document) => document.pageContent).join(" ")).toBe(text);
    },
  );
});
