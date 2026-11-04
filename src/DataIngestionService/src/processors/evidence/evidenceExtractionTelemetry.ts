import { EvidenceReviewPending } from "./evidenceAsync.js";
import type { Document } from "@langchain/core/documents";
import { telemetryClient } from "../appInsights.js";

/** Track extraction separately from chunk indexing and the complete broker job. */
export async function withEvidenceExtractionTelemetry(
  properties: Record<string, string>, extract: () => Promise<Document[]>,
): Promise<Document[]> {
  const startedAt = Date.now();
  telemetryClient.trackEvent({ name: "EvidenceExtractionStarted", properties:{...properties} });
  try {
    const documents = await extract();
    telemetryClient.trackEvent({ name: properties.evidenceExtractionMode === "skip" ? "EvidenceExtractionSkipped" : "EvidenceExtractionCompleted", properties:{...properties},
      measurements: { durationMs: Date.now() - startedAt, documentCount: documents.length } });
    return documents;
  } catch (error) {
    telemetryClient.trackEvent({ name: error instanceof EvidenceReviewPending ? "EvidenceExtractionReviewPending" : "EvidenceExtractionFailed",
      properties: { ...properties, errorType: error instanceof Error ? error.name : typeof error },
      measurements: { durationMs: Date.now() - startedAt } });
    throw error;
  }
}
