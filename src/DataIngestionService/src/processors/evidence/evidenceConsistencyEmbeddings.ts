import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AzureOpenAIEmbeddings } from "@langchain/openai";
import { get_encoding } from "tiktoken";
import { CONSISTENCY_INPUT_VERSION, consistencyHash, type ConsistencyRecord } from "./evidenceConsistency.js";

export interface ConsistencyEmbeddingIdentity {
  endpoint:string; deployment:string; model:"text-embedding-3-small"|"text-embedding-3-large";
  dimensions:number; apiVersion:string; inputVersion:string;
}
export interface ConsistencyEmbeddingUsage {httpAttempts:number; inputTokens:number; responsesWithoutUsage:number}
export interface ConsistencyEmbedder {
  embedBatch(texts:string[]):Promise<number[][]>;
  usage:ConsistencyEmbeddingUsage;
}
export function consistencyEmbeddingIdentity(options:{endpoint:string;deployment:string;model?:string;dimensions?:number;apiVersion?:string}):ConsistencyEmbeddingIdentity {
  const endpoint=new URL(options.endpoint);
  if(endpoint.protocol!=="https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error("Embedding endpoint must be an HTTPS resource URL without credentials or query parameters");
  const model=options.model??"text-embedding-3-small";
  if(!["text-embedding-3-small","text-embedding-3-large"].includes(model))throw new Error("Unsupported consistency embedding model");
  if(!options.deployment.trim())throw new Error("An embedding deployment is required");
  const dimensions=options.dimensions??(model==="text-embedding-3-small" ? 1536 : 3072);
  if(!Number.isSafeInteger(dimensions) || dimensions<1 || dimensions>(model==="text-embedding-3-small" ? 1536 : 3072))
    throw new Error("Invalid embedding dimensions");
  return {endpoint:new URL("/openai/deployments",endpoint).toString(),deployment:options.deployment.trim(),
    model:model as ConsistencyEmbeddingIdentity["model"],dimensions,apiVersion:options.apiVersion??"2024-12-01-preview",
    inputVersion:CONSISTENCY_INPUT_VERSION};
}

/** Use the same Azure embeddings route as ingestion; keep credentials out of cache identity and reports. */
export function createConsistencyEmbedder(identity:ConsistencyEmbeddingIdentity,apiKey:string,transport:typeof fetch=fetch):ConsistencyEmbedder {
  if(!apiKey.trim())throw new Error("An Azure embedding API key is required");
  const usage:ConsistencyEmbeddingUsage={httpAttempts:0,inputTokens:0,responsesWithoutUsage:0};
  class Client extends AzureOpenAIEmbeddings {
    async embedBatch(texts:string[]) {
      try {
        const response=await this.embeddingWithRetry({model:identity.model,input:texts,dimensions:identity.dimensions,encoding_format:"float"});
        if(Number.isSafeInteger(response.usage?.prompt_tokens) && response.usage.prompt_tokens>=0)usage.inputTokens+=response.usage.prompt_tokens;
        else usage.responsesWithoutUsage++;
        if(response.data.length!==texts.length || new Set(response.data.map(item=>item.index)).size!==texts.length
          || response.data.some(item=>!Number.isInteger(item.index) || item.index<0 || item.index>=texts.length))
          throw new Error("Embedding response indexes are invalid");
        return [...response.data].sort((a,b)=>a.index-b.index).map(item=>item.embedding);
      } catch(error) {
        const status=(error as {status?:number}).status;
        // SDK errors may include request text or headers. Persist only a bounded status.
        // eslint-disable-next-line preserve-caught-error -- Do not retain sensitive provider request data in the cause.
        throw new Error(`Consistency embedding request failed${typeof status==="number" ? ` (HTTP ${status})` : ""}`);
      }
    }
  }
  const client=new Client({model:identity.model,dimensions:identity.dimensions,encodingFormat:"float",stripNewLines:false,
    azureOpenAIBasePath:identity.endpoint,azureOpenAIApiDeploymentName:identity.deployment,
    azureOpenAIApiVersion:identity.apiVersion,azureOpenAIApiKey:apiKey,maxRetries:1,timeout:60_000,
    configuration:{fetch:async(input,init)=>{usage.httpAttempts++;return transport(input,init);}}});
  return {embedBatch:texts=>client.embedBatch(texts),usage};
}

export function consistencyCacheKey(scope:string,identity:ConsistencyEmbeddingIdentity,inputHash:string):string {
  if(!scope.trim())throw new Error("An account/case scope is required for embedding cache isolation");
  return consistencyHash([scope,identity.endpoint,identity.deployment,identity.model,identity.dimensions,
    identity.apiVersion,identity.inputVersion,inputHash]);
}
function validVector(value:unknown,dimensions:number):value is number[] {
  return Array.isArray(value) && value.length===dimensions && value.every(v=>typeof v==="number" && Number.isFinite(v))
    && Number.isFinite(Math.hypot(...value)) && Math.hypot(...value)>0;
}

/** Sequential batches, bounded paid work, private cache files, and a cache-only replay path. */
export async function loadConsistencyVectors(records:readonly ConsistencyRecord[],options:{
  scope:string;identity:ConsistencyEmbeddingIdentity;directory:string;provider?:ConsistencyEmbedder;maxNewInputs?:number;
}) {
  const limit=options.maxNewInputs??2000;
  if(!Number.isSafeInteger(limit) || limit<0)throw new Error("maxNewInputs must be a nonnegative integer");
  const identity=options.identity;
  if(identity.inputVersion!==CONSISTENCY_INPUT_VERSION)throw new Error("Embedding input version does not match this implementation");
  const entries=new Map<string,{input:string;vector:number[]|null;key:string}>();
  const stats={cacheHits:0,cacheMisses:0,invalidCacheEntries:0,newInputs:0,missingInputs:0,
    reusedInputs:0,oversizedInputs:0,budgetExhausted:false,batchFailures:0};
  for(const record of records) {
    if(record.inputHash!==consistencyHash([identity.inputVersion,record.embeddingInput]))throw new Error("Embedding input hash mismatch");
    if(entries.has(record.inputHash)){stats.reusedInputs++;continue;}
    const key=consistencyCacheKey(options.scope,identity,record.inputHash);
    let vector:number[]|null=null;
    try {
      const stored=JSON.parse(await readFile(join(options.directory,`${key}.json`),"utf8"));
      if(stored.version===1 && stored.key===key && stored.inputHash===record.inputHash && validVector(stored.vector,identity.dimensions)
        && stored.vectorHash===consistencyHash(stored.vector)) {vector=stored.vector;stats.cacheHits++;}
      else stats.invalidCacheEntries++;
    } catch(error) {
      if((error as {code?:string}).code!=="ENOENT")stats.invalidCacheEntries++;
    }
    if(!vector)stats.cacheMisses++;
    entries.set(record.inputHash,{input:record.embeddingInput,vector,key});
  }
  const errors:string[]=[];
  if(options.provider) {
    const encoder=get_encoding("cl100k_base");
    try {
      const pending=[...entries.entries()].filter(([,entry])=>entry.vector===null);
      const eligible=pending.filter(([,entry])=>{
        // Bound a 16-input batch well below the API's aggregate token limit.
        if(encoder.encode(entry.input,[],[]).length>8000){stats.oversizedInputs++;return false;}return true;
      });
      stats.budgetExhausted=eligible.length>limit;
      const selected=eligible.slice(0,limit);
      for(let start=0;start<selected.length;start+=16) {
        const batch=selected.slice(start,start+16);
        let vectors:number[][];
        try {
          vectors=await options.provider.embedBatch(batch.map(([,entry])=>entry.input));
          if(vectors.length!==batch.length || vectors.some(vector=>!validVector(vector,identity.dimensions)))throw new Error("Invalid embedding vectors");
        } catch {
          stats.batchFailures++;errors.push("Embedding batch failed; completed cache entries and citation-based review remain available.");break;
        }
        // Validate the whole batch before committing any of it.
        await mkdir(options.directory,{recursive:true,mode:0o700});
        for(let i=0;i<batch.length;i++) {
          const [inputHash,entry]=batch[i];entry.vector=vectors[i];stats.newInputs++;
          const target=join(options.directory,`${entry.key}.json`),temporary=`${target}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary,JSON.stringify({version:1,key:entry.key,inputHash,vector:entry.vector,
              vectorHash:consistencyHash(entry.vector)})+"\n",{flag:"wx",mode:0o600});
            await rename(temporary,target);
          } finally {await rm(temporary,{force:true});}
        }
      }
    } finally {encoder.free();}
  }
  stats.missingInputs=[...entries.values()].filter(entry=>entry.vector===null).length;
  return {vectors:records.map(record=>entries.get(record.inputHash)!.vector),stats,errors};
}
