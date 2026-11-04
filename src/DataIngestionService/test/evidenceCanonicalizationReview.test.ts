import {Document} from "@langchain/core/documents";
import {describe, expect, it, vi} from "vitest";
import {canonicalizeEvidenceDocuments, type EvidenceCanonicalizationRuntime} from "../src/processors/evidence/evidenceCanonicalizationReview.ts";
import type {EvidenceCheckpointStore} from "../src/processors/evidence/evidenceCheckpoint.ts";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.ts";
import {EvidenceStageCheckpoints} from "../src/processors/evidence/evidenceStageCheckpoints.ts";

type Input = {pairId:string; validationFeedback?:string};
const decision = (pair: Input, reason = "Distinct assertions.") => ({pairId:pair.pairId,
  relation:"independent_assertions", leftOnlyDetails:[], rightOnlyDetails:[], reason});

function fixture(count: number) {
  const source = new Document({pageContent:"Casey completed the assessment.", metadata:{sourceId:"source",pages:[1]}});
  const hash = new EvidenceSource(source).contentHash;
  const documents = Array.from({length:count}, () => new Document({pageContent:"",metadata:{
    accountId:"account", sourceId:"source", sourceContentHash:hash, what:source.pageContent,
    who:["Casey"], subject:["Casey"], tags:["fact"], factType:"attribute",
    sourceOffset:0, sourceQuote:source.pageContent, pages:[1],
    sourceSpans:[{pageNumber:1, sourceOffset:0, sourceQuote:source.pageContent}],
  }}));
  const saved = new Map<string, unknown>();
  const store: EvidenceCheckpointStore = {
    get:async()=>null, put:async()=>{}, clearAccount:async()=>{}, clearSource:async()=>{},
    getStage:vi.fn(async (_identity, _index, stage) => structuredClone(saved.get(stage) ?? null)),
    putStage:vi.fn(async (_identity, _index, stage, value) => {saved.set(stage, structuredClone(value));}),
  };
  const track = vi.fn();
  const toolOptions: {useSourceTool?:boolean; useContextSearch?:boolean}[] = [];
  const invoke = vi.fn(async (pairs: Input[]) => ({decisions:pairs.map(pair => decision(pair))}));
  const runtime: EvidenceCanonicalizationRuntime = {
    reconciliationModel:{deployment:"test"} as EvidenceCanonicalizationRuntime["reconciliationModel"],
    promptCompaction:"on", checkpoints:new EvidenceStageCheckpoints(store, track),
    sourceLookup:async()=>undefined,
    checkpointIdentity:async()=>({accountId:"account", sourceId:"source", runFingerprint:"test"}),
    invokeStructured:async (_schema, _instructions, content, _model, _stage, _source, options) => {
      toolOptions.push(options ?? {});
      return await invoke(JSON.parse(content).pairs) as any;
    },
    track,
  };
  return {source, documents, saved, store, track, invoke, runtime, toolOptions,
    run:()=>canonicalizeEvidenceDocuments(runtime, documents, source, {retrieval:{}})};
}

