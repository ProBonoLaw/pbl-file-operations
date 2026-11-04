import { createHash } from "node:crypto";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import type { EventOrder } from "./models/request.js";
import { createBlobServiceClient } from "./storage.js";

export type OperationKind = "ingest" | "remove";

export interface AppliedEventOrder extends EventOrder {
  operation: OperationKind;
}

export interface OperationOrderStore {
  get(accountId: string, sourceId: string): Promise<AppliedEventOrder | null>;
  put(accountId: string, sourceId: string, order: AppliedEventOrder): Promise<void>;
}

// The API Deployment uses one replica. Its per-source queue serializes read, apply,
// and write; Blob Storage keeps the fence across pod restarts and event replays.
export class BlobOperationOrderStore implements OperationOrderStore {
  private readonly container: ContainerClient;
  private initialized?: Promise<void>;

  constructor(blobs: BlobServiceClient = createBlobServiceClient()) {
    this.container = blobs
      .getContainerClient(process.env.OPERATION_ORDER_CONTAINER || "file-operations-operation-order");
  }

  async get(accountId: string, sourceId: string): Promise<AppliedEventOrder | null> {
    await this.ensureContainer();
    const blob = this.container.getBlobClient(blobName(accountId, sourceId));
    try {
      const content = await blob.downloadToBuffer();
      return JSON.parse(content.toString("utf8")) as AppliedEventOrder;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async put(accountId: string, sourceId: string, order: AppliedEventOrder): Promise<void> {
    await this.ensureContainer();
    const blob = this.container.getBlockBlobClient(blobName(accountId, sourceId));
    await blob.uploadData(Buffer.from(JSON.stringify(order)), {
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
  }

  private ensureContainer(): Promise<void> {
    this.initialized ??= this.container.createIfNotExists().then(() => undefined).catch((error: unknown) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }
}

export function compareEventOrder(next: AppliedEventOrder, previous: AppliedEventOrder): number {
  if (next.partitionId === previous.partitionId) {
    return compareIntegerStrings(next.sequenceNumber, previous.sequenceNumber);
  }
  const byEnqueueTime = compareIntegerStrings(next.enqueuedTicks, previous.enqueuedTicks);
  if (byEnqueueTime !== 0) return byEnqueueTime;
  if (next.operation !== previous.operation) return next.operation === "remove" ? 1 : -1;
  // No order can be established for two events with the same broker tick on
  // different partitions. Keep the first applied operation.
  return -1;
}

function compareIntegerStrings(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function blobName(accountId: string, sourceId: string): string {
  return createHash("sha256").update(accountId).update("\0").update(sourceId).digest("hex") + ".json";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "statusCode" in error && error.statusCode === 404;
}
