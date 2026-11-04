import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consistencyHash, CONSISTENCY_INPUT_VERSION, type ConsistencyRecord } from "../src/processors/evidence/evidenceConsistency.ts";
import { consistencyEmbeddingIdentity, consistencyCacheKey, createConsistencyEmbedder, loadConsistencyVectors } from "../src/processors/evidence/evidenceConsistencyEmbeddings.ts";

const identity=consistencyEmbeddingIdentity({endpoint:"https://example.openai.azure.com/openai/deployments",deployment:"embedding-test",dimensions:2});
const record=(text:string)=>({embeddingInput:text,inputHash:consistencyHash([CONSISTENCY_INPUT_VERSION,text])}) as ConsistencyRecord;
const directories:string[]=[];
async function cache(){const directory=await mkdtemp(join(tmpdir(),"evidence-consistency-"));directories.push(directory);return directory;}
const provider=()=>({embedBatch:vi.fn(async(texts:string[])=>texts.map(()=>[1,0])),usage:{httpAttempts:0,inputTokens:0,responsesWithoutUsage:0}});
afterEach(async()=>{await Promise.all(directories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})));});

describe("consistency embedding identity and Azure routing",()=>{
  it("uses configured Azure deployment, key, version, dimensions and source input; restores response index order",async()=>{
    const transport=vi.fn(async()=>new Response(JSON.stringify({data:[{index:1,embedding:[0,1]},{index:0,embedding:[1,0]}],usage:{prompt_tokens:12,total_tokens:12}}),
      {headers:{"content-type":"application/json"}}));
    const client=createConsistencyEmbedder(identity,"TEST_SECRET",transport);
    expect(await client.embedBatch(["first","second"])).toEqual([[1,0],[0,1]]);
    const [url,init]=transport.mock.calls[0] as unknown as [string,RequestInit];
    expect(String(url)).toContain("https://example.openai.azure.com/openai/deployments/embedding-test/embeddings");
    expect(String(url)).toContain("api-version=2024-12-01-preview");
    expect(new Headers(init.headers).get("api-key")).toBe("TEST_SECRET");
    expect(JSON.parse(init.body as string)).toMatchObject({model:"text-embedding-3-small",dimensions:2,encoding_format:"float",input:["first","second"]});
    expect(client.usage).toEqual({httpAttempts:1,inputTokens:12,responsesWithoutUsage:0});
    expect(JSON.stringify(identity)).not.toContain("TEST_SECRET");
  });
  it("sanitizes provider errors and records missing usage",async()=>{
    const bad=createConsistencyEmbedder(identity,"TEST_SECRET",async()=>new Response(JSON.stringify({error:{message:"TEST_SECRET private source",type:"invalid_request_error"}}),
      {status:400,headers:{"content-type":"application/json"}}));
    await expect(bad.embedBatch(["source"])).rejects.toThrow("HTTP 400");
    const missing=createConsistencyEmbedder(identity,"key",async()=>new Response(JSON.stringify({data:[{index:0,embedding:[1,0]}]}),{headers:{"content-type":"application/json"}}));
    await missing.embedBatch(["source"]);expect(missing.usage.responsesWithoutUsage).toBe(1);
  });
  it.each([
    {endpoint:"http://example.test"},{endpoint:"https://user:password@example.test"},{endpoint:"https://example.test/?key=bad"},
    {model:"other"},{dimensions:1537},{dimensions:0},{deployment:""},
  ])("rejects invalid identity options %j",overrides=>{
    expect(()=>consistencyEmbeddingIdentity({endpoint:identity.endpoint,deployment:identity.deployment,...overrides})).toThrow();
  });
  it("isolates scopes, deployments, models, dimensions, versions and exact input",()=>{
    const original=consistencyCacheKey("account-1",identity,"hash");
    expect(consistencyCacheKey("account-2",identity,"hash")).not.toBe(original);
    expect(consistencyCacheKey("account-1",identity,"other")).not.toBe(original);
    for(const changed of [{endpoint:"https://other.test"},{deployment:"other"},{model:"text-embedding-3-large" as const},{dimensions:3},{apiVersion:"v2"},{inputVersion:"next"}])
      expect(consistencyCacheKey("account-1",{...identity,...changed},"hash")).not.toBe(original);
  });
});

