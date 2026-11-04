import { createDataIngestionApiServer } from "./api.js";
import { telemetryClient } from "./processors/appInsights.js";
import { DocumentIngressProcessor } from "./processors/dataIngestionProcessor.js";
import { DuplicateDocumentProcessor } from "./processors/duplicateDocumentProcessor.js";
import type { DataIngestionRequest } from "./models/request.js";
import { BlobOperationOrderStore } from "./operationOrderStore.js";
import { BlobEvidenceCheckpointStore } from "./processors/evidence/evidenceCheckpoint.js";
import { BlobEvidenceWorkStore } from "./processors/evidence/evidenceWorkStore.js";
import { BlobEvidenceTaskStore } from "./processors/evidence/evidenceTaskQueue.js";
import { createProcessShutdown } from "./processShutdown.js";

export function startServer(): void {
  const lifecycle = createProcessShutdown("data-ingestion-api");
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port");
  }
  const evidenceCheckpointStore = new BlobEvidenceCheckpointStore();
  const pruneCheckpoints = (): void => {
    void evidenceCheckpointStore.pruneExpired().catch((error: unknown) => {
      telemetryClient.trackException({ exception: error instanceof Error ? error : new Error(String(error)),
        properties: { action: "pruneEvidenceCheckpoints" } });
    });
  };
  pruneCheckpoints();
  const checkpointPruneTimer = setInterval(pruneCheckpoints, 24 * 60 * 60 * 1000);
  checkpointPruneTimer.unref();

  const server = createDataIngestionApiServer({
    telemetryClient,
    operationOrderStore: new BlobOperationOrderStore(),
    evidenceCheckpointStore,
    evidenceWorkStore: new BlobEvidenceWorkStore(),
    evidenceTaskStore: new BlobEvidenceTaskStore(),
    createDuplicateDocumentProcessor: (accountId) =>
      new DuplicateDocumentProcessor(accountId),
    createDocumentIngressProcessor: (request: DataIngestionRequest) =>
      new DocumentIngressProcessor(
        request.containerName,
        request.containerPath,
        request.documentName,
        request.sourceUrl,
        request.accountId,
        request.sourceId,
        request.isCurrentOrder ?? false,
        request.isWebSite ?? false,
        evidenceCheckpointStore,
        request.deferEvidenceExtraction ?? false,
        request.extractionContainerPath,
        request.evidenceExtractionMode,
      ),
  });

  server.listen(port, "0.0.0.0", () => {
    console.info(`Data Ingestion API listening on port ${port}`);
  });

  const finishShutdown = async (error?: Error): Promise<void> => {
    if (error) {
      console.error("Failed to close the Data Ingestion API listener", error);
      process.exitCode = 1;
    }
    await server.waitForRequests();
    let telemetryDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        telemetryClient.shutdown(),
        new Promise<never>((_, reject) => {
          telemetryDeadline = setTimeout(() => reject(new Error("Telemetry shutdown exceeded 15 seconds")), 15_000);
        }),
      ]);
    } catch (shutdownError) {
      console.error("Failed to flush Data Ingestion API telemetry", shutdownError);
      process.exitCode = 1;
    } finally {
      clearTimeout(telemetryDeadline);
    }
    console.info("Data Ingestion API requests drained; exiting");
    // SDK background handles can outlive the closed listener. Exit only after
    // requests have drained and telemetry has flushed or reached its deadline.
    lifecycle.finish();
  };
  const shutdown = (signal: string): void => {
    if (!lifecycle.begin(signal)) return;
    clearInterval(checkpointPruneTimer);
    console.info(`Received ${signal}; draining Data Ingestion API requests`);
    server.close(error => { void finishShutdown(error).catch((shutdownError: unknown) => {
      console.error("Data Ingestion API shutdown failed", shutdownError);
      lifecycle.finish(1);
    }); });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
