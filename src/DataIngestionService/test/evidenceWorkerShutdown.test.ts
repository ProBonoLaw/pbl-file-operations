import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startEvidenceWorker } from "../src/processors/evidence/evidenceWorker.js";

const lifecycle = vi.hoisted(() => ({
  drain: vi.fn(), consumerClose: vi.fn(), producerClose: vi.fn(),
  telemetryShutdown: vi.fn(), listenerClose: vi.fn(),
}));
vi.mock("../src/processors/appInsights.js", () => ({ telemetryClient: {
  shutdown: lifecycle.telemetryShutdown, trackEvent: vi.fn(),
} }));
vi.mock("@azure/event-hubs", () => ({
  earliestEventPosition: {},
  EventHubConsumerClient: class {
    subscribe() { return { close: lifecycle.drain }; }
    close = lifecycle.consumerClose;
  },
  EventHubProducerClient: class { close = lifecycle.producerClose; },
}));
vi.mock("@azure/storage-blob", () => ({ BlobServiceClient: class {
  getContainerClient() { return { createIfNotExists: async () => {} }; }
} }));
vi.mock("@azure/identity", () => ({ DefaultAzureCredential: class {} }));
vi.mock("@azure/eventhubs-checkpointstore-blob", () => ({ BlobCheckpointStore: class {} }));
vi.mock("../src/processors/evidence/evidenceQueueClient.js", () => ({
  createEvidenceTaskQueue: () => ({}), enqueueEvidenceJob: vi.fn(),
}));
vi.mock("node:http", async importOriginal => ({
  ...await importOriginal<typeof import("node:http")>(),
  createServer: () => ({ listen() {}, close: lifecycle.listenerClose }),
}));

describe("evidence worker process shutdown", () => {
  let signal: () => void;
  let previousExitCode: typeof process.exitCode;
  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.resetAllMocks();
    vi.stubEnv("STORAGE_ACCOUNT_NAME", "evidencetest");
    vi.stubEnv("EVENTHUB_NAMESPACE", "test.servicebus.windows.net");
    vi.stubEnv("EVIDENCE_REVIEW_EXECUTION_MODE", "queue");
    vi.stubEnv("PROCESS_SHUTDOWN_TIMEOUT_MS", "300000");
    const originalOnce = process.once;
    vi.spyOn(process, "once").mockImplementation((name, listener) => {
      if (name === "SIGTERM") signal = listener;
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

  it("waits for event handlers and telemetry before exiting despite remaining runtime handles", async () => {
    const drained = Promise.withResolvers<void>();
    const flushed = Promise.withResolvers<void>();
    lifecycle.drain.mockReturnValue(drained.promise);
    lifecycle.telemetryShutdown.mockReturnValue(flushed.promise);
    await startEvidenceWorker();
    signal();
    expect(lifecycle.listenerClose).toHaveBeenCalledOnce();
    expect(lifecycle.consumerClose).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    drained.resolve();
    await vi.waitFor(() => expect(lifecycle.telemetryShutdown).toHaveBeenCalledOnce());
    expect(lifecycle.consumerClose).toHaveBeenCalledOnce();
    expect(lifecycle.producerClose).toHaveBeenCalledOnce();
    expect(process.exit).not.toHaveBeenCalled();
    flushed.resolve();
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
  });

  it("bounds stalled telemetry only after event handlers have drained", async () => {
    vi.useFakeTimers();
    const drained = Promise.withResolvers<void>();
    lifecycle.drain.mockReturnValue(drained.promise);
    lifecycle.telemetryShutdown.mockReturnValue(new Promise<void>(() => {}));
    await startEvidenceWorker();
    signal();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(process.exit).not.toHaveBeenCalled();
    expect(lifecycle.telemetryShutdown).not.toHaveBeenCalled();
    drained.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.telemetryShutdown).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("forces exit when an event handler never drains", async () => {
    vi.useFakeTimers();
    lifecycle.drain.mockReturnValue(new Promise<void>(()=>{}));
    await startEvidenceWorker();
    signal();
    await vi.advanceTimersByTimeAsync(299999);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(lifecycle.telemetryShutdown).not.toHaveBeenCalled();
  });
});
