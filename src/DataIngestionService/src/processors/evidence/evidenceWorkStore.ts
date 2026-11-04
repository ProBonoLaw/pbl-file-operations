import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { createHash } from "node:crypto";
import { Document } from "@langchain/core/documents";
import type { FileIngestionWork } from "../../models/request.js";
import { createBlobServiceClient } from "../../storage.js";

export interface EvidenceWorkRecord {
  request: FileIngestionWork;
  status: "queued" | "extracted" | "completed";
  attempts: number;
  retryBudget?: import("./evidenceRetryPolicy.js").EvidenceRetryBudget;
  extractionMode?: import("./evidenceExtractionMode.js").EvidenceExtractionSelection;
}

export interface EvidenceWorkStore {
  enqueue(request: FileIngestionWork): Promise<void>;
  get(jobId: string): Promise<EvidenceWorkRecord | null>;
  documents(jobId: string): Promise<Document[]>;
  indexResult(jobId: string): Promise<{ indexes: string[] } | null>;
  saveIndexResult(jobId: string, result: { indexes: string[] }): Promise<void>;
}

export interface EvidenceJobStore extends EvidenceWorkStore {
  saveDocuments(jobId: string, documents: Document[]): Promise<void>;
  removeDocuments(jobId: string): Promise<void>;
  withLease(jobId: string, apply: (record: EvidenceWorkRecord,
    save: (value: EvidenceWorkRecord) => Promise<void>, assertOwned: () => void) => Promise<void>): Promise<boolean>;
}

/** Durable stage handoff, keyed by the original broker event rather than a delivery attempt. */
export class BlobEvidenceWorkStore implements EvidenceJobStore {
  private readonly container: ContainerClient;
  private initialized?: Promise<void>;

  constructor(blobs: BlobServiceClient = createBlobServiceClient()) {
    this.container = blobs
      .getContainerClient(process.env.EVIDENCE_WORK_CONTAINER || "file-operations-evidence-work");
  }

  async enqueue(request: FileIngestionWork): Promise<void> {
    await this.ensureContainer();
    try {
      await this.container.getBlockBlobClient(this.name(request.jobId))
        .uploadData(Buffer.from(JSON.stringify({ request, status: "queued", attempts: 0 })),
          { conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/json" } });
    } catch (error) {
      if (!hasStatus(error, 409, 412)) throw error;
      const existing = await this.get(request.jobId);
      if (!existing || JSON.stringify(existing.request) !== JSON.stringify(request))
        throw new Error("Evidence job identity was reused with different input", { cause: error });
    }
  }

  async get(jobId: string): Promise<EvidenceWorkRecord | null> {
    await this.ensureContainer();
    try {
      const data = await this.container.getBlobClient(this.name(jobId)).downloadToBuffer();
      return JSON.parse(data.toString("utf8")) as EvidenceWorkRecord;
    } catch (error) {
      if (hasStatus(error, 404)) return null;
      throw error;
    }
  }

  async documents(jobId: string): Promise<Document[]> {
    const buffer = await this.container.getBlobClient(this.resultName(jobId)).downloadToBuffer();
    const rows: unknown = JSON.parse(buffer.toString("utf8"));
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.pageContent !== "string" ||
      typeof row.metadata !== "object" || row.metadata === null)) throw new Error("Invalid persisted evidence documents");
    return rows.map(row => new Document({ pageContent: row.pageContent, metadata: row.metadata }));
  }

  async saveDocuments(jobId: string, documents: Document[]): Promise<void> {
    await this.container.getBlockBlobClient(this.resultName(jobId))
      .uploadData(Buffer.from(JSON.stringify(documents)), { blobHTTPHeaders: { blobContentType: "application/json" } });
  }

  async indexResult(jobId: string): Promise<{ indexes: string[] } | null> {
    try {
      const data = await this.container.getBlobClient(this.indexResultName(jobId)).downloadToBuffer();
      const result: unknown = JSON.parse(data.toString("utf8"));
      if (!result || typeof result !== "object" || !("indexes" in result) ||
          !Array.isArray(result.indexes) || result.indexes.some(index => typeof index !== "string"))
        throw new Error("Invalid persisted evidence indexing result");
      return { indexes: result.indexes };
    } catch (error) {
      if (hasStatus(error, 404)) return null;
      throw error;
    }
  }

  async saveIndexResult(jobId: string, result: { indexes: string[] }): Promise<void> {
    // Separate from the job blob: the finalizer holds that blob's lease while
    // calling the API. Keep this receipt after temporary documents are removed.
    await this.container.getBlockBlobClient(this.indexResultName(jobId))
      .uploadData(Buffer.from(JSON.stringify(result)), { blobHTTPHeaders: { blobContentType: "application/json" } });
  }

  async removeDocuments(jobId: string): Promise<void> {
    await this.container.getBlobClient(this.resultName(jobId)).deleteIfExists();
  }

  async withLease(jobId: string, apply: (record: EvidenceWorkRecord,
    save: (value: EvidenceWorkRecord) => Promise<void>, assertOwned: () => void) => Promise<void>): Promise<boolean> {
    const blob = this.container.getBlockBlobClient(this.name(jobId));
    const lease = blob.getBlobLeaseClient();
    try { await lease.acquireLease(60); }
    catch (error) { if (hasStatus(error, 409, 412)) return false; throw error; }
    let leaseError: unknown;
    let renewing: Promise<void> | undefined;
    const assertOwned = (): void => { if (leaseError) throw new Error("Evidence job lease was lost", { cause: leaseError }); };
    const timer = setInterval(() => {
      renewing ??= lease.renewLease().then(() => undefined).catch((error: unknown) => { leaseError = error; })
        .finally(() => { renewing = undefined; });
    }, 20_000);
    try {
      const record = await this.get(jobId);
      if (!record || record.status === "completed") return false;
      await apply(record, async value => {
        assertOwned();
        await blob.uploadData(Buffer.from(JSON.stringify(value)), {
          conditions: { leaseId: lease.leaseId }, blobHTTPHeaders: { blobContentType: "application/json" },
        });
      }, assertOwned);
      return true;
    } finally {
      clearInterval(timer);
      await renewing;
      await lease.releaseLease().catch(() => undefined);
    }
  }

  private name(jobId: string): string { return `jobs/${createHash("sha256").update(jobId).digest("hex")}.json`; }
  private resultName(jobId: string): string { return `results/${createHash("sha256").update(jobId).digest("hex")}.json`; }
  private indexResultName(jobId: string): string { return `indexed/${createHash("sha256").update(jobId).digest("hex")}.json`; }
  private ensureContainer(): Promise<void> {
    this.initialized ??= this.container.createIfNotExists().then(() => undefined).catch((error: unknown) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }
}

function hasStatus(error: unknown, ...statuses: number[]): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error &&
    statuses.includes(Number(error.statusCode));
}
