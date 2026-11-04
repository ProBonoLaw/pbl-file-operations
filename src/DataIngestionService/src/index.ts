import { loadAppSettings } from "./settings.js";
import { installStructuredConsole } from "./structuredLogger.js";

await loadAppSettings();
installStructuredConsole();

if (["evidence-gather", "evidence-reconcile", "evidence-review", "evidence-repair", "evidence-finalize"].includes(process.env.ROLE ?? "")) {
  const { startEvidenceQueueWorker } = await import("./processors/evidence/evidenceQueueWorker.js");
  await startEvidenceQueueWorker(process.env.ROLE!.slice("evidence-".length) as "gather" | "reconcile" | "review" | "repair" | "finalize");
} else if (process.env.ROLE === "evidence-extraction") {
  const { startEvidenceWorker } = await import("./processors/evidence/evidenceWorker.js");
  await startEvidenceWorker();
} else {
  const { startServer } = await import("./server.js");
  startServer();
}
