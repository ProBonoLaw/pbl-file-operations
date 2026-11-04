import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../src/server.js";

const lifecycle = vi.hoisted(() => ({ close: vi.fn(), waitForRequests: vi.fn(), shutdown: vi.fn() }));
vi.mock("../src/api.js", () => ({ createDataIngestionApiServer: () => ({
  listen() {}, close: lifecycle.close, waitForRequests: lifecycle.waitForRequests,
}) }));
vi.mock("../src/processors/appInsights.js", () => ({ telemetryClient: { shutdown: lifecycle.shutdown, trackException: vi.fn() } }));
vi.mock("../src/operationOrderStore.js", () => ({ BlobOperationOrderStore: class {} }));
vi.mock("../src/processors/evidence/evidenceWorkStore.js", () => ({ BlobEvidenceWorkStore: class {} }));
vi.mock("../src/processors/evidence/evidenceTaskQueue.js", () => ({ BlobEvidenceTaskStore: class {} }));
vi.mock("../src/processors/evidence/evidenceCheckpoint.js", () => ({ BlobEvidenceCheckpointStore: class {
  async pruneExpired() {}
} }));

describe("Data Ingestion API process shutdown", () => {
  let stop: () => void;
  let interrupt: () => void;
  let previousExitCode: typeof process.exitCode;
  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.stubEnv("STORAGE_ACCOUNT_NAME", "evidencetest");
    vi.stubEnv("PROCESS_SHUTDOWN_TIMEOUT_MS", "300000");
    const originalOnce = process.once;
    vi.spyOn(process, "once").mockImplementation((name, listener) => {
      if (name === "SIGTERM") stop = listener;
      if (name === "SIGINT") interrupt = listener;
      if (name === "SIGTERM" || name === "SIGINT") return process;
      return originalOnce.call(process, name, listener);
    });
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = previousExitCode;
  });

  it("waits for active requests and telemetry before exiting despite remaining SDK handles", async () => {
    const flushed = Promise.withResolvers<void>();
    lifecycle.shutdown.mockReturnValue(flushed.promise);
    startServer();
    stop();
    interrupt();
    expect(lifecycle.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lifecycle.shutdown).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    lifecycle.close.mock.calls[0][0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.shutdown).toHaveBeenCalledOnce();
    expect(process.exit).not.toHaveBeenCalled();
    flushed.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("waits for work whose HTTP caller disconnected before starting the telemetry deadline", async () => {
    const drained = Promise.withResolvers<void>();
    lifecycle.waitForRequests.mockReturnValue(drained.promise);
    startServer();
    stop();
    lifecycle.close.mock.calls[0][0]();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lifecycle.shutdown).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    drained.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.shutdown).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("bounds stalled telemetry only after active requests have drained", async () => {
    lifecycle.shutdown.mockReturnValue(new Promise<void>(() => {}));
    startServer();
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(process.exit).not.toHaveBeenCalled();
    lifecycle.close.mock.calls[0][0]();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(["listener","disconnected request"])("forces exit when %s drain exceeds the appsettings deadline", async stall => {
    if (stall === "disconnected request") lifecycle.waitForRequests.mockReturnValue(new Promise<void>(()=>{}));
    startServer();
    stop();
    if (stall === "disconnected request") lifecycle.close.mock.calls[0][0]();
    await vi.advanceTimersByTimeAsync(299999);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(lifecycle.shutdown).not.toHaveBeenCalled();
  });

  it.each(["listener", "telemetry"])("exits with failure when %s shutdown fails", async failure => {
    if (failure === "telemetry") lifecycle.shutdown.mockRejectedValue(new Error("flush failed"));
    startServer();
    stop();
    lifecycle.close.mock.calls[0][0](failure === "listener" ? new Error("close failed") : undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.shutdown).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
