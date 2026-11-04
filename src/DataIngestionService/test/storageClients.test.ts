import { describe, expect, it } from "vitest";
import { blobServiceClient, queueServiceClient } from "../src/storageClients.js";

describe("storage clients", () => {
  it("uses workload identity URLs for blob and queue services", () => {
    const source = "https://examplestoragetest.blob.core.windows.net";
    expect(blobServiceClient(source).url).toBe(`${source}/`);
    expect(queueServiceClient(source).url).toBe("https://examplestoragetest.queue.core.windows.net/");
    expect(blobServiceClient("https://examplestoragetest.queue.core.windows.net").url).toBe(`${source}/`);
  });
  it("keeps existing Azurite connection strings working", () => {
    expect(blobServiceClient("UseDevelopmentStorage=true").accountName).toBe("devstoreaccount1");
    expect(queueServiceClient("UseDevelopmentStorage=true").accountName).toBe("devstoreaccount1");
  });
  it("rejects SAS URLs and container paths as service configuration", () => {
    expect(() => blobServiceClient("https://example.blob.core.windows.net/?sig=secret")).toThrow(/service URL/);
    expect(() => queueServiceClient("https://example.queue.core.windows.net/evidence-gather")).toThrow(/service URL/);
  });
});
