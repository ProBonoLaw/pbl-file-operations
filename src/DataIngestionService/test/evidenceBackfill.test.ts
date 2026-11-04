import { describe, expect, it, vi } from "vitest";
import { applyEvidenceContentUpdate, prepareEvidenceContentUpdate, type StoredEvidence } from "../src/processors/evidence/evidenceBackfill.ts";
import { EVIDENCE_CONTENT_VERSION, formatEvidenceContent } from "../src/processors/evidence/evidenceContent.ts";

const metadata = {
  what: "The assessment score was 65.", tags: ["fact", "factType:assessmentResult"],
  factType: "assessmentResult", asOf: { year: "2025", month: "3", day: null, season: null, quarter: null },
  sourceSpans: [{ pageNumber: 1, sourceOffset: 20, sourceQuote: "Score: 65" }],
  pages: [1], sourceQuote: "Score: 65", sourceOffset: 20,
  sourceContentHash: "original-hash", extractedBy: ["original-model"], evidenceSchemaVersion: "3",
};
const original: StoredEvidence = { id: "existing-id", content: "Fact - The assessment score was 65.\nSource page: 1\nSource quote: Score: 65", metadata: JSON.stringify(metadata) };

function planned(record = original) {
  const update = prepareEvidenceContentUpdate(record);
  expect(update.status).toBe("update");
  if (update.status !== "update") throw new Error("Expected planned update");
  return update;
}

