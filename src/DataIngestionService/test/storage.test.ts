import { afterEach, describe, expect, it, vi } from "vitest";
import type { IHttpClient } from "@azure/storage-blob";
import { createBlobServiceClient, createCheckpointBlobServiceClient, createQueueServiceClient, storageAccountName } from "../src/storage.js";

afterEach(() => vi.unstubAllEnvs());

describe("RBAC storage clients", () => {
  it.each(["examplestoragetest", "examplestorageprod"])(
    "uses bearer tokens for %s while ignoring legacy account keys", async account => {
    vi.stubEnv("STORAGE_ACCOUNT_NAME", account);
    vi.stubEnv("BLOB_CONNECTION_STRING", "AccountName=oldaccount;AccountKey=legacy-key");
    vi.stubEnv("EVIDENCE_QUEUE_STORAGE_CONNECTION_STRING", "AccountName=oldqueue;AccountKey=legacy-key");
    vi.stubEnv("CHECKPOINT_STORAGE_CONNECTION_STRING", "AccountName=oldcheckpoints;AccountKey=legacy-key");
    const credential = {getToken: vi.fn(async (scopes: string | string[]) => {
      expect([scopes].flat()).toContain("https://storage.azure.com/.default");
      return {token: "rbac-test-token", expiresOnTimestamp: Date.now() + 3_600_000};
    })};
    const requests: {url: string; authorization: string | undefined}[] = [];
    const httpClient: IHttpClient = {async sendRequest(request) {
      requests.push({url: request.url, authorization: request.headers.get("authorization")});
      return {request, status: 201, headers: request.headers, bodyAsText: ""};
    }};
    await createBlobServiceClient(credential, {httpClient}).getContainerClient("test-state").createIfNotExists();
    await createQueueServiceClient(credential, {httpClient}).getQueueClient("test-evidence").createIfNotExists();
    await createCheckpointBlobServiceClient(credential, {httpClient}).getContainerClient("checkpoints").createIfNotExists();
    expect(requests).toHaveLength(3);
    expect(requests.map(request => new URL(request.url).hostname)).toEqual([
      `${account}.blob.core.windows.net`, `${account}.queue.core.windows.net`, `${account}.blob.core.windows.net`,
    ]);
    expect(requests.every(request => request.authorization === "Bearer rbac-test-token")).toBe(true);
    expect(credential.getToken.mock.calls.flatMap(([scopes]) => scopes)).toContain("https://storage.azure.com/.default");
  });

  it("keeps service-URL runtime settings working without an account-name setting", async () => {
    vi.stubEnv("STORAGE_ACCOUNT_NAME", undefined);
    vi.stubEnv("BLOB_CONNECTION_STRING", "https://examplestorageprod.blob.core.windows.net");
    vi.stubEnv("EVIDENCE_QUEUE_STORAGE_CONNECTION_STRING", "https://examplestorageprod.blob.core.windows.net");
    vi.stubEnv("CHECKPOINT_STORAGE_CONNECTION_STRING", "https://examplestorageprod.blob.core.windows.net");
    const credential = {getToken: vi.fn(async () => ({token: "rbac-test-token", expiresOnTimestamp: Date.now() + 3_600_000}))};
    const requests: {url: string; authorization: string | undefined}[] = [];
    const httpClient: IHttpClient = {async sendRequest(request) {
      requests.push({url: request.url, authorization: request.headers.get("authorization")});
      return {request, status: 201, headers: request.headers, bodyAsText: ""};
    }};
    await createBlobServiceClient(credential, {httpClient}).getContainerClient("input").createIfNotExists();
    await createQueueServiceClient(credential, {httpClient}).getQueueClient("evidence").createIfNotExists();
    await createCheckpointBlobServiceClient(credential, {httpClient}).getContainerClient("checkpoints").createIfNotExists();
    expect(requests.map(request => new URL(request.url).hostname)).toEqual([
      "examplestorageprod.blob.core.windows.net", "examplestorageprod.queue.core.windows.net",
      "examplestorageprod.blob.core.windows.net",
    ]);
    expect(requests.every(request => request.authorization === "Bearer rbac-test-token")).toBe(true);
    expect(storageAccountName()).toBe("examplestorageprod");
  });

  it("retains legacy checkpoint routing when the account-name setting is absent", () => {
    vi.stubEnv("STORAGE_ACCOUNT_NAME", undefined);
    vi.stubEnv("BLOB_CONNECTION_STRING", "https://contentaccount.blob.core.windows.net");
    vi.stubEnv("CHECKPOINT_STORAGE_CONNECTION_STRING", "https://checkpointaccount.blob.core.windows.net");
    expect(createBlobServiceClient().accountName).toBe("contentaccount");
    expect(createCheckpointBlobServiceClient().accountName).toBe("checkpointaccount");
  });

  it.each([undefined, "", "old-account", "AccountName=old;AccountKey=key", "https://example.test", "account\n"])(
    "requires a valid account name rather than accepting connection strings: %s", value => {
      vi.stubEnv("STORAGE_ACCOUNT_NAME", value);
      expect(storageAccountName).toThrow("STORAGE_ACCOUNT_NAME");
    },
  );
});
