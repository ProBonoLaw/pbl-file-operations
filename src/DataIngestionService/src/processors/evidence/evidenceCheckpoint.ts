import { createHash, randomUUID } from "node:crypto";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { createBlobServiceClient } from "../../storage.js";

export interface EvidenceCheckpointIdentity {
  accountId: string;
  sourceId: string;
  runFingerprint: string;
}

export interface EvidenceCheckpointWriteGuard {
  abortSignal: AbortSignal;
  assertActive(): void;
  deferPublication(key: string, publish: () => Promise<void>): void;
}

export interface EvidenceCheckpointStore {
  get(identity: EvidenceCheckpointIdentity, windowIndex: number): Promise<unknown>;
  put(identity: EvidenceCheckpointIdentity, windowIndex: number, value: unknown): Promise<void>;
  getStage?(identity: EvidenceCheckpointIdentity, windowIndex: number, stage: string, signal?: AbortSignal): Promise<unknown>;
  putStage?(identity: EvidenceCheckpointIdentity, windowIndex: number, stage: string, value: unknown, guard?: EvidenceCheckpointWriteGuard): Promise<void>;
  clearSource(accountId: string, sourceId: string): Promise<void>;
  clearSourceWork?(accountId: string, sourceId: string): Promise<void>;
  clearAccount(accountId: string): Promise<void>;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const accountPrefix = (accountId: string) => `${hash(accountId)}/`;
const sourcePrefix = (accountId: string, sourceId: string) => `${accountPrefix(accountId)}${hash(sourceId)}/`;
const blobName = (identity: EvidenceCheckpointIdentity, windowIndex: number) =>
  `${sourcePrefix(identity.accountId, identity.sourceId)}${identity.runFingerprint}/${windowIndex}.json`;
const stageBlobName = (identity: EvidenceCheckpointIdentity, windowIndex: number, stage: string) =>
  `${sourcePrefix(identity.accountId, identity.sourceId)}${identity.runFingerprint}/${windowIndex}/stages/${hash(stage)}.json`;
const isSourceManifest = (name: string) => /^[^/]+\/[^/]+\/source-partitions-v1-[a-f0-9]{64}\//.test(name);

/** Private durable work and source readiness. Successful indexing clears work;
 * source/account removal also clears readiness retained for later repairs. */
export class BlobEvidenceCheckpointStore implements EvidenceCheckpointStore {
  private readonly container: ContainerClient;
  private initialized?: Promise<void>;
  private readonly staged = new WeakMap<AbortSignal, Map<string, unknown>>();

  constructor(blobs: BlobServiceClient = createBlobServiceClient()) {
    this.container = blobs
      .getContainerClient(process.env.EVIDENCE_CHECKPOINT_CONTAINER || "file-operations-evidence-checkpoints");
  }

  async get(identity: EvidenceCheckpointIdentity, windowIndex: number): Promise<unknown> {
    return this.read(blobName(identity, windowIndex));
  }

  async getStage(identity: EvidenceCheckpointIdentity, windowIndex: number, stage: string,
    signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const name = stageBlobName(identity, windowIndex, stage);
    const local = signal && this.staged.get(signal);
    if (local?.has(name)) return local.get(name);
    const record = await this.read(name);
    if (typeof record !== "object" || record === null || !("checkpointReferenceVersion" in record)) return record;
    if (record.checkpointReferenceVersion !== 1 || !("blob" in record) || typeof record.blob !== "string"
      || !record.blob.startsWith(name + ".pending/") || !/^[a-f0-9-]{36}\.json$/.test(record.blob.slice((name + ".pending/").length))
      || !("sha256" in record) || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) return null;
    const value = await this.read(record.blob);
    return value !== null && hash(JSON.stringify(value)) === record.sha256 ? value : null;
  }

  private async read(name: string): Promise<unknown> {
    await this.ensureContainer();
    try {
      const content = await this.container.getBlobClient(name).downloadToBuffer();
      const raw = content.toString("utf8");
      try {
        return JSON.parse(raw) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) return raw;
        throw error;
      }
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async put(identity: EvidenceCheckpointIdentity, windowIndex: number, value: unknown): Promise<void> {
    await this.write(blobName(identity, windowIndex), value);
  }

  async putStage(identity: EvidenceCheckpointIdentity, windowIndex: number, stage: string, value: unknown,
    guard?: EvidenceCheckpointWriteGuard): Promise<void> {
    const name = stageBlobName(identity, windowIndex, stage);
    if (!guard) { await this.write(name, value); return; }
    const blob = name + ".pending/" + randomUUID() + ".json";
    // Never upload cancellable data over the restorable name. An ambiguous/late
    // server commit is harmless without a publication reference from this scope.
    await this.write(blob, value, guard);
    guard.assertActive();
    const reference = {checkpointReferenceVersion: 1, blob, sha256: hash(JSON.stringify(value))};
    guard.deferPublication(name, () => this.write(name, reference));
    let local = this.staged.get(guard.abortSignal);
    if (!local) { local = new Map(); this.staged.set(guard.abortSignal, local); }
    local.set(name, value);
  }

  private async write(name: string, value: unknown, guard?: EvidenceCheckpointWriteGuard): Promise<void> {
    guard?.assertActive();
    await this.ensureContainer();
    guard?.assertActive();
    await this.container.getBlockBlobClient(name)
      .uploadData(Buffer.from(JSON.stringify(value)), {
        blobHTTPHeaders: { blobContentType: "application/json" },
        abortSignal: guard?.abortSignal,
      });
    guard?.assertActive();
  }

  async clearSource(accountId: string, sourceId: string): Promise<void> {
    await this.deletePrefix(sourcePrefix(accountId, sourceId));
  }

  /** Successful ingestion removes work, retaining readiness for later repairs.
   * Source/account removal still deletes the complete prefix, including manifests. */
  async clearSourceWork(accountId: string, sourceId: string): Promise<void> {
    await this.deletePrefix(sourcePrefix(accountId, sourceId), true);
  }

  async clearAccount(accountId: string): Promise<void> {
    await this.deletePrefix(accountPrefix(accountId));
  }

  /** Remove abandoned work after 30 days; active documents finish much sooner. */
  async pruneExpired(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    await this.ensureContainer();
    const cutoff = Date.now() - maxAgeMs;
    const names: string[] = [];
    for await (const blob of this.container.listBlobsFlat()) {
      if (!isSourceManifest(blob.name) && blob.properties.lastModified && blob.properties.lastModified.getTime() < cutoff) names.push(blob.name);
    }
    await this.deleteNames(names);
    return names.length;
  }

  private async deletePrefix(prefix: string, preserveManifests = false): Promise<void> {
    await this.ensureContainer();
    const names: string[] = [];
    for await (const blob of this.container.listBlobsFlat({ prefix }))
      if (!preserveManifests || !isSourceManifest(blob.name)) names.push(blob.name);
    await this.deleteNames(names);
  }

  private async deleteNames(names: string[]): Promise<void> {
    const chunks: string[][] = [];
    for (let offset = 0; offset < names.length; offset += 16) {
      chunks.push(names.slice(offset, offset + 16));
    }
    await chunks.reduce(async (previous, chunk) => {
      await previous;
      await Promise.all(chunk.map(name => this.container.getBlobClient(name).deleteIfExists()));
    }, Promise.resolve());
  }

  private ensureContainer(): Promise<void> {
    this.initialized ??= this.container.createIfNotExists().then(() => undefined).catch((error: unknown) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "statusCode" in error && error.statusCode === 404;
}