describe("consistency vector cache",()=>{
  it("embeds each unique source input once and replays without a provider",async()=>{
    const directory=await cache(),model=provider(),records=[record("alpha"),record("beta"),record("alpha")];
    const first=await loadConsistencyVectors(records,{scope:"account-1",identity,directory,provider:model});
    expect(model.embedBatch).toHaveBeenCalledExactlyOnceWith(["alpha","beta"]);
    expect(first.stats).toMatchObject({newInputs:2,reusedInputs:1,missingInputs:0});
    const second=await loadConsistencyVectors(records,{scope:"account-1",identity,directory});
    expect(second.stats).toMatchObject({cacheHits:2,newInputs:0,reusedInputs:1});
    expect(second.vectors).toEqual(first.vectors);
    const contents=await Promise.all((await readdir(directory)).map(file=>readFile(join(directory,file),"utf8")));
    expect(contents.join("")).not.toMatch(/alpha|beta/);
  });
  it("treats corrupt or wrong-dimensional cache entries as misses",async()=>{
    const directory=await cache(),r=record("alpha"),key=consistencyCacheKey("account-1",identity,r.inputHash);
    await writeFile(join(directory,`${key}.json`),"not json");
    const result=await loadConsistencyVectors([r],{scope:"account-1",identity,directory});
    expect(result.stats).toMatchObject({invalidCacheEntries:1,missingInputs:1});expect(result.vectors).toEqual([null]);
  });
  it("bounds paid inputs, uses sequential batches and retains completed work after failure",async()=>{
    const directory=await cache(),model=provider(),records=Array.from({length:34},(_,i)=>record(`source ${i}`));
    model.embedBatch.mockRejectedValueOnce(new Error("private source must not be exported"));
    const failed=await loadConsistencyVectors(records,{scope:"account-1",identity,directory,provider:model});
    expect(failed.errors.join("")).not.toContain("private source");expect(failed.stats.batchFailures).toBe(1);
    model.embedBatch.mockReset().mockImplementation(async texts=>texts.map(()=>[1,0]));
    const partial=await loadConsistencyVectors(records,{scope:"account-1",identity,directory,provider:model,maxNewInputs:17});
    expect(model.embedBatch.mock.calls.map(call=>call[0].length)).toEqual([16,1]);
    expect(partial.stats).toMatchObject({newInputs:17,budgetExhausted:true,missingInputs:17});
    const resumed=await loadConsistencyVectors(records,{scope:"account-1",identity,directory,provider:model,maxNewInputs:0});
    expect(resumed.stats.cacheHits).toBe(17);expect(resumed.stats.newInputs).toBe(0);
  });
  it("validates the entire batch before writing and refuses changed input hashes",async()=>{
    const directory=await cache(),model=provider();
    model.embedBatch.mockResolvedValueOnce([[1,0],[0,0]]);
    const result=await loadConsistencyVectors([record("a"),record("b")],{scope:"account-1",identity,directory,provider:model});
    expect(result.stats.newInputs).toBe(0);expect(await readdir(directory)).toEqual([]);
    const tampered=record("a");tampered.embeddingInput="b";
    await expect(loadConsistencyVectors([tampered],{scope:"account-1",identity,directory})).rejects.toThrow("hash mismatch");
  });
  it("reuses the successful first batch when the next batch fails",async()=>{
    const directory=await cache(),model=provider(),records=Array.from({length:17},(_,i)=>record(`passage ${i}`));
    model.embedBatch.mockImplementationOnce(async texts=>texts.map(()=>[1,0])).mockRejectedValueOnce(new Error("Second batch failed"));
    const partial=await loadConsistencyVectors(records,{scope:"account-1",identity,directory,provider:model});
    expect(partial.stats).toMatchObject({newInputs:16,missingInputs:1,batchFailures:1});
    expect(await readdir(directory)).toHaveLength(16);
    model.embedBatch.mockClear();
    const resumed=await loadConsistencyVectors(records,{scope:"account-1",identity,directory,provider:model});
    expect(model.embedBatch).toHaveBeenCalledExactlyOnceWith(["passage 16"]);
    expect(resumed.stats).toMatchObject({cacheHits:16,newInputs:1,missingInputs:0});
  });
});
