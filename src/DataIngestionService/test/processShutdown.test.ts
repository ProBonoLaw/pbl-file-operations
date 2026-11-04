import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createProcessShutdown} from "../src/processShutdown.js";

describe("deployment shutdown deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("PROCESS_SHUTDOWN_TIMEOUT_MS","300000");
    vi.spyOn(process,"exit").mockImplementation(()=>undefined as never);
    vi.spyOn(console,"info").mockImplementation(()=>{});
    vi.spyOn(console,"error").mockImplementation(()=>{});
  });
  afterEach(() => {vi.useRealTimers();vi.unstubAllEnvs();vi.restoreAllMocks();});

  it.each(["data-ingestion-api","evidence-extraction","evidence-gather","evidence-reconcile",
    "evidence-review","evidence-repair","evidence-finalize"])("forces %s to exit after a stalled drain", async service => {
    const lifecycle = createProcessShutdown(service);
    await vi.advanceTimersByTimeAsync(600000);
    expect(process.exit).not.toHaveBeenCalled(); // Not a job execution timeout.
    expect(lifecycle.begin("SIGTERM")).toBe(true);
    await vi.advanceTimersByTimeAsync(299999);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("keeps the first signal's deadline when another signal arrives", async () => {
    const lifecycle = createProcessShutdown("evidence-finalize");
    lifecycle.begin("SIGTERM");
    await vi.advanceTimersByTimeAsync(299999);
    expect(lifecycle.begin("SIGINT")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    lifecycle.finish(0);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("uses the service appsettings override before the shared default", async () => {
    vi.stubEnv("EVIDENCE_FINALIZE_SHUTDOWN_TIMEOUT_MS","1000");
    const lifecycle = createProcessShutdown("evidence-finalize");
    lifecycle.begin("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("clears the deadline when graceful shutdown completes", async () => {
    const lifecycle = createProcessShutdown("evidence-gather");
    lifecycle.begin("SIGTERM");
    lifecycle.finish(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300000);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
  it.each(["0","999","3600001","1.5","bad",""])("rejects invalid timeout %s", setting => {
    vi.stubEnv("PROCESS_SHUTDOWN_TIMEOUT_MS",setting);
    expect(()=>createProcessShutdown("evidence-finalize")).toThrow("SHUTDOWN_TIMEOUT_MS");
  });
});
