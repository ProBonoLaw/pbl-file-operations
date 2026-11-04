import { vi } from "vitest";
import { EvidenceTaskQueue, type EvidenceTaskStore, type EvidenceTaskRecord } from "../../src/processors/evidence/evidenceTaskQueue.js";
export function evidenceTaskHarness() {
  const records = new Map<string, EvidenceTaskRecord>();
  const artifacts = new Map<string, unknown>();
  const locked = new Set<string>();
  const stoppedJobs = new Set<string>();
  const jobKey = ({accountId, sourceId, jobId}: {accountId?: string; sourceId?: string; jobId?: string}) =>
    JSON.stringify([accountId, sourceId, jobId]);
  let now = 1_800_000_000_000;
  let lost = false;
  const store: EvidenceTaskStore = {
    create: async record => { if (!records.has(record.id)) records.set(record.id, structuredClone(record)); },
    get: async id => structuredClone(records.get(id) ?? null),
    withLease: async (id, apply) => {
      if (locked.has(id)) return false;
      locked.add(id);
      const record = structuredClone(records.get(id)!);
      const assertOwned = () => { if (lost) throw new Error("lease lost"); };
      try {
        await apply(record, async () => { assertOwned(); records.set(id, structuredClone(record)); }, assertOwned);
        return true;
      } finally { locked.delete(id); }
    },
    list: async function* () { for (const record of records.values()) yield structuredClone(record); },
    putArtifact: async (id, value) => { artifacts.set(id, structuredClone(value)); },
    artifact: async id => structuredClone(artifacts.get(id)),
    stopJob: async correlation => { stoppedJobs.add(jobKey(correlation)); },
    isJobStopped: async correlation => stoppedJobs.has(jobKey(correlation)),
  };
  const transport = {send: vi.fn(async () => undefined)};
  const observe = vi.fn();
  const queue = new EvidenceTaskQueue(store, transport, observe, () => now);
  return {queue, store, records, artifacts, stoppedJobs, transport, observe, advance: (ms: number) => { now += ms; },
    loseLease: () => { lost = true; }, recoverLease: () => { lost = false; }};
}
