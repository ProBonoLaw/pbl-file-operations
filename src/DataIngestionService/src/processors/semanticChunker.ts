import { BaseDocumentTransformer, Document, DocumentInterface } from "@langchain/core/documents";
import { Embeddings } from "@langchain/core/embeddings";
import { cloneDeep } from "lodash-es";
import { matrix, quantileSeq } from "mathjs";
import { cosineSimilarity } from "./cosineUtils.js";

type BreakpointThresholdType = "percentile" | "standard_deviation" | "interquartile" | "gradient";

const BREAKPOINT_DEFAULTS: Record<BreakpointThresholdType, number> = {
  percentile: 0.95,
  standard_deviation: 3,
  interquartile: 1.5,
  gradient: 0.95,
};

interface Sentence {
  sentence: string;
  index: number;
  combined_sentence?: string;
  combined_sentence_embedding?: number[];
  distance_to_next?: number;
}

export class SemanticChunker extends BaseDocumentTransformer {
  private embeddings: Embeddings;
  private bufferSize: number;
  private addStartIndex: boolean;
  private breakpointThresholdType: BreakpointThresholdType;
  private breakpointThresholdAmount: number;
  private numberOfChunks?: number;
  private sentenceSplitRegex: RegExp;
  private minChunkSize?: number;

  constructor(
    embeddings: Embeddings,
    bufferSize: number = 1,
    addStartIndex: boolean = false,
    breakpointThresholdType: BreakpointThresholdType = "percentile",
    breakpointThresholdAmount?: number,
    numberOfChunks?: number,
    sentenceSplitRegex: string = "(?<=[.?!])\\s+",
    minChunkSize?: number
  ) {
    super();
    this.embeddings = embeddings;
    this.bufferSize = bufferSize;
    this.addStartIndex = addStartIndex;
    this.breakpointThresholdType = breakpointThresholdType;
    this.breakpointThresholdAmount =
      breakpointThresholdAmount ?? BREAKPOINT_DEFAULTS[breakpointThresholdType];
    this.numberOfChunks = numberOfChunks;
    this.sentenceSplitRegex = new RegExp(sentenceSplitRegex);
    this.minChunkSize = minChunkSize ?? 100;
  }

  private combineSentences(sentences: Sentence[]): Sentence[] {
    for (let i = 0; i < sentences.length; i++) {
      let combinedSentence = "";

      for (let j = i - this.bufferSize; j < i; j++) {
        if (j >= 0) {
          combinedSentence += sentences[j].sentence + " ";
        }
      }

      combinedSentence += sentences[i].sentence;

      for (let j = i + 1; j <= i + this.bufferSize; j++) {
        if (j < sentences.length) {
          combinedSentence += " " + sentences[j].sentence;
        }
      }

      sentences[i].combined_sentence = combinedSentence;
    }

    return sentences;
  }

  private calculateCosineDistances(sentences: Sentence[]): [number[], Sentence[]] {
    const distances: number[] = [];

    for (let i = 0; i < sentences.length - 1; i++) {
      const embeddingCurrent = sentences[i].combined_sentence_embedding!;
      const embeddingNext = sentences[i + 1].combined_sentence_embedding!;

      const similarity = cosineSimilarity(matrix([embeddingCurrent]), matrix([embeddingNext]))[0][0];
      const distance = 1 - similarity;

      distances.push(distance);
      sentences[i].distance_to_next = distance;
    }

    return [distances, sentences];
  }

  private calculateBreakpointThreshold(distances: number[]): [number, number[]] {
    switch (this.breakpointThresholdType) {
      case "percentile":
        return [quantileSeq(distances, this.breakpointThresholdAmount), distances];
      case "standard_deviation": {
        const mean = this.mean(distances);
        const stdDev = this.standardDeviation(distances);
        return [mean + this.breakpointThresholdAmount * stdDev, distances];
      }
      case "interquartile": {
        const q1 = quantileSeq(distances, 0.25);
        const q3 = quantileSeq(distances, 0.75);
        const iqr = q3 - q1;
        return [this.mean(distances) + this.breakpointThresholdAmount * iqr, distances];
      }
      case "gradient": {
        const gradient = this.gradient(distances);
        return [quantileSeq(gradient, this.breakpointThresholdAmount), gradient];
      }
      default:
        throw new Error(`Unexpected breakpointThresholdType: ${this.breakpointThresholdType}`);
    }
  }

