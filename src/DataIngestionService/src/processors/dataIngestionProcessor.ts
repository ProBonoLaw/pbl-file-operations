import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { SearchClient, SearchField, SearchFieldDataType, SearchIndex, SearchIndexClient, SemanticPrioritizedFields } from "@azure/search-documents";
import { BlobClient, BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { Document } from "@langchain/core/documents";
import { TokenTextSplitter } from '@langchain/textsplitters';
import { fileTypeFromBuffer } from "file-type";
import { get_encoding } from "tiktoken";

import { constants } from "buffer";
import * as crypto from "crypto";
import { Crawler } from "./crawler.js";
import { ExperimentalMarkdownSyntaxTextSplitter } from "./experimentalMarkdownSyntaxTextSplitter.js";
import { EvidenceExtractor } from "./evidence/evidenceExtractor.js";
import { EvidenceSource } from "./evidence/evidenceSource.js";
import { sourceLookupMode, partitionManifestIdentity, partitionIdsHash, validatePartitionManifest } from "./evidence/evidenceSourceLookup.js";
import { SourcePartitionSearch, SourcePartitionVisibilityError, type IndexedSourcePartition } from "./evidence/sourcePartitionSearch.js";
import { setTimeout as delay } from "node:timers/promises";
import type { EvidenceCheckpointStore } from "./evidence/evidenceCheckpoint.js";
import { EvidenceEmbeddingCache } from "./evidence/evidenceEmbeddingCache.js";
import { withEvidenceExtractionTelemetry } from "./evidence/evidenceExtractionTelemetry.js";
import {
    resolveEvidenceExtractionMode, routeEvidenceExtractionModeForBudget,
    type EvidenceExtractionModeInput, type EvidenceExtractionSelection
} from "./evidence/evidenceExtractionMode.js";
import { asOfSearchField, ensureEvidenceSearchFields } from "./evidence/evidenceSearchSchema.js";
import { evidenceRetrievalFields, evidenceSearchValues } from "./evidence/evidenceSearchProjection.js";
import { AzureOpenAIEmbeddingsWithTelemetry } from "./azureOpenAIEmbeddingsWithTelemetry.js";
import { telemetryClient } from "./appInsights.js";
import {
    parseExtractionPackage, extractionChunks, literalDocument, legacyChunks, legacySourcePages,
    attachEvidenceLocations, type ExtractionPackage
} from "./extractionPackage.js";
import { extractionSearchFields } from "./extractionSearchSchema.js";
import { searchDocumentClientOptions } from "./searchClientOptions.js";

const PAGE_BREAK = "<!-- PageBreak -->";

async function isNotText(buffer: Buffer): Promise<boolean> {
    const fileType = await fileTypeFromBuffer(buffer);
    return fileType !== undefined && fileType.mime !== 'text/plain' && fileType.mime !== 'text/markdown' && fileType.mime !== 'application/json' && fileType.mime !== 'application/vnd.apache.parquet';
}

export class DocumentIngressProcessor {
    private readonly docCacheStorageAccountName: string | undefined;
    private readonly defaultCredential: DefaultAzureCredential;
    private readonly accountUrl: string;
    private generalIndex: string | undefined;
    private blobClient: BlobClient | undefined;
    private aoaiEmbeddings!: AzureOpenAIEmbeddingsWithTelemetry;
    private aoaiEmbeddingsSmall!: AzureOpenAIEmbeddingsWithTelemetry;
    private skipEvidenceExtraction: boolean = false;
    private currentPosition: number = 0;
    private searchEndpoint: string | undefined;
    private extractionPackage?: ExtractionPackage;
    private embeddingCache?: EvidenceEmbeddingCache;
    private checkOpen: () => Promise<void> = async () => { };

    constructor(
        private readonly containerName: string,
        private readonly containerPath: string,
        private readonly filename: string,
        private readonly sourceUrl: string,
        private readonly accountId: string,
        private readonly sourceId: string,
        private readonly isCurrentOrder: boolean,
        private readonly isWebSite: boolean,
        private readonly checkpointStore?: EvidenceCheckpointStore,
        private readonly deferEvidenceExtraction = false,
        private readonly extractionContainerPath?: string,
        private readonly evidenceExtractionMode?: EvidenceExtractionModeInput,
    ) {
        console.info(`Preparing source ${accountId} for ingress. Source ID: ${sourceId}`);
        this.docCacheStorageAccountName = process.env.INPUT_ACCOUNT_NAME;
        this.defaultCredential = new DefaultAzureCredential();
        this.accountUrl = `https://${this.docCacheStorageAccountName}.blob.core.windows.net`;
    }

    prepareEmbeddings(): void {
        this.aoaiEmbeddings = new AzureOpenAIEmbeddingsWithTelemetry(telemetryClient, this.accountId, this.sourceId, {
            azureOpenAIApiCompletionsDeploymentName: process.env.TEXT_EMBEDDING_LARGE_DEPLOYMENT_NAME || "text-embedding-3-large",
            azureOpenAIApiDeploymentName: process.env.TEXT_EMBEDDING_LARGE_DEPLOYMENT_NAME || "text-embedding-3-large",
            azureOpenAIBasePath: process.env.AZURE_OPENAI_CUSTOM_ENDPOINT,
            maxRetries: 20,
            azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
            azureOpenAIApiInstanceName: new URL(process.env.AZURE_OPENAI_CUSTOM_ENDPOINT || "").hostname.split('.')[0],
            model: "text-embedding-3-large",
            dimensions: 3072,
            azureOpenAIApiVersion: "2024-12-01-preview"
        });
        this.embeddingCache = new EvidenceEmbeddingCache(this.accountId, this.sourceId, {
            endpoint: process.env.AZURE_OPENAI_CUSTOM_ENDPOINT!,
            deployment: process.env.TEXT_EMBEDDING_LARGE_DEPLOYMENT_NAME || "text-embedding-3-large",
            model: "text-embedding-3-large", dimensions: 3072, apiVersion: "2024-12-01-preview", inputVersion: "strip-newlines-v1",
            epoch: process.env.EVIDENCE_EMBEDDING_CACHE_EPOCH || "",
        }, this.aoaiEmbeddings, this.checkpointStore, measurements => telemetryClient.trackEvent({
            name: "evidence.embeddings.resolved", properties: { accountId: this.accountId, sourceId: this.sourceId },
            measurements: { ...measurements },
        }));

        this.aoaiEmbeddingsSmall = new AzureOpenAIEmbeddingsWithTelemetry(telemetryClient, this.accountId, this.sourceId, {
            azureOpenAIApiCompletionsDeploymentName: process.env.TEXT_EMBEDDING_SMALL_DEPLOYMENT_NAME || "text-embedding-3-small",
            azureOpenAIApiDeploymentName: process.env.TEXT_EMBEDDING_SMALL_DEPLOYMENT_NAME || "text-embedding-3-small",
            azureOpenAIBasePath: process.env.AZURE_OPENAI_CUSTOM_ENDPOINT,
            maxRetries: 20,
            azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
            azureOpenAIApiInstanceName: new URL(process.env.AZURE_OPENAI_CUSTOM_ENDPOINT || "").hostname.split('.')[0],
            model: "text-embedding-3-small",
            azureOpenAIApiVersion: "2024-12-01-preview",
            verbose: true
        });
        telemetryClient.trackEvent({ name: "embeddingsPrepared", properties: { accountId: this.accountId, sourceId: this.sourceId } });
    }

    async prepareGeneralIndex(): Promise<void> {
        const cosmosEndpoint = process.env.COSMOS_ENDPOINT;
        const databaseName = process.env.COSMOS_DATABASE_NAME || "db_conversation_history";
        const containerName = process.env.COSMOS_CONTAINER_NAME || "accounts";

        if (!cosmosEndpoint) {
            throw new Error("COSMOS_ENDPOINT is missing");
        }

        const cosmosClient = new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: this.defaultCredential });
        try {
            const database = cosmosClient.database(databaseName);
            const container = database.container(containerName);

            const { resources: results } = await container.items
                .query({
                    query: "SELECT c.dataSourceId, c.isSharedResource, c.searchEndpoint FROM c WHERE c.type = 'ACCOUNT_DETAILS'",
                    parameters: [{ name: "@accountId", value: this.accountId }],
                },
                    { partitionKey: [this.accountId] })
                .fetchAll();

            if (results.length === 0) {
                throw new Error(`Missing general index for ${this.accountId}`);
            }

            this.generalIndex = results[0].dataSourceId;
            this.searchEndpoint = results[0].searchEndpoint;
            if (!this.searchEndpoint) {
                throw new Error(`Missing search endpoint for account ${this.accountId}`);
            }
            this.skipEvidenceExtraction = results[0].isSharedResource && this.isWebSite !== true
                && (this.evidenceExtractionMode ?? "auto") === "auto";
            console.info(`Using general index ${this.generalIndex} for account ${this.accountId}`);
            telemetryClient.trackEvent({ name: "generalIndexPrepared", properties: { accountId: this.accountId, sourceId: this.sourceId } });
        } finally {
            cosmosClient.dispose();
        }

    }

    private applyPositionMetadata(doc: Document): Document {
        doc.metadata = doc.metadata || {};
        doc.metadata.pos = this.currentPosition;
        if (this.currentPosition > 0) {
            doc.metadata.prv = this.currentPosition - 1;
        }
        this.currentPosition += 1;
        doc.metadata.nxt = this.currentPosition;
        return doc;
    }

    private async extractSplitsForWebSite(siteLoader: Crawler): Promise<{ fullDocument: Document | null; splits1: Document[] }> {
        const splits1 = await siteLoader.crawl(this.sourceUrl, 30);
        return { fullDocument: null, splits1 };
    }

    private async extractSplitsForDocument(): Promise<{ fullDocument: Document; splits1: Document[] }> {
        const fullDocument = await this.retrieveDocumentFromBlob();
        const pages = this.extractionPackage ? this.extractionPackage.literalPages.map(page => page.pageNumber)
            : legacySourcePages(fullDocument.pageContent).map((_, index) => index + 1);
        this.applyMetadata(fullDocument, pages);
        const splits1 = this.extractionPackage ? extractionChunks(this.extractionPackage) : legacyChunks(fullDocument.pageContent);
        return { fullDocument, splits1 };
    }

    private async extractEvidenceDocumentsForSource(fullDocument: Document | null): Promise<Document[]> {
        if (!fullDocument) throw new Error("Full source document is unavailable for evidence extraction");
        const sourceDocument = fullDocument;
        const properties: Record<string, string> = {
            accountId: this.accountId, sourceId: this.sourceId,
            pageCount: String(sourceDocument.metadata.pages.length), executionMode: "inline",
            evidenceExtractionMode: this.evidenceExtractionMode ?? "auto"
        };
        return withEvidenceExtractionTelemetry(properties, async () => {
            const selected = await resolveEvidenceExtractionMode(this.accountId, this.evidenceExtractionMode);
            const mode = await routeEvidenceExtractionModeForBudget(selected,
                sourceDocument.metadata.pages.length, sourceDocument.pageContent.length);
            properties.evidenceExtractionMode = mode;
            telemetryClient.trackEvent({ name: "EvidenceExtractionModeSelected", properties: { ...properties } });
            if (mode !== selected) telemetryClient.trackEvent({
                name: "EvidenceExtractionBudgetModeRouted",
                properties: { ...properties, characterCount: String(sourceDocument.pageContent.length) }
            });
            if (mode === "skip") return [];
            const evidenceExtractor = new EvidenceExtractor(this.accountId, this.sourceId, undefined, this.checkpointStore, undefined, mode,
                this.duplicateEvidenceEmbeddings(),
                this.isCurrentOrder ? async () => undefined : undefined);
            const extracted = await evidenceExtractor.generateDocuments(sourceDocument);
            return this.extractionPackage ? attachEvidenceLocations(extracted, this.extractionPackage) : extracted;
        });
    }

    private async buildDocumentSplitsDedupList(splits2: Document[], fullDocument: Document | null): Promise<Document[]> {
        const factlessSplitsDedupList = await this.documentSecondSplit(splits2);
        if (this.skipEvidenceExtraction || this.deferEvidenceExtraction) {
            return factlessSplitsDedupList;
        }
        const evidenceDocuments = await this.extractEvidenceDocumentsForSource(fullDocument);
        return factlessSplitsDedupList.concat(evidenceDocuments);
    }

    private async buildSplitsDedupList(splits2: Document[], fullDocument: Document | null): Promise<Document[]> {
        try {
            if (this.isWebSite) {
                const splitsDedupList = await this.documentSecondSplit(splits2);
                return this.generatePageIndices(splitsDedupList);
            }
            return await this.buildDocumentSplitsDedupList(splits2, fullDocument);
        } catch (error) {
            telemetryClient.trackException({ exception: error instanceof Error ? error : new Error(String(error)), properties: { accountId: this.accountId, sourceId: this.sourceId, action: "preprocessing" } });
            throw error;
        }
    }

    private async clearEvidenceCheckpointsAfterIndexing(): Promise<void> {
        if (this.isWebSite || this.deferEvidenceExtraction || !this.checkpointStore) return;
        try {
            await (this.checkpointStore.clearSourceWork ?? this.checkpointStore.clearSource)
                .call(this.checkpointStore, this.accountId, this.sourceId);
        } catch (error) {
            telemetryClient.trackException({
                exception: error instanceof Error ? error : new Error(String(error)),
                properties: { accountId: this.accountId, sourceId: this.sourceId, action: "clearEvidenceCheckpoints" }
            });
            console.warn("Evidence checkpoint cleanup failed after successful indexing", error);
        }
    }

    async processDocument(checkOpen: () => Promise<void> = async () => { }): Promise<string[]> {
        this.checkOpen = checkOpen;
        await this.checkOpen();
        await this.prepareGeneralIndex();
        this.prepareEmbeddings();
        telemetryClient.trackEvent({ name: "preprocessingStarted", properties: { accountId: this.accountId, sourceId: this.sourceId } });
        const siteLoader = this.isWebSite ? new Crawler(new URL(this.sourceUrl).host, this.defaultCredential, this.sourceId, this.accountId) : null;
        const { fullDocument, splits1 } = this.isWebSite && siteLoader
            ? await this.extractSplitsForWebSite(siteLoader)
            : await this.extractSplitsForDocument();
        const splits2 = splits1.map((doc) => this.applyMetadata(doc));
        telemetryClient.trackEvent({ name: "preprocessingCompleted", properties: { accountId: this.accountId, sourceId: this.sourceId, initialSplitCount: splits1.length, postMetadataCount: splits2.length } });

        let splitsDedupList: Document[];
        if (this.hybridSourceLookup() && !this.isWebSite && !this.skipEvidenceExtraction && fullDocument) {
            if (this.deferEvidenceExtraction && !this.checkpointStore?.putStage)
                throw new Error("Deferred hybrid reconciliation requires durable source-partition readiness checkpoints");
            const partitions = await this.documentSecondSplit(splits2);
            const source = new EvidenceSource(fullDocument);
            for (const partition of partitions) Object.assign(partition.metadata,
                { accountId: this.accountId, sourceContentHash: source.contentHash });
            const ids = await this.createIndex(partitions, this.generalIndex!);
            const expected = { sourceContentHash: source.contentHash, count: ids.length, idsHash: partitionIdsHash(ids) };
            const snapshotFingerprint = await this.waitForSourcePartitions(source, expected);
            const manifest = { ...expected, snapshotFingerprint };
            fullDocument.metadata.sourcePartitionManifest = manifest;
            await this.checkpointStore?.putStage?.(partitionManifestIdentity(this.accountId, this.sourceId, source.contentHash), 0, "ready", manifest);
            // Partitions are already indexed. Do not upload them again with new IDs.
            splitsDedupList = this.deferEvidenceExtraction ? [] : await this.extractEvidenceDocumentsForSource(fullDocument);
        } else splitsDedupList = await this.buildSplitsDedupList(splits2, fullDocument);
        await this.checkOpen();

        try {
            if (splitsDedupList.length) await this.createIndex(splitsDedupList, this.generalIndex!);
        } catch (e) {
            telemetryClient.trackException({ exception: e as Error, properties: { accountId: this.accountId, sourceId: this.sourceId, action: "createIndex" } });
            console.error(`Error creating index for source ${this.accountId}, document: ${this.sourceId}`, e);
            throw e;
        }
        await this.clearEvidenceCheckpointsAfterIndexing();
        telemetryClient.trackEvent({ name: "indexCreationCompleted", properties: { accountId: this.accountId, sourceId: this.sourceId } });
        console.info(
            `Completed index for source ${this.accountId}`
        );
        if (this.isWebSite && siteLoader) {
            await siteLoader.sendFilesToBeProcessed();
        }

        return [this.generalIndex!];
    }

    private async waitForSourcePartitions(source: EvidenceSource, manifest: unknown): Promise<string> {
        const lookup = new SourcePartitionSearch(new SearchClient<IndexedSourcePartition>(this.searchEndpoint!, this.generalIndex!, this.defaultCredential, searchDocumentClientOptions),
            this.accountId, this.sourceId, { maxRecords: Number(process.env.EVIDENCE_SOURCE_MAX_PARTITIONS || 2000) });
        const deadline = Date.now() + 30_000;
        const signal = AbortSignal.timeout(30_000);
        let attempts = 0;
        while (true) {
            await this.checkOpen();
            signal.throwIfAborted();
            attempts++;
            try {
                const snapshot = await lookup.snapshot(signal);
                await this.checkOpen();
                validatePartitionManifest(snapshot, manifest, source);
                return snapshot.fingerprint;
            } catch (error) {
                // Search can expose different views between pages immediately after
                // upload. Retry the entire snapshot, never the upload or a partial view.
                if (!(error instanceof SourcePartitionVisibilityError) || Date.now() >= deadline) throw error;
                telemetryClient.trackEvent({ name: "sourcePartitionReadinessRetry",
                    properties: { accountId: this.accountId, sourceId: this.sourceId, reason: error.message },
                    measurements: { attempt: attempts } });
            }
            await delay(500, undefined, { signal });
        }
    }

    /** Runs in the evidence service; the complete Markdown remains intact. */
    async extractEvidence(onSource?: (pageCount: number, characterCount: number) => Promise<void | EvidenceExtractionSelection>): Promise<Document[]> {
        await this.prepareGeneralIndex();
        if (this.isWebSite || this.skipEvidenceExtraction) return [];
        const document = await this.retrieveDocumentFromBlob();
        this.applyMetadata(document, this.extractionPackage ? this.extractionPackage.literalPages.map(page => page.pageNumber)
            : legacySourcePages(document.pageContent).map((_, i) => i + 1));
        const routed = await onSource?.(new EvidenceSource(document).pages.length, document.pageContent.length);
        const mode = routed ?? await resolveEvidenceExtractionMode(this.accountId, this.evidenceExtractionMode);
        if (mode === "skip") return [];
        if (this.hybridSourceLookup()) document.metadata.sourcePartitionManifest = await this.checkpointStore?.getStage?.(
            partitionManifestIdentity(this.accountId, this.sourceId, new EvidenceSource(document).contentHash), 0, "ready");
        const extractor = new EvidenceExtractor(this.accountId, this.sourceId, undefined, this.checkpointStore, undefined, mode,
            this.duplicateEvidenceEmbeddings(),
            this.isCurrentOrder ? async () => undefined : undefined);
        const documents = await extractor.generateDocuments(document);
        return this.extractionPackage ? attachEvidenceLocations(documents, this.extractionPackage) : documents;
    }

    /** CurrentOrder partitions carry tags, which the hybrid lookup filter excludes, so those sources stay local. */
    private hybridSourceLookup(): boolean {
        return sourceLookupMode() === "hybrid" && !this.isCurrentOrder;
    }

    private duplicateEvidenceEmbeddings() {
        const cache = () => {
            if (!this.embeddingCache) this.prepareEmbeddings();
            return this.embeddingCache!;
        };
        return {get fingerprint() {return cache().fingerprint;}, vectors: (texts: readonly string[]) => cache().vectors(texts)};
    }

    /** Runs under the ingestion API's source queue and order fence. */
    async indexEvidenceDocuments(documents: Document[], jobId: string,
        checkOpen: () => Promise<void> = async () => { }): Promise<string[]> {
        this.checkOpen = checkOpen;
        await this.checkOpen();
        await this.prepareGeneralIndex();
        this.prepareEmbeddings();
        this.currentPosition = 1_000_000;
        for (const document of documents) document.metadata.evidenceJobId = jobId;
        await this.createIndex(documents, this.generalIndex!, jobId);
        return [this.generalIndex!];
    }

    private async retrieveDocumentFromBlob(): Promise<Document> {
        try {
            const blobServiceClient = new BlobServiceClient(this.accountUrl, this.defaultCredential);
            const containerClient: ContainerClient = blobServiceClient.getContainerClient(this.containerName);
            if (this.extractionContainerPath) {
                const packageBlob = containerClient.getBlobClient(this.extractionContainerPath);
                const result = await packageBlob.download();
                const bytes = await this.streamToBuffer(result.readableStreamBody!);
                this.extractionPackage = parseExtractionPackage(JSON.parse(bytes.toString("utf8")));
                if (this.extractionPackage.accountId !== this.accountId || this.extractionPackage.sourceId !== this.sourceId)
                    throw new Error("Extraction package belongs to another account or source");
                return literalDocument(this.extractionPackage);
            }
            this.blobClient = containerClient.getBlobClient(this.containerPath);

            if (!(await this.blobClient.exists())) {
                console.error(`Input parameters (${this.accountId}, ${this.sourceId}) do not reference an existing document`);
                throw new Error(`Missing document for ${this.accountId}:${this.sourceId}`);
            }

            const response = await this.blobClient.download();
            if (response.contentType?.includes("application/pdf")) {
                throw new Error("PDF documents are not supported in this processor");
            }
            const documentContentRaw = await this.streamToBuffer(response.readableStreamBody!);
            if (await isNotText(documentContentRaw)) {
                throw new Error("PDF documents are not supported in this processor");
            }
            console.info(
                `Partitioning source ${this.accountId} for ingress. Document: ${crypto
                    .createHash("sha384")
                    .update(documentContentRaw)
                    .digest("hex")} of size ${documentContentRaw.length}`
            );

            if (documentContentRaw.length > constants.MAX_STRING_LENGTH) {
                throw new Error("Source document exceeds the maximum supported text length");
            }
            const documentContent = documentContentRaw.toString("utf-8");
            return new Document({ pageContent: documentContent });
        } catch (error) {
            telemetryClient.trackException({ exception: error instanceof Error ? error : new Error(String(error)), properties: { accountId: this.accountId, sourceId: this.sourceId, action: "retrieveDocumentsFromBlob" } });
            throw error;
        }
    }

    private splitText(content: string): Document[] {
        const splitter = new ExperimentalMarkdownSyntaxTextSplitter(null, false, false);
        const documents = splitter.splitText(content);
        return documents;
    }

    private applyMetadata(doc: Document, pages?: number[]): Document {
        doc.metadata = doc.metadata || {};
        if (!doc.metadata.title) doc.metadata.title = this.filename;
        if (!doc.metadata.source) doc.metadata.source = this.sourceUrl;
        if (!doc.metadata.sourceId) doc.metadata.sourceId = this.sourceId;
        doc.metadata.tags = this.isCurrentOrder ? ["CurrentOrder"] : [];
        if (pages) {
            doc.metadata.pages = pages;
        }
        return doc;
    }

    private async documentSecondSplit(docs: Document[]): Promise<Document[]> {
        const EMBEDDING_BATCH_SIZE = 10; // Process 10 documents at a time
        const docBatches = this.splitList(docs, EMBEDDING_BATCH_SIZE);
        const encoding = get_encoding("cl100k_base");

        const allBatchResults: Document[][] = [];
        for (const batch of docBatches) {
            await this.checkOpen();
            console.info(`Processing embedding validation batch of ${batch.length} documents`);
            const batchPromises = batch.map(async (doc) => {
                const content = doc.pageContent;
                // Tokenize the content to check its length
                const approximate_tokens = encoding.encode(content).length;
                console.info(`Processing document with ${approximate_tokens} unique tokens from ${doc.metadata.sourceId}-${doc.metadata.source}.`);
                if (approximate_tokens > 6000) {
                    try {
                        await this.aoaiEmbeddingsSmall!.embedQuery(doc.pageContent);
                    } catch {
                        const splitter = new TokenTextSplitter({ encodingName: "cl100k_base", chunkSize: 5000, chunkOverlap: 0 });
                        console.warn(`Document ${doc.metadata.sourceId}-${doc.metadata.source} is large, splitting further.`);
                        // Split large documents further
                        const partitions = await splitter.splitDocuments([doc], { appendChunkOverlapHeader: false });
                        if (partitions.length <= 1) {
                            console.error(`Document ${doc.metadata.sourceId}-${doc.metadata.source} did not split correctly.`);
                            return [doc];
                        }
                        return this.documentSecondSplit(partitions);
                    }
                    return [doc];
                } else {
                    return [doc];
                }
            });

            allBatchResults.push(...await Promise.all(batchPromises)); // NOSONAR: Sequential batches limit embedding-validation requests to 10 in flight.
        }

        const result = allBatchResults.flat();
        console.log(`After second split, reduced to ${result.length} documents.`);
        return result;
    }

    private generatePageIndices(docs: Document[]): Document[] {
        const splits: Document[] = [];
        let pageIndex = 1;

        docs.forEach((doc) => {
            const pageBreakCount = (doc.pageContent.match(new RegExp(PAGE_BREAK, "g")) || []).length;
            const lastPage = pageIndex + pageBreakCount;
            const pages = pageIndex < lastPage ? Array.from({ length: lastPage - pageIndex + 1 }, (_, i) => pageIndex + i) : [pageIndex];
            pageIndex = lastPage;
            splits.push(this.applyMetadata(doc, pages));
        });

        return splits;
    }

    private async createIfIndexDoesNotExist(client: SearchIndexClient, indexName: string): Promise<void> {
        try {
            await ensureEvidenceSearchFields(client, indexName);
            console.log(`Index "${indexName}" already exists.`);
        } catch (error: any) {
            if (error.statusCode === 404) {
                telemetryClient?.trackEvent({
                    name: "searchIndexCreationStarted",
                    properties: {
                        accountId: this.accountId,
                        sourceId: this.sourceId,
                        indexName: indexName,
                    },
                });
                const prioritizedFields: SemanticPrioritizedFields = {
                    titleField: { name: "title" },
                    contentFields: [{ name: "title" }, { name: "content" }],
                    keywordsFields: [
                        { name: "title" },
                        { name: "source" },
                        { name: "metadata" },
                    ],
                };

                const indexSchema: SearchIndex = {
                    name: indexName,
                    fields: await this.prepareFields(),
                    semanticSearch: {
                        defaultConfigurationName: "Primary",
                        configurations: [
                            {
                                name: "Primary",
                                prioritizedFields: prioritizedFields
                            },
                        ]
                    },
                    vectorSearch: {
                        profiles: [
                            {
                                name: "myHnswProfileNew",
                                algorithmConfigurationName: "vector-config-1792677462851",
                            },
                            {
                                name: "myExhaustiveKnnProfile",
                                algorithmConfigurationName: "default_exhaustive_knn"
                            }
                        ],
                        algorithms: [
                            {
                                name: "default",
                                kind: "hnsw",
                                parameters: {
                                    metric: "cosine",
                                    m: 4,
                                    efConstruction: 400,
                                    efSearch: 500
                                }
                            },
                            {
                                name: "default_exhaustive_knn",
                                kind: "exhaustiveKnn",
                                parameters: {
                                    metric: "cosine"
                                }
                            },
                            {
                                name: "vector-config-1792677462851",
                                kind: "hnsw",
                                parameters: {
                                    metric: "cosine",
                                    m: 8,
                                    efConstruction: 700,
                                    efSearch: 850
                                }
                            }
                        ]
                    }
                }
                // Index does not exist, create it
                try {
                    await client.createIndex(indexSchema);
                } catch (createError: any) {
                    if (createError.statusCode !== 409) throw createError;
                    // Another source in this account created the same index concurrently.
                    await ensureEvidenceSearchFields(client, indexName);
                    return;
                }
                telemetryClient?.trackEvent({
                    name: "searchIndexCreationCompleted",
                    properties: {
                        accountId: this.accountId,
                        sourceId: this.sourceId,
                        indexName: indexName,
                    },
                });
                console.log(`Index "${indexName}" created successfully.`);
            } else {
                telemetryClient?.trackException({
                    exception: error instanceof Error ? error : new Error(String(error)),
                    properties: {
                        accountId: this.accountId,
                        sourceId: this.sourceId,
                        indexName: indexName,
                        action: "checkOrCreateIndex"
                    },
                });
                console.error("Error checking index existence:", error);
                // Other errors
                throw error;
            }
        }
    }

    private async createIndex(docs: Document[], indexName: string, evidenceJobId?: string): Promise<string[]> {
        console.info(`Creating index entry for source ${this.accountId}, document: ${this.sourceId}`);
        const client = new SearchIndexClient(this.searchEndpoint!, this.defaultCredential);
        await this.createIfIndexDoesNotExist(client, indexName);

        const searchIndexClient = new SearchClient(this.searchEndpoint!, indexName, this.defaultCredential, searchDocumentClientOptions);

        const chunkedDocs = this.splitList(docs, 25);
        const indexedIds: string[] = [];
        const indexingAttemptId = evidenceJobId ? crypto.randomUUID() : undefined;
        let completedSourceDocuments = 0;
        if (evidenceJobId) telemetryClient?.trackEvent({
            name: "EvidenceIndexingStarted", properties: {
                accountId: this.accountId, sourceId: this.sourceId, jobId: evidenceJobId, indexingAttemptId: indexingAttemptId!,
                totalSourceDocuments: String(docs.length), completedSourceDocuments: "0",
            }
        });
        for (const chunk of chunkedDocs) {
            await this.checkOpen();
            const vectors = this.embeddingCache ? await this.embeddingCache.vectors(chunk.map(doc => doc.pageContent)) : undefined;
            const newDocs: object[][] = [];
            for (const [index, doc] of chunk.entries()) {
                newDocs.push(vectors?.[index] === null ? await this.splitDocumentEntry(doc)
                    : await this.generateDocumentEntry(doc, vectors?.[index] ?? undefined));
            }
            const flattenedDocs = newDocs.flat();
            await this.checkOpen();
            try {
                const result = await searchIndexClient.uploadDocuments(flattenedDocs, { throwOnAnyFailure: true }); // NOSONAR: Sequential chunk uploads bound Azure Search request concurrency.
                console.info(`Added indexes for source ${this.accountId}, document: ${this.sourceId}, indexes: ${result.results.map(x => x.key).join(",")}`);
            } catch (e) {
                for (const doc of flattenedDocs) {
                    await this.checkOpen();
                    try {
                        const result2 = await searchIndexClient.uploadDocuments([doc], { throwOnAnyFailure: true }); // NOSONAR: Sequential retries prevent a failed chunk from causing a request burst.
                        console.info(`Second attempt: Added indexes for source ${this.accountId}, document: ${this.sourceId}, indexes: ${result2.results.map(x => x.key).join(",")}`);
                        telemetryClient?.trackEvent({
                            name: "attemptedDocumentsIndexedFailedThenSucceeded",
                            properties: {
                                accountId: this.accountId,
                                sourceId: this.sourceId,
                                indexName: indexName,
                                documentCount: 1,
                            },
                        });
                    } catch (error_) {
                        telemetryClient?.trackException({
                            exception: error_ instanceof Error ? error_ : new Error(String(error_)),
                            properties: {
                                accountId: this.accountId,
                                sourceId: this.sourceId,
                                indexName: indexName,
                                documentId: (doc as any).id,
                                action: "uploadDocument"
                            },
                        });
                        console.error(`Failed document ID: ${(doc as any).id}, Source: ${JSON.stringify(doc)}`, error_);
                        throw e;
                    }
                }
            }
            completedSourceDocuments += chunk.length;
            indexedIds.push(...flattenedDocs.map(doc => (doc as { id: string }).id));
            telemetryClient?.trackEvent({
                name: "documentsIndexed", properties: {
                    accountId: this.accountId, sourceId: this.sourceId, indexName,
                    documentCount: flattenedDocs.length,
                    ...(evidenceJobId ? {
                        jobId: evidenceJobId, indexingAttemptId: indexingAttemptId!,
                        completedSourceDocuments: String(completedSourceDocuments), totalSourceDocuments: String(docs.length)
                    } : {}),
                }
            });
        }
        return indexedIds;
    }

    private async generateDocumentEntry(oldDoc: Document, savedVector?: number[]): Promise<object[]> {
        let vectorContent: number[];
        try {
            vectorContent = savedVector ?? await this.aoaiEmbeddings!.embedQuery(oldDoc.pageContent);
        } catch (e) {
            console.error(`Error embedding document content for source ${this.accountId}, document: ${this.sourceId} - ${oldDoc.metadata.source}`, e);
            return await this.splitDocumentEntry(oldDoc);
        }
        const { pos: _pos, prv: _prv, nxt: _nxt, ...identityMetadata } = oldDoc.metadata;
        const jsonifiedDocument = JSON.stringify({ pageContent: oldDoc.pageContent, metadata: identityMetadata });
        const id = crypto
            .createHash("sha384")
            .update(oldDoc.metadata.evidenceJobId
                ? `${this.accountId}_${this.sourceId}_${jsonifiedDocument}`
                : `${jsonifiedDocument}_${Date.now().valueOf()}`)
            .digest("base64")
            .replaceAll('=', '')
            .replaceAll('+', '')
            .replaceAll('/', '');
        const adjDoc = this.applyPositionMetadata(oldDoc);
        const newDoc = {
            id: id,
            content: oldDoc.pageContent,
            content_vector: vectorContent,
            metadata: JSON.stringify(adjDoc.metadata),
            title: adjDoc.metadata['title'],
            source: adjDoc.metadata.source,
            sourceId: adjDoc.metadata['sourceId'],
            tags: adjDoc.metadata['tags'],
            pos: adjDoc.metadata['pos'],
            pages: adjDoc.metadata['pages'],
            hitCount: adjDoc.metadata['hitCount'] || 1,
            where: adjDoc.metadata['where'],
            whenStarted: adjDoc.metadata['whenStarted'],
            whenEnded: adjDoc.metadata['whenEnded'],
            asOf: adjDoc.metadata['asOf'] ?? null,
            what: adjDoc.metadata['what'],
            who: adjDoc.metadata['who'],
            why: adjDoc.metadata['why'],
            how: adjDoc.metadata['how'],
            sourceType: adjDoc.metadata.sourceType ?? null,
            contentOrigin: adjDoc.metadata.contentOrigin ?? null,
            extractionProvider: adjDoc.metadata.extractionProvider ?? null,
            analysisId: adjDoc.metadata.analysisId ?? null,
            evidenceExtractionMode: adjDoc.metadata.evidenceExtractionMode ?? null,
            ...evidenceSearchValues(adjDoc.metadata),
            startTimeMs: adjDoc.metadata.startTimeMs ?? null,
            endTimeMs: adjDoc.metadata.endTimeMs ?? null,
        }
        return [newDoc];
    }

    private async splitDocumentEntry(oldDoc: Document): Promise<object[]> {
        const partitions = await this.docSplitter(oldDoc);
        if (partitions.length <= 1) {
            throw new Error("Document did not split correctly");
        }

        const results: object[] = [];
        for (const partition of partitions) {
            results.push(...await this.generateDocumentEntry(partition)); // NOSONAR: Assign positions in source order, including recursive fallback splits.
        }
        return results;
    }

    private async docSplitter(doc: Document): Promise<Document[]> {
        if (doc.metadata.pages && doc.metadata.pages.length > 1) {
            const pages = doc.pageContent.split(PAGE_BREAK);
            const documents: Document[] = [];
            const isMatchedPages = doc.metadata.pages.length === pages.length;
            for (let i = 0; i < pages.length; i++) {
                const pageContent = pages[i];
                const pageDoc = new Document({
                    pageContent: pageContent,
                    metadata: {
                        ...doc.metadata,
                        pages: isMatchedPages ? [doc.metadata.pages[i]] : doc.metadata.pages
                    },
                });
                documents.push(pageDoc);
            }
            return documents;
        }

        const splitter = new TokenTextSplitter({ encodingName: "cl100k_base", chunkSize: 3000, chunkOverlap: 0 });
        const partitions = await splitter.splitDocuments([doc], { appendChunkOverlapHeader: false });
        return partitions;
    }

    private async prepareFields(): Promise<SearchField[]> {
        const dimensions = this.aoaiEmbeddings.dimensions || await this.aoaiEmbeddings.embedQuery("today").then(vectors => vectors.length);
        return [
            { name: "id", type: "Edm.String" as SearchFieldDataType, key: true, filterable: true },
            { name: "content", type: "Edm.String" as SearchFieldDataType, searchable: true },
            {
                name: "content_vector",
                type: "Collection(Edm.Single)" as SearchFieldDataType,
                searchable: true,
                // Fields cannot become retrievable after creation; evidence review reuses stored vectors.
                hidden: false,
                stored: true,
                vectorSearchDimensions: dimensions,
                vectorSearchProfileName: "myHnswProfileNew",
            },
            { name: "metadata", type: "Edm.String" as SearchFieldDataType, searchable: true },
            { name: "title", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true },
            { name: "source", type: "Edm.String" as SearchFieldDataType, filterable: true },
            { name: "sourceId", type: "Edm.String" as SearchFieldDataType, filterable: true, facetable: true },
            { name: "tags", type: "Collection(Edm.String)" as SearchFieldDataType, filterable: true, facetable: true },
            { name: "pos", type: "Edm.Int32" as SearchFieldDataType, filterable: true, sortable: true },
            { name: "pages", type: "Collection(Edm.Int32)" as SearchFieldDataType, filterable: true },
            { name: "hitCount", type: "Edm.Int32" as SearchFieldDataType, filterable: true, sortable: true, facetable: true },
            { name: "where", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true, facetable: true },
            { name: "what", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true, facetable: true },
            { name: "who", type: "Collection(Edm.String)" as SearchFieldDataType, searchable: true, filterable: true, facetable: true },
            { name: "why", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true, facetable: true },
            asOfSearchField(),
            ...extractionSearchFields(),
            ...evidenceRetrievalFields(),
            {
                name: "whenStarted", type: "Edm.ComplexType" as SearchFieldDataType, fields: [
                    { name: "year", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true, facetable: true, sortable: true },
                    { name: "month", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true, facetable: true, sortable: true },
                    { name: "day", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true, facetable: true, sortable: true },
                    { name: "season", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true, facetable: true },
                    { name: "quarter", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true, facetable: true }
                ]
            },
            {
                name: "whenEnded", type: "Edm.ComplexType" as SearchFieldDataType, fields: [
                    { name: "year", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true, facetable: true, sortable: true },
                    { name: "month", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true, facetable: true, sortable: true },
                    { name: "day", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true, facetable: true, sortable: true },
                    { name: "season", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true, facetable: true },
                    { name: "quarter", type: "Edm.String" as SearchFieldDataType, searchable: true, filterable: true, facetable: true }
                ]
            },
        ];
    }

    private splitList<T>(list: T[], chunkSize: number): T[][] {
        const result: T[][] = [];
        for (let i = 0; i < list.length; i += chunkSize) {
            result.push(list.slice(i, i + chunkSize));
        }
        return result;
    }

    private async streamToBuffer(readableStream: NodeJS.ReadableStream | null): Promise<Buffer> {
        if (!readableStream) {
            throw new Error("Readable stream is null");
        }

        const chunks: Buffer[] = [];
        for await (const chunk of readableStream) {
            if (chunk instanceof Buffer) {
                chunks.push(Buffer.from(chunk));
            }
        }
        return Buffer.concat(chunks);
    }
}
