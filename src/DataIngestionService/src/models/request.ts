export interface BaseRequest {
    sourceId: string;
    accountId: string;
    eventOrder?: EventOrder;
}

export interface EventOrder {
    enqueuedTicks: string;
    partitionId: string;
    sequenceNumber: string;
}

export interface DataIngestionRequest extends BaseRequest {
    jobId?: string;
    evidenceExtractionMode?: import("../processors/evidence/evidenceExtractionMode.js").EvidenceExtractionModeInput;
    evidenceBudgetOverride?: boolean;
    containerName: string;
    containerPath: string;
    isCurrentOrder?: boolean;
    documentName: string;
    sourceUrl: string;
    isWebSite?: boolean;
    deferEvidenceExtraction?: boolean;
    extractionContainerPath?: string;
}

export interface FileIngestionWork extends DataIngestionRequest {
    jobId: string;
    identifier: string;
    filepath: string;
    progressPartition: string;
    progressRow: string;
    cleanupBlobs: Array<{ containerName: string; containerPath: string }>;
}

export interface EvidenceIndexRequest extends BaseRequest {
    jobId: string;
}
