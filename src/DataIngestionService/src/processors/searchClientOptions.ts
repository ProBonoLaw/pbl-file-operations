import type {SearchClientOptions} from "@azure/search-documents";

// Use an API with index alias support for document queries and writes. The SDK's
// default 2025-09-01 returns 404 for an alias even when getIndex(alias) succeeds.
// Keep ingestion, partition readiness and reconciliation on the same API.
// https://learn.microsoft.com/azure/search/search-how-to-alias
export const searchDocumentClientOptions = Object.freeze({
  serviceVersion: "2026-04-01",
} satisfies SearchClientOptions);
