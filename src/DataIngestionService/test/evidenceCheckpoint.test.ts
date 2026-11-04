import { BlobServiceClient } from "@azure/storage-blob";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobEvidenceCheckpointStore, type EvidenceCheckpointIdentity } from "../src/processors/evidence/evidenceCheckpoint.ts";
import {partitionManifestIdentity} from "../src/processors/evidence/evidenceSourceLookup.ts";

import { withReconciliationDeadline, reconciliationCheckpointGuard, reconciliationSignal,
  EvidenceReconciliationTimeoutError } from "../src/processors/evidence/evidenceReconciliationDeadline.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}
const storage = vi.hoisted(() => ({
  blobs: new Map<string, { content: Buffer; lastModified: Date }>(),
  created: vi.fn(),
  uploaded: vi.fn(),
  beforeUpload: vi.fn(),
  deleted: vi.fn(),
  denyDownload: false,
}));

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: { fromConnectionString: () => ({ getContainerClient: () => ({
    createIfNotExists: storage.created,
    getBlobClient(name: string) {
      return {
        async downloadToBuffer() {
          if (storage.denyDownload) throw { statusCode: 403 };
          const blob = storage.blobs.get(name);
          if (!blob) throw { statusCode: 404 };
          return blob.content;
        },
        async deleteIfExists() { storage.deleted(name); return { succeeded: storage.blobs.delete(name) }; },
      };
    },
    getBlockBlobClient(name: string) {
      return { async uploadData(content: Buffer, options: {abortSignal?: AbortSignal}) {
        storage.uploaded(name, options);
        await storage.beforeUpload(name, options);
        storage.blobs.set(name, { content, lastModified: new Date() });
      } };
    },
    async *listBlobsFlat(options?: { prefix?: string }) {
      for (const [name, blob] of storage.blobs) {
        if (!options?.prefix || name.startsWith(options.prefix)) {
          yield { name, properties: { lastModified: blob.lastModified } };
        }
      }
    },
  }) }) },
}));

const identity: EvidenceCheckpointIdentity = { accountId: "account-1", sourceId: "source-1", runFingerprint: "revision-1" };

