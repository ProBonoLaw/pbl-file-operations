import { createHash } from "node:crypto";
import type { EvidenceCheckpointStore } from "./evidenceCheckpoint.js";
import { StageCheckpointSchema, type StageCheckpointContext } from "./evidenceExtractionSchemas.js";
import {
  assertReconciliationActive, awaitWithReconciliationSignal, reconciliationCheckpointGuard,
  reconciliationSignal,
} from "./evidenceReconciliationDeadline.js";
import { EvidenceSource, type EvidenceWindow } from "./evidenceSource.js";

/** Validates stage inputs and outputs and fences writes against expired work. */
export class EvidenceStageCheckpoints {
  constructor(private readonly checkpointStore: EvidenceCheckpointStore | undefined,
    private readonly track: (name: string, properties: Record<string, string>) => void) {}

  async run<T>(context: StageCheckpointContext | undefined, source: EvidenceSource,
    window: EvidenceWindow, stage: string, input: unknown, validate: (value: unknown) => T,
    generate: () => Promise<T>): Promise<T> {
    assertReconciliationActive();
    if (!context || !this.checkpointStore?.getStage || !this.checkpointStore.putStage) {
      const value = await generate();
      assertReconciliationActive();
      return value;
    }
    const saved = await this.read(context, source, window, stage, input, validate);
    if (saved !== null) return saved;
    const value = validate(await generate());
    await this.save(context, source, window, stage, input, value);
    return value;
  }

  async read<T>(context: StageCheckpointContext | undefined, source: EvidenceSource,
    window: EvidenceWindow, stage: string, input: unknown, validate: (value: unknown) => T): Promise<T | null> {
    assertReconciliationActive();
    if (!context || !this.checkpointStore?.getStage || !this.checkpointStore.putStage) return null;
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const textHash = createHash("sha256").update(window.text).digest("hex");
    const saved = await awaitWithReconciliationSignal(this.checkpointStore.getStage(context.identity, context.windowIndex, stage, reconciliationSignal()));
    assertReconciliationActive();
    if (saved !== null) {
      try {
        const record = StageCheckpointSchema.parse(saved);
        if (record.stage !== stage || record.pageNumber !== window.pageNumber || record.startOffset !== window.startOffset
          || record.textHash !== textHash || record.inputHash !== inputHash
          || record.valueHash !== createHash("sha256").update(JSON.stringify(record.value)).digest("hex")) {
          throw new Error("Stage checkpoint input or saved output changed");
        }
        const value = validate(record.value);
        this.track("stageRestored", { page: String(window.pageNumber), stage });
        return value;
      } catch (error) {
        this.track("stageCheckpointRejected", { page: String(window.pageNumber), stage,
          reason: error instanceof Error ? error.name : "invalid" });
      }
    }
    return null;
  }

  async save(context: StageCheckpointContext | undefined, _source: EvidenceSource,
    window: EvidenceWindow, stage: string, input: unknown, value: unknown): Promise<void> {
    assertReconciliationActive();
    if (!context || !this.checkpointStore?.getStage || !this.checkpointStore.putStage) return;
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const textHash = createHash("sha256").update(window.text).digest("hex");
    await this.checkpointStore.putStage(context.identity, context.windowIndex, stage,
      { version: 1, stage, pageNumber: window.pageNumber, startOffset: window.startOffset, textHash, inputHash,
        valueHash: createHash("sha256").update(JSON.stringify(value)).digest("hex"), value }, reconciliationCheckpointGuard());
    assertReconciliationActive();
    this.track("stageSaved", { page: String(window.pageNumber), stage });
  }

}
