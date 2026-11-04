import {CosmosClient} from "@azure/cosmos";
import {DefaultAzureCredential} from "@azure/identity";
import {SearchClient} from "@azure/search-documents";
import {createHash} from "node:crypto";
import {AzureOpenAIEmbeddingsWithTelemetry} from "../azureOpenAIEmbeddingsWithTelemetry.js";
import {telemetryClient} from "../appInsights.js";
import {searchDocumentClientOptions} from "../searchClientOptions.js";
import type {EvidenceCheckpointStore} from "./evidenceCheckpoint.js";
import {EvidenceEmbeddingCache} from "./evidenceEmbeddingCache.js";
import {reconciliationCheckpointGuard} from "./evidenceReconciliationDeadline.js";
import type {EvidenceSource} from "./evidenceSource.js";
import {sourceRerankerCutoff} from "./evidenceSourceRanking.js";
import {SearchSourceContext, partitionManifestIdentity, validatePartitionManifest, type EvidenceSourceLookup} from "./evidenceSourceLookup.js";
import {SourcePartitionSearch, type IndexedSourcePartition} from "./sourcePartitionSearch.js";

export async function createEvidenceSourceLookup(accountId: string, sourceId: string, source: EvidenceSource,
  store?: EvidenceCheckpointStore): Promise<EvidenceSourceLookup> {
  if (source.document.metadata.sourceId !== sourceId || source.document.metadata.accountId
    && source.document.metadata.accountId !== accountId) throw new Error("Source lookup identity does not match this document");
  const manifest = source.document.metadata.sourcePartitionManifest ?? await store?.getStage?.(
    partitionManifestIdentity(accountId, sourceId, source.contentHash), 0, "ready");
  if (!manifest || manifest.sourceContentHash !== source.contentHash || !Number.isSafeInteger(manifest.count) || manifest.count < 1
    || typeof manifest.idsHash !== "string" || typeof manifest.snapshotFingerprint !== "string")
    throw new Error("Source partitions need a complete readiness checkpoint before reconciliation");
  const model = {endpoint: process.env.AZURE_OPENAI_CUSTOM_ENDPOINT!,
    deployment: process.env.TEXT_EMBEDDING_LARGE_DEPLOYMENT_NAME || "text-embedding-3-large",
    model: "text-embedding-3-large", dimensions: 3072, apiVersion: "2024-12-01-preview",
    inputVersion: "strip-newlines-v1" as const, epoch: process.env.EVIDENCE_EMBEDDING_CACHE_EPOCH || ""};
  const options = {semanticConfiguration: process.env.EVIDENCE_SOURCE_SEMANTIC_CONFIGURATION || "Primary",
    maxRecords: Number(process.env.EVIDENCE_SOURCE_MAX_PARTITIONS || 2000)};
  const minimumRerankerScore = sourceRerankerCutoff();
  const fingerprint = createHash("sha256").update(JSON.stringify(["lazy-source-context-v3", accountId, sourceId, manifest, model, options,
    "citation-protected-cutoff-v1", minimumRerankerScore, searchDocumentClientOptions.serviceVersion])).digest("hex");
  let initialized: Promise<SearchSourceContext> | undefined;
  const initialize = async () => {
    const credential = new DefaultAzureCredential();
    const cosmos = new CosmosClient({endpoint: process.env.COSMOS_ENDPOINT!, aadCredentials: credential});
    let endpoint: string, index: string;
    try {
      const {resources} = await cosmos.database(process.env.COSMOS_DATABASE_NAME || "db_conversation_history")
        .container(process.env.COSMOS_CONTAINER_NAME || "accounts").items.query({
          query: "SELECT c.dataSourceId, c.searchEndpoint FROM c WHERE c.type = 'ACCOUNT_DETAILS'",
        }, {partitionKey: [accountId]}).fetchAll();
      if (resources.length !== 1 || !resources[0].dataSourceId || !resources[0].searchEndpoint)
        throw new Error("Missing unique account Search configuration");
      endpoint = resources[0].searchEndpoint; index = resources[0].dataSourceId;
    } finally { cosmos.dispose(); }
    const lookup = new SourcePartitionSearch(new SearchClient<IndexedSourcePartition>(endpoint, index, credential, searchDocumentClientOptions), accountId, sourceId,
      options);
    const snapshot = await lookup.snapshot();
    validatePartitionManifest(snapshot, manifest, source);
    const provider = new AzureOpenAIEmbeddingsWithTelemetry(telemetryClient, accountId, sourceId, {
      azureOpenAIApiDeploymentName: model.deployment, azureOpenAIBasePath: model.endpoint,
      azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
      azureOpenAIApiInstanceName: new URL(model.endpoint).hostname.split(".")[0],
      model: model.model, dimensions: model.dimensions, azureOpenAIApiVersion: model.apiVersion, maxRetries: 2,
    });
    const embeddings = new EvidenceEmbeddingCache(accountId, sourceId, model, provider, store,
      measurements => telemetryClient?.trackEvent({name: "evidence.sourceLookup.embeddings",
        properties: {accountId, sourceId}, measurements: {...measurements}}));
    return new SearchSourceContext(source, lookup, snapshot, accountId,
      {vectors: texts => embeddings.vectors(texts, reconciliationCheckpointGuard())}, model, store,
      measurements => telemetryClient?.trackEvent({name: "evidence.sourceLookup.ranking",
        properties: {accountId, sourceId}, measurements: {...measurements}}), minimumRerankerScore);
  };
  // Gathering and cached review tasks need the identity, but should not download
  // the source corpus or generate query embeddings unless a tool uses Search.
  return {fingerprint,
    search: async (request, signal) => {signal?.throwIfAborted(); return (await (initialized ??= initialize())).search(request, signal);},
    verify: async () => {if (initialized) await (await initialized).verify();},
  };
}