describe("Blob evidence checkpoints", () => {
  beforeEach(() => {
    storage.blobs.clear();
    storage.created.mockReset().mockResolvedValue(undefined);
    storage.uploaded.mockClear();
    storage.beforeUpload.mockReset().mockResolvedValue(undefined);
    storage.deleted.mockClear();
    storage.denyDownload = false;
  });

  afterEach(() => vi.useRealTimers());

  it("isolates account, source, revision, and window and clears only the selected source", async () => {
    const store = new BlobEvidenceCheckpointStore(BlobServiceClient.fromConnectionString("local-connection-string"));
    expect(await store.get(identity, 0)).toBeNull();
    await store.put(identity, 0, { evidence: "first" });
    await store.put(identity, 1, { evidence: "second" });
    await store.put({ ...identity, runFingerprint: "revision-2" }, 0, { evidence: "new run" });
    await store.put({ ...identity, accountId: "account-2" }, 0, { evidence: "other account" });
    await store.put({ ...identity, sourceId: "source-2" }, 0, { evidence: "other source" });

    expect(await store.get(identity, 0)).toEqual({ evidence: "first" });
    expect(await store.get(identity, 1)).toEqual({ evidence: "second" });
    expect(storage.created).toHaveBeenCalledTimes(1);
    expect([...storage.blobs.keys()].every(name => !name.includes("account-") && !name.includes("source-"))).toBe(true);

    await store.clearSource(identity.accountId, identity.sourceId);
    expect(await store.get(identity, 0)).toBeNull();
    expect(await store.get({ ...identity, runFingerprint: "revision-2" }, 0)).toBeNull();
    expect(await store.get({ ...identity, sourceId: "source-2" }, 0)).toEqual({ evidence: "other source" });
    expect(await store.get({ ...identity, accountId: "account-2" }, 0)).toEqual({ evidence: "other account" });

    await store.clearAccount(identity.accountId);
    expect(await store.get({ ...identity, sourceId: "source-2" }, 0)).toBeNull();
    expect(await store.get({ ...identity, accountId: "account-2" }, 0)).toEqual({ evidence: "other account" });
  });

  it("removes abandoned checkpoints older than 30 days", async () => {
    const store = new BlobEvidenceCheckpointStore(BlobServiceClient.fromConnectionString("local-connection-string"));
    await store.put(identity, 0, { evidence: "old" });
    await store.put(identity, 1, { evidence: "current" });
    const oldName = storage.uploaded.mock.calls[0][0] as string;
    storage.blobs.get(oldName)!.lastModified = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

    expect(await store.pruneExpired()).toBe(1);
    expect(await store.get(identity, 0)).toBeNull();
    expect(await store.get(identity, 1)).toEqual({ evidence: "current" });
  });

  it("isolates stage records and removes them with source/account cleanup", async () => {
    const store = new BlobEvidenceCheckpointStore(BlobServiceClient.fromConnectionString("local-connection-string"));
    await store.put(identity, 0, { window: true });
    await store.putStage(identity, 0, "primary-events", { events: [] });
    await store.putStage(identity, 0, "reconciliation:0", { reviewed: true });
    await store.putStage({ ...identity, sourceId: "source-2" }, 0, "primary-events", { other: true });
    expect(await store.getStage(identity, 0, "primary-events")).toEqual({ events: [] });
    expect(await store.getStage(identity, 0, "reconciliation:0")).toEqual({ reviewed: true });
    expect(await store.getStage(identity, 1, "primary-events")).toBeNull();
    expect([...storage.blobs.keys()].some(name => name.includes("primary-events"))).toBe(false);
    await store.clearSource("account-1", "source-1");
    expect(await store.getStage(identity, 0, "primary-events")).toBeNull();
    expect(await store.get(identity, 0)).toBeNull();
    expect(await store.getStage({ ...identity, sourceId: "source-2" }, 0, "primary-events")).toEqual({ other: true });
    await store.clearAccount("account-1");
    expect(storage.blobs.size).toBe(0);
  });

  it("retains readiness for later repairs but deletes it when its source is removed", async () => {
    const store = new BlobEvidenceCheckpointStore(BlobServiceClient.fromConnectionString("local-connection-string"));
    const manifest = partitionManifestIdentity(identity.accountId, identity.sourceId, "a".repeat(64));
    await store.put(identity, 0, {work: true});
    await store.putStage(manifest, 0, "ready", {count: 1});
    for (const blob of storage.blobs.values()) blob.lastModified = new Date(0);
    expect(await store.pruneExpired()).toBe(1);
    await store.put(identity, 0, {work: true});
    await store.clearSourceWork(identity.accountId, identity.sourceId);
    expect(await store.get(identity, 0)).toBeNull();
    expect(await store.getStage(manifest, 0, "ready")).toEqual({count: 1});
    await store.clearSource(identity.accountId, identity.sourceId);
    expect(await store.getStage(manifest, 0, "ready")).toBeNull();
  });

  it("cancels an upload that supports the deadline signal", async () => {
    vi.useFakeTimers();
    const store = new BlobEvidenceCheckpointStore(BlobServiceClient.fromConnectionString("local-connection-string"));
    storage.beforeUpload.mockImplementation(async (_name, options) => new Promise((_resolve, reject) => {
      options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), {once:true});
    }));
    const failed = withReconciliationDeadline(100, () => store.putStage(identity,0,"review",{ok:true},reconciliationCheckpointGuard()),vi.fn()).catch(error=>error);
    await vi.advanceTimersByTimeAsync(0);
    const signal = storage.uploaded.mock.calls[0][1].abortSignal;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(await failed).toBeInstanceOf(EvidenceReconciliationTimeoutError);
    expect(signal.aborted).toBe(true);
    expect(await store.getStage(identity,0,"review")).toBeNull();
    expect(storage.blobs.size).toBe(0);
  });

  it("does not start an upload after container initialization outlasts the deadline", async () => {
    vi.useFakeTimers();
    const ready = deferred();
    storage.created.mockReturnValue(ready.promise);
    const store = new BlobEvidenceCheckpointStore(BlobServiceClient.fromConnectionString("local-connection-string"));
    const failed = withReconciliationDeadline(100, () => store.putStage(identity,0,"review",{ok:true},reconciliationCheckpointGuard()),vi.fn()).catch(error=>error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await failed).toBeInstanceOf(EvidenceReconciliationTimeoutError);
    ready.resolve();await vi.advanceTimersByTimeAsync(0);
    expect(storage.uploaded).not.toHaveBeenCalled();
  });

  it("never publishes an upload that ignores cancellation, even after a newer retry commits", async () => {
    vi.useFakeTimers();
    const late = deferred();
    const store = new BlobEvidenceCheckpointStore(BlobServiceClient.fromConnectionString("local-connection-string"));
    storage.beforeUpload.mockReturnValueOnce(late.promise);
    const failed = withReconciliationDeadline(100, () => store.putStage(identity,0,"review",{attempt:"late"},reconciliationCheckpointGuard()),vi.fn()).catch(error=>error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await failed).toBeInstanceOf(EvidenceReconciliationTimeoutError);
    expect(await store.getStage(identity,0,"review")).toBeNull();
    await withReconciliationDeadline(100, () => store.putStage(identity,0,"review",{attempt:"new"},reconciliationCheckpointGuard()),vi.fn());
    expect(await store.getStage(identity,0,"review")).toEqual({attempt:"new"});
    late.resolve();await vi.advanceTimersByTimeAsync(0);
    expect([...storage.blobs.values()].some(blob=>blob.content.toString().includes('"late"'))).toBe(true);
    expect(await store.getStage(identity,0,"review")).toEqual({attempt:"new"});
    expect(storage.uploaded.mock.calls.filter(([name])=>!name.includes(".pending/"))).toHaveLength(1);
    await store.clearSource(identity.accountId,identity.sourceId);
    expect(storage.blobs.size).toBe(0);
  });

  it("publishes only the latest acknowledged progress and preserves it across a sibling timeout", async () => {
    vi.useFakeTimers();
    const late = deferred();
    const store = new BlobEvidenceCheckpointStore(BlobServiceClient.fromConnectionString("local-connection-string"));
    const failed = withReconciliationDeadline(100, async () => {
      await store.putStage(identity,0,"progress",{items:[1]},reconciliationCheckpointGuard());
      await store.putStage(identity,0,"progress",{items:[1,2]},reconciliationCheckpointGuard());
      expect(await store.getStage(identity,0,"progress",reconciliationSignal())).toEqual({items:[1,2]});
      expect(await new BlobEvidenceCheckpointStore(BlobServiceClient.fromConnectionString("local-connection-string")).getStage(identity,0,"progress")).toBeNull();
      storage.beforeUpload.mockReturnValueOnce(late.promise);
      await store.putStage(identity,0,"unfinished",{ok:true},reconciliationCheckpointGuard());
    },vi.fn()).catch(error=>error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await failed).toBeInstanceOf(EvidenceReconciliationTimeoutError);
    expect(await store.getStage(identity,0,"progress")).toEqual({items:[1,2]});
    expect(await store.getStage(identity,0,"unfinished")).toBeNull();
    late.resolve();await vi.advanceTimersByTimeAsync(0);
    expect(await store.getStage(identity,0,"unfinished")).toBeNull();
    expect(storage.uploaded.mock.calls.filter(([name])=>!name.includes(".pending/"))).toHaveLength(1);
  });

  it("fails publication without exposing staged data and rejects corrupted referenced data", async () => {
    const store = new BlobEvidenceCheckpointStore(BlobServiceClient.fromConnectionString("local-connection-string"));
    storage.beforeUpload.mockImplementation(async name => {if (!name.includes(".pending/")) throw new Error("publication failed");});
    await expect(withReconciliationDeadline(1000, () => store.putStage(identity,0,"review",{ok:true},reconciliationCheckpointGuard()),vi.fn())).rejects.toThrow("publication failed");
    expect(await store.getStage(identity,0,"review")).toBeNull();
    storage.beforeUpload.mockResolvedValue(undefined);
    await withReconciliationDeadline(1000, () => store.putStage(identity,0,"review",{ok:true},reconciliationCheckpointGuard()),vi.fn());
    expect(await store.getStage(identity,0,"review")).toEqual({ok:true});
    const published = [...storage.blobs].find(([name])=>!name.includes(".pending/"))!;
    const reference = JSON.parse(published[1].content.toString());
    storage.blobs.get(reference.blob)!.content = Buffer.from('{"changed":true}');
    expect(await store.getStage(identity,0,"review")).toBeNull();
  });

  it("propagates storage authorization failures", async () => {
    const store = new BlobEvidenceCheckpointStore(BlobServiceClient.fromConnectionString("local-connection-string"));
    storage.denyDownload = true;
    await expect(store.get(identity, 0)).rejects.toEqual({ statusCode: 403 });
  });
});