describe("canonicalization repair scheduling", () => {
  it("groups only invalid pairs, with isolated feedback and no repeated checkpoint reads", async () => {
    const f = fixture(4); // six pairs, five invalid
    f.runtime.sourceLookup = async () => ({fingerprint:"context",search:async()=>({passages:[]}),verify:async()=>{}});
    let validId: string;
    f.invoke.mockImplementationOnce(async pairs => {
      validId = pairs[0].pairId;
      return {decisions:pairs.map((pair, index) => index === 0 ? decision(pair)
        : index % 2 ? decision(pair, "") : {...decision(pair),relation:"bad"})};
    });
    const result = await f.run();
    expect(result.pairs).toHaveLength(6);
    const repairs = f.invoke.mock.calls.slice(1).map(([pairs]) => pairs);
    expect(repairs.map(pairs => pairs.length)).toEqual([4,1]);
    expect(f.toolOptions).toEqual([
      expect.objectContaining({useSourceTool:true, useContextSearch:true}),
      expect.objectContaining({useSourceTool:false, useContextSearch:false}),
      expect.objectContaining({useSourceTool:false, useContextSearch:false}),
    ]);
    expect(repairs.flat().map(pair => pair.pairId)).not.toContain(validId!);
    expect(new Set(repairs.flat().map(pair => pair.pairId)).size).toBe(5);
    for (const pair of repairs.flat()) {
      const index = f.invoke.mock.calls[0][0].findIndex(original => original.pairId === pair.pairId);
      expect(pair.validationFeedback).toContain(index % 2 ? "nonempty reason" : "valid pairId, relation");
    }
    expect(f.store.getStage).toHaveBeenCalledTimes(6);
    expect(f.store.putStage).toHaveBeenCalledTimes(6);
    expect(result.failedPairIds).toEqual([]);
    expect(result.documents).toEqual(f.documents);
    expect(f.track).toHaveBeenCalledWith("canonicalizationPairRetry", expect.objectContaining({
      repairBatchCount:"2", reusedCount:"1", validationErrorCounts:'{"empty_reason":3,"invalid_schema":2}',
    }));
  });

  it.each(["missing", "invalid", "failed"])("retains unresolved evidence after a %s grouped repair, without retrying valid siblings", async mode => {
    const f = fixture(4);
    f.invoke.mockImplementationOnce(async pairs => ({decisions:pairs.map(pair => decision(pair, ""))}));
    let unresolved: string[] = [];
    f.invoke.mockImplementationOnce(async pairs => {
      unresolved = (mode === "failed" ? pairs : pairs.slice(0,1)).map(pair => pair.pairId);
      if (mode === "failed") throw new SyntaxError("Malformed response");
      return {decisions:mode === "missing" ? pairs.slice(1).map(pair => decision(pair))
        : pairs.map((pair, index) => decision(pair, index ? "Distinct assertions." : ""))};
    });
    const result = await f.run();
    expect(f.invoke).toHaveBeenCalledTimes(3);
    expect(result.failedPairIds).toEqual(unresolved);
    expect(result.reviewDecisions).toHaveLength(6 - unresolved.length);
    expect(f.saved.size).toBe(6 - unresolved.length);
    expect(result.documents).toEqual(f.documents);
  });

  it("regroups scattered unresolved pairs on restart and replays completed decisions without model calls", async () => {
    const f = fixture(13); // 78 pairs across five original batches
    const unresolved = new Set<string>();
    f.invoke.mockImplementation(async pairs => {
      if (!pairs[0].validationFeedback) unresolved.add(pairs[0].pairId);
      return {decisions:pairs.map(pair => decision(pair, unresolved.has(pair.pairId) ? "" : "Distinct assertions."))};
    });
    const first = await f.run();
    expect(first.failedPairIds).toHaveLength(5);
    expect(f.saved.size).toBe(73);
    f.invoke.mockClear();
    f.invoke.mockImplementation(async pairs => ({decisions:pairs.map(pair => decision(pair))}));
    const resumed = await f.run();
    expect(f.invoke).toHaveBeenCalledOnce();
    expect(f.invoke.mock.calls[0][0].map(pair => pair.pairId).sort()).toEqual([...unresolved].sort());
    expect(resumed.reviewDecisions).toHaveLength(78);
    expect(resumed.failedPairIds).toEqual([]);
    expect(resumed.documents).toEqual(first.documents);
    f.invoke.mockClear();
    expect(await f.run()).toEqual(resumed);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("bounds checkpoint reads and drains them before propagating failure, without starting paid work", async () => {
    const f = fixture(13);
    const reads: ReturnType<typeof Promise.withResolvers<null>>[] = [];
    f.store.getStage = vi.fn(() => {
      const read = Promise.withResolvers<null>(); reads.push(read); return read.promise;
    });
    let settled = false;
    const running = f.run().catch(error => {settled = true; return error;});
    await vi.waitFor(() => expect(reads).toHaveLength(64));
    const error = new Error("Storage unavailable");
    reads[0].reject(error);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(f.invoke).not.toHaveBeenCalled();
    reads.slice(1).forEach(read => read.resolve(null));
    expect(await running).toBe(error);
    expect(reads).toHaveLength(64);
    expect(f.invoke).not.toHaveBeenCalled();
  });
});
