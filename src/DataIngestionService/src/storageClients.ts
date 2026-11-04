import { DefaultAzureCredential } from "@azure/identity";
import type { TokenCredential } from "@azure/core-auth";
import { BlobServiceClient, type StoragePipelineOptions } from "@azure/storage-blob";
import { QueueServiceClient, type StoragePipelineOptions as QueuePipelineOptions } from "@azure/storage-queue";

let credential: DefaultAzureCredential | undefined;
const storageCredential = () => credential ??= new DefaultAzureCredential();

// Existing configuration keys accept a service URL after the storage cutover.
// Connection strings remain supported for existing deployments and Azurite.
function endpoint(source: string, service: "blob" | "queue"): string | undefined {
  if (!source.toLowerCase().startsWith("https://")) return undefined;
  const url = new URL(source);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Storage identity configuration requires a service URL without credentials or a path");
  }
  url.hostname = url.hostname.replace(/\.(blob|queue)\.core\./, `.${service}.core.`);
  return url.toString();
}

export function blobServiceClient(source: string, tokenCredential: TokenCredential = storageCredential(),
  options?: StoragePipelineOptions): BlobServiceClient {
  const url = endpoint(source, "blob");
  return url ? new BlobServiceClient(url, tokenCredential, options)
    : BlobServiceClient.fromConnectionString(source, options);
}

export function queueServiceClient(source: string, tokenCredential: TokenCredential = storageCredential(),
  options?: QueuePipelineOptions): QueueServiceClient {
  const url = endpoint(source, "queue");
  return url ? new QueueServiceClient(url, tokenCredential, options)
    : QueueServiceClient.fromConnectionString(source, options);
}
