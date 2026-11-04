import type { TokenCredential } from "@azure/core-auth";
import type { BlobServiceClient, StoragePipelineOptions } from "@azure/storage-blob";
import type { QueueServiceClient, StoragePipelineOptions as QueuePipelineOptions } from "@azure/storage-queue";
import { blobServiceClient, queueServiceClient } from "./storageClients.js";

function configuredAccountName(): string | undefined {
  const name = process.env.STORAGE_ACCOUNT_NAME;
  if (name !== undefined && (!/^[a-z0-9]{3,24}$/.test(name) || name.trim() !== name))
    throw new Error("STORAGE_ACCOUNT_NAME must be a valid Azure storage account name");
  return name;
}

function storageSource(service: "blob" | "queue", setting = service === "blob"
  ? "BLOB_CONNECTION_STRING" : "EVIDENCE_QUEUE_STORAGE_CONNECTION_STRING"): string {
  const name = configuredAccountName();
  if (name !== undefined) return `https://${name}.${service}.core.windows.net`;
  const source = process.env[setting] || process.env.BLOB_CONNECTION_STRING || process.env.CHECKPOINT_STORAGE_CONNECTION_STRING;
  if (!source) throw new Error("STORAGE_ACCOUNT_NAME or a storage service URL is required");
  return source;
}

export function storageAccountName(): string {
  return configuredAccountName() ?? blobServiceClient(storageSource("blob")).accountName;
}

export function createBlobServiceClient(tokenCredential?: TokenCredential,
  options?: StoragePipelineOptions): BlobServiceClient {
  return blobServiceClient(storageSource("blob"), tokenCredential, options);
}

export function createCheckpointBlobServiceClient(tokenCredential?: TokenCredential,
  options?: StoragePipelineOptions): BlobServiceClient {
  return blobServiceClient(storageSource("blob", "CHECKPOINT_STORAGE_CONNECTION_STRING"), tokenCredential, options);
}

export function createQueueServiceClient(tokenCredential?: TokenCredential,
  options?: QueuePipelineOptions): QueueServiceClient {
  return queueServiceClient(storageSource("queue"), tokenCredential, options);
}