describe("evidence date backfill", () => {
  it("rebuilds content from metadata while retaining the record ID and extraction provenance", () => {
    const update = planned();
    expect(update.needsEmbedding).toBe(true);
    expect(update.document.id).toBe(original.id);
    expect(update.document.content).toBe(formatEvidenceContent(metadata));
    expect(update.document.content).toContain("As of: March 2025");
    expect(update.document.asOf).toEqual(metadata.asOf);
    expect(JSON.parse(update.document.metadata)).toEqual({ ...metadata, evidenceContentVersion: EVIDENCE_CONTENT_VERSION });
    expect(original.metadata).toBe(JSON.stringify(metadata));
  });

  it.each(["event", "claim"])("upgrades the complete previous %s format", kind => {
    const dated = { ...metadata, factType: undefined, tags: [kind], who: ["Jane"], whenStarted: { year: "2025" },
      whenEnded: { year: "2026" },
      ...(kind === "claim" ? { claimant: "Jane", claimType: "allegation", claimPolarity: "denies" } : {}),
    };
    const prefix = kind === "claim" ? "Jane" : JSON.stringify(dated.whenStarted) + " - Jane";
    const update = planned({ ...original, metadata: JSON.stringify(dated), content: `${prefix} - ${dated.what}\nSource page: 1\nSource quote: Score: 65` });
    expect(update.document.content).toContain(kind === "claim" ? "Date referenced by the claim: 2025" : "Event start date: 2025");
    expect(update.document.content).toContain(kind === "claim" ? "End date referenced by the claim: 2026" : "Event end date: 2026");
    expect(update.document.asOf).toBeNull();
    if (kind === "event") expect(update.reclassifiedUndatedEvent).toBe(false);
  });

  it("reclassifies a complete undated Search event and updates its indexed kind, tags and dates", () => {
    const event = { ...metadata, factType: undefined, tags:["event","eventType:agreement","facet:legal:consent"],
      eventType:"agreement", who:["Alex"], where:"Cedar House", why:"To authorize the assessment",
      whenStarted:{year:null,month:null,day:null,season:null,quarter:null}, whenEnded:null };
    const record: StoredEvidence = {id:"undated-event",metadata:JSON.stringify(event),content:formatEvidenceContent(event),
      tags:event.tags,whenStarted:event.whenStarted,whenEnded:null};
    const update = planned(record);
    expect(update.reclassifiedUndatedEvent).toBe(true);
    expect(update.needsEmbedding).toBe(true);
    expect(update.document).toMatchObject({id:record.id,evidenceKind:"fact",factType:"undatedOccurrence",
      eventType:null,tags:["facet:legal:consent","fact","factType:undatedOccurrence"],whenEnded:null});
    expect(update.document.whenStarted).toEqual(event.whenStarted);
    expect(update.document.content).toContain("Participants: Alex");
    expect(update.document.content).toContain("Location: Cedar House");
    expect(update.document.content).toContain("Reason: To authorize the assessment");
    expect(update.document.content).toContain("Source quote: Score: 65");
    expect(JSON.parse(update.document.metadata).classificationHistory).toEqual([expect.objectContaining({ruleId:"undated-event-to-fact"})]);
    expect(prepareEvidenceContentUpdate(update.document)).toEqual({status:"current"});
  });

  it("supports the legacy single-page citation format without changing its provenance metadata", () => {
    const legacy = { ...metadata, evidenceSchemaVersion: undefined, sourceSpans: undefined };
    const update = planned({ ...original, metadata: JSON.stringify(legacy) });
    expect(update.document.content).toContain("Source page: 1\nSource quote: Score: 65");
    expect(JSON.parse(update.document.metadata).sourceSpans).toBeUndefined();
  });

  it("skips complete records on rerun", () => {
    const update = planned();
    expect(prepareEvidenceContentUpdate(update.document)).toEqual({ status: "current" });
  });

  it("accepts content version 2 without re-embedding unchanged text", () => {
    const record = {...original, content: formatEvidenceContent(metadata), asOf: metadata.asOf,
      metadata: JSON.stringify({...metadata, evidenceContentVersion: "2"})};
    const update = planned(record);
    expect(update.needsEmbedding).toBe(false);
    expect(JSON.parse(update.document.metadata).evidenceContentVersion).toBe(EVIDENCE_CONTENT_VERSION);
  });

  it("repairs only missing asOf fields without re-embedding unchanged text", async () => {
    const current = planned().document;
    const record = { ...current, asOf: null };
    const update = planned(record);
    expect(update.needsEmbedding).toBe(false);
    const embed = vi.fn();
    const merge = vi.fn();
    await applyEvidenceContentUpdate(update, { dimensions: 3, embed, read: vi.fn().mockResolvedValue(record), merge });
    expect(embed).not.toHaveBeenCalled();
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ asOf: metadata.asOf }));
    expect(merge.mock.calls[0][0]).not.toHaveProperty("content_vector");
  });

  it("adds retrieval fields to current evidence without regenerating its embedding", async () => {
    const complete = planned().document;
    const record = {id:complete.id,content:complete.content,metadata:complete.metadata,asOf:complete.asOf};
    const update = planned(record);
    expect(update.needsEmbedding).toBe(false);
    const embed = vi.fn(), merge = vi.fn();
    await applyEvidenceContentUpdate(update,{dimensions:3,embed,read:vi.fn().mockResolvedValue(record),merge});
    expect(embed).not.toHaveBeenCalled();
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({id:record.id,evidenceKind:"fact",
      factType:"assessmentResult",sourceContentHash:"original-hash"}));
    expect(merge.mock.calls[0][0]).not.toHaveProperty("content_vector");
    expect(prepareEvidenceContentUpdate(update.document)).toEqual({status:"current"});
  });

  it("detects concurrent changes to evidence retrieval fields", async () => {
    const record = planned().document;
    const update = planned({...record,evidenceKind:null});
    const merge = vi.fn();
    await expect(applyEvidenceContentUpdate(update,{dimensions:3,embed:vi.fn(),
      read:vi.fn().mockResolvedValue({...record,evidenceKind:"claim"}),merge})).rejects.toThrow("changed during backfill");
    expect(merge).not.toHaveBeenCalled();
  });

  it("leaves split fragments and unknown schema versions untouched", () => {
    expect(prepareEvidenceContentUpdate({ ...original, content: "Fact - The assessment" })).toEqual({ status: "unsupported" });
    expect(prepareEvidenceContentUpdate({ ...original, metadata: JSON.stringify({ ...metadata, evidenceSchemaVersion: "4" }) })).toEqual({ status: "unsupported" });
    expect(prepareEvidenceContentUpdate({ ...original, metadata: JSON.stringify({ ...metadata, evidenceContentVersion: "999" }) })).toEqual({ status: "unsupported" });
  });

  it("embeds exactly the replacement content and merges it with the new vector", async () => {
    const update = planned();
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const read = vi.fn().mockResolvedValue(original);
    const merge = vi.fn();
    await applyEvidenceContentUpdate(update, { dimensions: 3, embed, read, merge });
    expect(embed).toHaveBeenCalledExactlyOnceWith(update.document.content);
    expect(read).toHaveBeenCalledExactlyOnceWith(original.id);
    expect(merge).toHaveBeenCalledExactlyOnceWith({ ...update.document, content_vector: [0.1, 0.2, 0.3] });
    expect(embed.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
  });

  it.each([[1, 2], [1, 2, NaN], [1, 2, Infinity]])("rejects invalid vectors before writing: %j", async (...vector) => {
    const merge = vi.fn();
    await expect(applyEvidenceContentUpdate(planned(), { dimensions: 3, embed: vi.fn().mockResolvedValue(vector), read: vi.fn(), merge }))
      .rejects.toThrow("index vector dimensions");
    expect(merge).not.toHaveBeenCalled();
  });

  it("does not overwrite a record that changed during embedding", async () => {
    const merge = vi.fn();
    await expect(applyEvidenceContentUpdate(planned(), { dimensions: 3, embed: vi.fn().mockResolvedValue([1, 2, 3]),
      read: vi.fn().mockResolvedValue({ ...original, content: "Newer content" }), merge,
    })).rejects.toThrow("changed during backfill");
    expect(merge).not.toHaveBeenCalled();
  });

  it("propagates merge failures so the unchanged record can be retried", async () => {
    await expect(applyEvidenceContentUpdate(planned(), { dimensions: 3, embed: vi.fn().mockResolvedValue([1, 2, 3]),
      read: vi.fn().mockResolvedValue(original), merge: vi.fn().mockRejectedValue(new Error("Search unavailable")),
    })).rejects.toThrow("Search unavailable");
    expect(prepareEvidenceContentUpdate(original).status).toBe("update");
  });
});
