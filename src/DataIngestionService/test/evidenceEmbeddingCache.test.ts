import {describe, expect, it, vi} from "vitest";
import {EvidenceEmbeddingCache, type EvidenceEmbeddingModelIdentity} from "../src/processors/evidence/evidenceEmbeddingCache.js";
import type {EvidenceCheckpointStore} from "../src/processors/evidence/evidenceCheckpoint.js";
import {AccountOperationQueue} from "../src/accountOperationQueue.js";
import {withEvidenceTaskCancellation} from "../src/processors/evidence/evidenceAsync.js";

const model: EvidenceEmbeddingModelIdentity = {endpoint:"https://embedding.test",deployment:"large-v1",
  model:"text-embedding-3-large",apiVersion:"2024-12-01-preview",dimensions:3,inputVersion:"strip-newlines-v1"};
const vector = (text: string) => [text.length, 0.1, 0.2];
function setup() {
  const saved = new Map<string, unknown>();
  const key = (identity: unknown, index: number, stage: string) => JSON.stringify([identity,index,stage]);
  const store: EvidenceCheckpointStore = {get:async()=>null,put:async()=>{},clearAccount:async()=>{},clearSource:async()=>{},
    getStage:vi.fn(async (identity,index,stage)=>structuredClone(saved.get(key(identity,index,stage)) ?? null)),
    putStage:vi.fn(async(identity,index,stage,value)=>{saved.set(key(identity,index,stage),structuredClone(value));})};
  const provider = {embedBatch:vi.fn(async(texts:string[])=>texts.map(vector))};
  const cache = (account="account",source="source",identity=model) => new EvidenceEmbeddingCache(account,source,identity,provider,store);
  return {saved,store,provider,cache};
}
describe("durable batched evidence embeddings", () => {
  it("does not save embeddings when the reconciliation deadline expires during the request", async () => {
    const {cache, provider, store} = setup();
    const controller = new AbortController();
    const guard = {abortSignal: controller.signal, assertActive: () => controller.signal.throwIfAborted(), deferPublication: vi.fn()};
    provider.embedBatch.mockImplementationOnce(async texts => {controller.abort(); return texts.map(vector);});
    await expect(cache().vectors(["Text"], guard)).rejects.toThrow();
    expect(store.putStage).not.toHaveBeenCalled();
  });
  it("stops new embedding batches and drains active requests when the queue job is cancelled",async()=>{
    const {cache,provider,store}=setup();
    const pending=Array.from({length:4},()=>Promise.withResolvers<number[][]>());
    provider.embedBatch.mockImplementation(()=>pending[provider.embedBatch.mock.calls.length-1].promise);
    const controller=new AbortController();
    const error=new Error("job stopped");
    const texts=Array.from({length:80},(_,i)=>"Text "+i);
    let settled=false;
    const run=withEvidenceTaskCancellation({signal:controller.signal,assertOpen:async()=>controller.signal.throwIfAborted()},
      ()=>cache().vectors(texts)).catch(failure=>{settled=true;return failure;});
    await vi.waitFor(()=>expect(provider.embedBatch).toHaveBeenCalledTimes(4));
    controller.abort(error);
    pending[0].resolve(texts.slice(0,16).map(vector));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(settled).toBe(false);
    for(const i of [1,2,3]) pending[i].resolve(texts.slice(i*16,i*16+16).map(vector));
    expect(await run).toBe(error);
    expect(provider.embedBatch).toHaveBeenCalledTimes(4);
    expect(store.putStage).not.toHaveBeenCalled();
  });
  it("preserves input order, deduplicates identical normalized text, and reuses vectors after restart", async () => {
    const {cache,provider} = setup();
    const texts = ["First\nline","Second","First line"];
    expect(await cache().vectors(texts)).toEqual(texts.map(text=>vector(text.replace(/\n/g," "))));
    expect(provider.embedBatch).toHaveBeenCalledExactlyOnceWith(["First line","Second"]);
    expect(await cache().vectors(texts)).toEqual(texts.map(text=>vector(text.replace(/\n/g," "))));
    expect(provider.embedBatch).toHaveBeenCalledOnce();
  });
  it("runs at most four batches concurrently and preserves order after out-of-order completion", async () => {
    const {cache,provider} = setup();
    const pending = Array.from({length:5},()=>Promise.withResolvers<number[][]>());
    provider.embedBatch.mockImplementation(()=>pending[provider.embedBatch.mock.calls.length-1].promise);
    const texts = Array.from({length:70},(_,i)=>"Text "+i);
    const running = cache().vectors(texts);
    await vi.waitFor(()=>expect(provider.embedBatch).toHaveBeenCalledTimes(4));
    pending[2].resolve(texts.slice(32,48).map(vector));
    await vi.waitFor(()=>expect(provider.embedBatch).toHaveBeenCalledTimes(5));
    for (const i of [4,3,1,0]) pending[i].resolve(texts.slice(i*16,i*16+16).map(vector));
    expect(await running).toEqual(texts.map(vector));
    expect(provider.embedBatch.mock.calls.map(([batch])=>batch.length)).toEqual([16,16,16,16,6]);
  });
  it("shares the four-request limit across callers of one cache", async () => {
    const {cache,provider} = setup();
    const gate = Promise.withResolvers<void>();
    let active = 0, maximum = 0;
    provider.embedBatch.mockImplementation(async texts => {
      maximum = Math.max(maximum, ++active);
      await gate.promise;
      active--;
      return texts.map(vector);
    });
    const shared = cache();
    const calls = Array.from({length:7},(_,i)=>shared.vectors(["Text "+i]));
    await vi.waitFor(()=>expect(provider.embedBatch).toHaveBeenCalledTimes(4));
    gate.resolve();
    expect(await Promise.all(calls)).toEqual(Array.from({length:7},(_,i)=>[vector("Text "+i)]));
    expect(maximum).toBe(4);
  });
  it("stops new requests after failure, drains admitted siblings, and reuses their results on restart", async () => {
    const {cache,provider} = setup();
    const pending = Array.from({length:4},()=>Promise.withResolvers<number[][]>());
    provider.embedBatch.mockImplementation(()=>pending[provider.embedBatch.mock.calls.length-1].promise);
    const texts = Array.from({length:80},(_,i)=>"Text "+i);
    let settled = false;
    const running = cache().vectors(texts).catch(error=>{settled=true;return error;});
    await vi.waitFor(()=>expect(provider.embedBatch).toHaveBeenCalledTimes(4));
    const failure = new Error("provider failed");
    pending[0].reject(failure);
    pending[1].resolve(texts.slice(16,32).map(vector));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(settled).toBe(false);
    expect(provider.embedBatch).toHaveBeenCalledTimes(4);
    for (const i of [3,2]) pending[i].resolve(texts.slice(i*16,i*16+16).map(vector));
    expect(await running).toBe(failure);
    provider.embedBatch.mockImplementation(async batch=>batch.map(vector));
    expect(await cache().vectors(texts)).toEqual(texts.map(vector));
    expect(provider.embedBatch.mock.calls.slice(4).flatMap(([batch])=>batch)).toEqual([...texts.slice(0,16),...texts.slice(64)]);
  });
  it("reuses earlier completed batches after a later provider failure", async () => {
    const {cache,provider} = setup();
    provider.embedBatch.mockImplementationOnce(async texts=>texts.map(vector)).mockRejectedValueOnce(new Error("temporary failure"));
    const texts = Array.from({length:20},(_,i)=>"Text "+i);
    await expect(cache().vectors(texts)).rejects.toThrow("temporary failure");
    expect(await cache().vectors(texts)).toEqual(texts.map(vector));
    expect(provider.embedBatch.mock.calls.map(([batch])=>batch.length)).toEqual([16,4,4]);
  });
  it("drains failed cache uploads before source removal can clear checkpoints", async () => {
    const {cache,store,saved,provider} = setup();
    await cache("other-account").vectors(["Keep this other account's source"]);
    provider.embedBatch.mockClear();
    const upload = store.putStage!;
    const pending = [Promise.withResolvers<void>(),Promise.withResolvers<void>()];
    const storageError = new Error("checkpoint upload failed");
    let nextWrite = 0;
    store.putStage = vi.fn(async (...args) => {
      const index = nextWrite++;
      if (index === 0) throw storageError;
      if (index <= 2) await pending[index - 1].promise;
      await upload(...args);
    });
    store.clearSource = vi.fn(async (accountId,sourceId) => {
      for (const key of saved.keys()) {
        const [identity] = JSON.parse(key);
        if (identity.accountId === accountId && identity.sourceId === sourceId) saved.delete(key);
      }
    });
    const queue = new AccountOperationQueue();
    let settled = false;
    const running = queue.runSource("account","source",()=>cache().vectors(
      Array.from({length:80},(_,index)=>"Text "+index))).catch(error=>{settled=true;return error;});
    const removal = queue.runSource("account","source",()=>store.clearSource("account","source"));
    await vi.waitFor(()=>expect(store.putStage).toHaveBeenCalledTimes(64));
    expect(settled).toBe(false);
    expect(store.clearSource).not.toHaveBeenCalled();
    pending[0].resolve();
    await vi.waitFor(()=>expect(saved.size).toBe(63));
    expect(settled).toBe(false);
    expect(store.clearSource).not.toHaveBeenCalled();
    pending[1].resolve();
    expect(await running).toBe(storageError);
    await removal;
    expect(store.clearSource).toHaveBeenCalledExactlyOnceWith("account","source");
    expect(saved.size).toBe(1);
    expect(JSON.parse([...saved.keys()][0])[0]).toMatchObject({accountId:"other-account",sourceId:"source"});
    expect(provider.embedBatch).toHaveBeenCalledTimes(4); // No fifth batch after the storage failure.
  });
  it("preserves provider input order when cache reads finish in reverse order", async () => {
    const {cache,store,provider} = setup();
    const reads = Array.from({length:3},()=>Promise.withResolvers<unknown>());
    let next = 0;
    vi.mocked(store.getStage!).mockImplementation(()=>reads[next++].promise);
    const running = cache().vectors(["First","Second","Third"]);
    await vi.waitFor(()=>expect(store.getStage).toHaveBeenCalledTimes(3));
    reads[2].resolve(null); reads[1].resolve(null); reads[0].resolve(null);
    expect(await running).toEqual(["First","Second","Third"].map(vector));
    expect(provider.embedBatch).toHaveBeenCalledExactlyOnceWith(["First","Second","Third"]);
  });
  it("reports distinct cache hits and generated inputs without source text", async () => {
    const {store,provider} = setup();
    const report = vi.fn();
    const first = new EvidenceEmbeddingCache("account","source",model,provider,store,report);
    await first.vectors(["First","Second","First"]);
    await new EvidenceEmbeddingCache("account","source",model,provider,store,report).vectors(["First","Second"]);
    expect(report.mock.calls.map(([stats])=>stats)).toEqual([
      {inputCount:3,uniqueCount:2,cacheHitCount:0,generatedCount:2,requestCount:1,oversizedCount:0},
      {inputCount:2,uniqueCount:2,cacheHitCount:2,generatedCount:0,requestCount:0,oversizedCount:0},
    ]);
  });
  it.each(["account","source","deployment","endpoint","dimensions","epoch"])("isolates %s changes", async field => {
    const {cache,provider} = setup();
    await cache().vectors(["Text"]);
    const changed = {...model,...(field==="deployment"?{deployment:"large-v2"}:field==="endpoint"?{endpoint:"https://other.test"}
      :field==="dimensions"?{dimensions:2}:field==="epoch"?{epoch:"2"}:{})};
    if(field==="dimensions") provider.embedBatch.mockResolvedValue([[1,2]]);
    await cache(field==="account"?"other":"account",field==="source"?"other":"source",changed).vectors(["Text"]);
    expect(provider.embedBatch).toHaveBeenCalledTimes(2);
  });
  it("rejects damaged cache vectors and recomputes only their inputs", async () => {
    const {cache,saved,provider} = setup();
    await cache().vectors(["Text"]);
    const entry = [...saved.keys()][0];
    saved.set(entry,{...(saved.get(entry) as object),vector:[99,99,99]});
    expect(await cache().vectors(["Text"])).toEqual([vector("Text")]);
    expect(provider.embedBatch).toHaveBeenCalledTimes(2);
  });
  it("does not persist partially valid provider responses", async () => {
    const {cache,saved,provider} = setup();
    provider.embedBatch.mockResolvedValueOnce([[1,2,3],[NaN,2,3]]);
    await expect(cache().vectors(["First","Second"])).rejects.toThrow("Invalid evidence embedding response");
    expect(saved.size).toBe(0);
  });
  it("routes oversized text to the split path without calling the provider", async () => {
    const {cache,provider} = setup();
    expect(await cache().vectors(["word ".repeat(8500)])).toEqual([null]);
    expect(provider.embedBatch).not.toHaveBeenCalled();
  });
  it("retains bounded local reuse when durable storage is unavailable", async () => {
    const provider = {embedBatch:vi.fn(async(texts:string[])=>texts.map(vector))};
    const cache = new EvidenceEmbeddingCache("account","source",model,provider);
    await cache.vectors(["Text"]);
    await cache.vectors(["Text"]);
    expect(provider.embedBatch).toHaveBeenCalledOnce();
  });
});
