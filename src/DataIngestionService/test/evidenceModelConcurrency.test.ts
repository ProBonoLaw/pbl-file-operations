import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/processors/appInsights.js", () => ({telemetryClient:{trackEvent:vi.fn(),trackException:vi.fn()}}));
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("AZURE_OPENAI_LLM_ENDPOINT", "https://test.services.ai.azure.com");
  vi.stubEnv("AZURE_OPENAI_LLM_API_KEY", "test");
  vi.stubEnv("EVIDENCE_REPAIR_CONCURRENCY", "");
  vi.stubEnv("EVIDENCE_RECONCILIATION_CONCURRENCY", "3");
  for (const role of ["PRIMARY", "INDEPENDENT", "RECONCILIATION"]) vi.stubEnv(`EVIDENCE_${role}_PROVIDER`, "openai");
});
afterEach(() => vi.unstubAllEnvs());

describe("shared evidence model permits", () => {
  it.each([
    {role:"evidence-repair",repair:"",capacity:5},
    {role:"evidence-repair",repair:"4",capacity:4},
    {role:"evidence-repair",repair:"2",capacity:4},
    {role:"evidence-reconcile",repair:"5",capacity:4},
    {role:"evidence-review",repair:"5",capacity:4},
    {role:"evidence-gather",repair:"5",capacity:4},
  ])("allows $capacity model calls across extractor instances in $role (repair=$repair)", async ({role,repair,capacity}) => {
    vi.stubEnv("ROLE",role);
    vi.stubEnv("EVIDENCE_REPAIR_CONCURRENCY",repair);
    const {EvidenceExtractor}=await import("../src/processors/evidence/evidenceExtractor.js");
    const first=new EvidenceExtractor("account","source-1") as any;
    const second=new EvidenceExtractor("account","source-2") as any;
    expect(first.semaphore).toBe(second.semaphore);
    const admitted:number[]=[];
    const acquisitions=Array.from({length:capacity+1},(_,index)=>
      (index%2 ? first : second).semaphore.acquire().then(()=>{admitted.push(index);}));
    let released=0;
    try {
      await vi.waitFor(()=>expect(admitted).toHaveLength(capacity));
      expect(admitted).toEqual(Array.from({length:capacity},(_,i)=>i));
      first.semaphore.release();released++;
      await Promise.all(acquisitions);
      expect(admitted).toHaveLength(capacity+1);
    } finally {
      // Drain any queued acquisition even if the assertion above fails.
      while (released<capacity+1) {first.semaphore.release();released++;}
      await Promise.all(acquisitions);
    }
  });
});
