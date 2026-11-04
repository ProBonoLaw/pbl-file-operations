import { Document } from "@langchain/core/documents";
import { describe, expect, it, vi } from "vitest";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.js";
import { EVIDENCE_CONTENT_VERSION, formatEvidenceContent } from "../src/processors/evidence/evidenceContent.js";
import { applyEvidenceLocationUpdate, prepareEvidenceLocationUpdate } from "../src/processors/evidence/evidenceLocationBackfill.js";

const source = new EvidenceSource(new Document({pageContent:
  "Northshore Medical Center\nEmergency encounter.<!-- PageBreak -->Abdomen was non-tender.", metadata: {sourceId:"source"}}));
const metadata = {what:"The examination found a non-tender abdomen.",factType:"condition",tags:["fact"],where:"Unknown",
  asOf:{year:"2026",month:"1",day:"5",season:null,quarter:null},whenStarted:{year:null,month:null,day:null,season:null,quarter:null},whenEnded:null,
  sourceId:"source",sourceContentHash:source.contentHash,evidenceSchemaVersion:"3",evidenceContentVersion:EVIDENCE_CONTENT_VERSION,
  pages:[2],headers:["condition","Unknown","{}"],sourceSpans:[{pageNumber:2,sourceOffset:0,sourceQuote:"Abdomen was non-tender."}]};
const record = {id:"existing-id",sourceId:"source",where:"Unknown",pages:[2],metadata:JSON.stringify(metadata),content:formatEvidenceContent(metadata)};
const decision = {where:"Northshore Medical Center",reason:"The examination continues the named emergency encounter.",
  supportingQuotes:[{pageNumber:1,quote:"Northshore Medical Center\nEmergency encounter."}]};

describe("source-grounded location repair", () => {
  it("preserves the evidence and its ID while synchronizing location, citations, pages, and formatted content", () => {
    const update=prepareEvidenceLocationUpdate(record,source,decision,"reviewer")!;
    const updated=JSON.parse(update.document.metadata);
    expect(update.document).toMatchObject({id:record.id,where:decision.where,pages:[2,1]});
    expect(updated.what).toBe(metadata.what);
    expect(updated.asOf).toEqual(metadata.asOf);
    expect(updated.whenStarted).toEqual(metadata.whenStarted);
    expect(update.document).not.toHaveProperty("whenStarted");
    expect(update.document).not.toHaveProperty("asOf");
    expect(updated.sourceSpans[0]).toEqual(metadata.sourceSpans[0]);
    expect(updated.sourceSpans[1]).toMatchObject({pageNumber:1,sourceOffset:0,sourceQuote:decision.supportingQuotes[0].quote});
    expect(updated.headers).toEqual(["condition",decision.where,"{}"]);
    expect(update.document.content).toBe(formatEvidenceContent(updated));
    expect(update.document.content).toContain("Supporting quote: Northshore Medical Center");
    expect(updated.locationResolution).toMatchObject({previous:"Unknown",reviewer:"reviewer",reason:decision.reason});
    expect(record.metadata).toBe(JSON.stringify(metadata));
  });

  it("retains unresolved locations and preserves already known locations", () => {
    expect(prepareEvidenceLocationUpdate(record,source,{where:null,reason:"Historical incident with no place stated.",supportingQuotes:[]},"reviewer")).toBeNull();
    const known={...metadata,where:"Home"};
    expect(prepareEvidenceLocationUpdate({...record,where:"Home",metadata:JSON.stringify(known),content:formatEvidenceContent(known)},source,decision,"reviewer")).toBeNull();
  });

  it("rejects different source bytes, invented citations, incomplete records, and unsupported decisions", () => {
    const different=new EvidenceSource(new Document({pageContent:source.document.pageContent+" Changed.",metadata:{sourceId:"source"}}));
    expect(()=>prepareEvidenceLocationUpdate(record,different,decision,"reviewer")).toThrow("does not match");
    expect(()=>prepareEvidenceLocationUpdate(record,source,{...decision,supportingQuotes:[{pageNumber:1,quote:"South Bay Hospital"}]},"reviewer")).toThrow("absent or ambiguous");
    expect(()=>prepareEvidenceLocationUpdate({...record,content:"Fragment"},source,decision,"reviewer")).toThrow("complete current");
    expect(()=>prepareEvidenceLocationUpdate(record,source,{...decision,supportingQuotes:[]},"reviewer")).toThrow("supporting quotations");
  });

  it("embeds the corrected content and merges the existing record only after checking for concurrent changes", async () => {
    const update=prepareEvidenceLocationUpdate(record,source,decision,"reviewer")!;
    const embed=vi.fn().mockResolvedValue([1,2,3]),read=vi.fn().mockResolvedValue(record),merge=vi.fn();
    await applyEvidenceLocationUpdate(update,{dimensions:3,embed,read,merge});
    expect(embed).toHaveBeenCalledExactlyOnceWith(update.document.content);
    expect(merge).toHaveBeenCalledExactlyOnceWith({...update.document,content_vector:[1,2,3]});
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(merge.mock.invocationCallOrder[0]);
  });

  it("does not overwrite a changed location or upload a mismatched vector", async () => {
    const update=prepareEvidenceLocationUpdate(record,source,decision,"reviewer")!;
    const merge=vi.fn();
    await expect(applyEvidenceLocationUpdate(update,{dimensions:3,embed:async()=>[1,2,3],
      read:async()=>({...record,where:"Home"}),merge})).rejects.toThrow("changed during location repair");
    await expect(applyEvidenceLocationUpdate(update,{dimensions:3,embed:async()=>[1,2],
      read:async()=>record,merge})).rejects.toThrow("vector dimensions");
    expect(merge).not.toHaveBeenCalled();
  });
});