  private async splitText(text: string): Promise<string[]> {
    const singleSentencesList = text.split(this.sentenceSplitRegex);

    if (singleSentencesList.length <= 1) {
      return singleSentencesList;
    }

    const [distances, sentences] = await this.calculateSentenceDistances(singleSentencesList);

    const [breakpointDistanceThreshold, breakpointArray] = this.calculateBreakpointThreshold(distances);

    const indicesAboveThreshold = breakpointArray
      .map((value, index) => (value > breakpointDistanceThreshold ? index : -1))
      .filter((index) => index !== -1);

    const chunks: string[] = [];
    let startIndex = 0;

    for (const index of indicesAboveThreshold) {
      const endIndex = index;
      const group = sentences.slice(startIndex, endIndex + 1);
      const combinedText = group.map((sentence) => sentence.sentence).join(" ");

      if (this.minChunkSize && combinedText.length < this.minChunkSize) {
        continue;
      }

      chunks.push(combinedText);
      startIndex = index + 1;
    }

    if (startIndex < sentences.length) {
      const combinedText = sentences.slice(startIndex).map((sentence) => sentence.sentence).join(" ");
      chunks.push(combinedText);
    }

    return chunks;
  }

  private async calculateSentenceDistances(singleSentencesList: string[]): Promise<[number[], Sentence[]]> {
    const sentences: Sentence[] = singleSentencesList.map((sentence, index) => ({
      sentence,
      index,
    }));

    const combinedSentences = this.combineSentences(sentences);

    try {
      const embeddings = await this.embeddings.embedDocuments(
        combinedSentences.map((sentence) => sentence.combined_sentence ?? "")
      );

      combinedSentences.forEach((sentence, index) => {
        sentence.combined_sentence_embedding = embeddings[index];
      });

      return this.calculateCosineDistances(combinedSentences);
    } catch (e) {
      console.log("Error in calculateSentenceDistances", e);
      return [[], []];
    }
  }

  private mean(data: number[]): number {
    return data.reduce((sum, value) => sum + value, 0) / data.length;
  }

  private standardDeviation(data: number[]): number {
    const mean = this.mean(data);
    const variance = data.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / data.length;
    return Math.sqrt(variance);
  }

  private gradient(data: number[]): number[] {
    return data.map((value, index, array) => (index > 0 ? value - array[index - 1] : 0));
  }

  async createDocuments(texts: string[], metadatas: Record<string, any>[] = [], batchId?: string): Promise<Document[]> {
    const documentsPromises = texts.map(async (text, i) => {
      let startIndex = 0;
      const subDocuments: Document[] = [];
      const splitTextEntries = await this.splitText(text);
      splitTextEntries.forEach((chunk) => {
        const metadata = cloneDeep(metadatas[i] || {});
        if (this.addStartIndex) {
          metadata.start_index = startIndex;
        }

        subDocuments.push(new Document({ pageContent: chunk, metadata }));
        startIndex += chunk.length;
      });
      console.log(`Subdocuments processed for batch ${batchId} - Doc index ${i}`, subDocuments.length);
      return subDocuments;
    });

    const documents = (await Promise.all(documentsPromises)).flat();

    return documents;
  }

  async splitDocuments(documents: Document[], batchId?: string): Promise<Document[]> {
    const texts = documents.map((doc) => doc.pageContent);
    const metadatas = documents.map((doc) => doc.metadata);

    return await this.createDocuments(texts, metadatas, batchId);
  }

  async transformDocuments(documents: DocumentInterface[], batchId?: string): Promise<DocumentInterface[]> {
    return this.splitDocuments(documents, batchId);
  }
}
