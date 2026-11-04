import { describe, expect, it, vi } from "vitest";
import { EvidenceSourceCache } from "../src/processors/evidence/evidenceSourceCache.js";

describe("queued evidence source reuse", () => {
  it("coalesces downloads and reuses deterministic parsing across units of the same source", async () => {
    const load = vi.fn(async () => ({pageContent:"## Findings\n\nA finding.", metadata:{pages:[24]}}));
    const cache = new EvidenceSourceCache(load);
    const [first, second] = await Promise.all([cache.get("account-a-source-391-run-a"), cache.get("account-a-source-391-run-a")]);
    expect(first).toBe(second);
    expect(first.gatheringStructure(24)).toBe(second.gatheringStructure(24));
    expect(load).toHaveBeenCalledTimes(1);
    expect(await cache.get("account-b-source-391-run-a")).not.toBe(first);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bounds resident sources, avoids caching oversized input, and retries failed downloads", async () => {
    const load = vi.fn(async (id:string) => ({pageContent:id, metadata:{}}));
    const cache = new EvidenceSourceCache(load, 10);
    await cache.get("one"); await cache.get("two"); await cache.get("three"); await cache.get("one");
    expect(load).toHaveBeenCalledTimes(4);
    await cache.get("oversized document"); await cache.get("oversized document");
    expect(load).toHaveBeenCalledTimes(6);
    load.mockRejectedValueOnce(new Error("storage offline"));
    await expect(cache.get("error")).rejects.toThrow("storage offline");
    await expect(cache.get("error")).resolves.toBeDefined();
    expect(load).toHaveBeenCalledTimes(8);
  });
});
