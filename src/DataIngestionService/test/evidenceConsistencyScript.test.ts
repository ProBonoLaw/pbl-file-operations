import { Document } from "@langchain/core/documents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceSource } from "../src/processors/evidence/evidenceSource.ts";
import { runConsistencyReview, consistencyReviewCsv } from "../scripts/review-evidence-consistency.mjs";

const directories:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function input(){
  const directory=await mkdtemp(join(tmpdir(),"consistency-script-"));directories.push(directory);
  const quote="Casey seemed comfortable with the examiner.",source=new Document({pageContent:quote,metadata:{sourceId:"test",pages:[1]}});
  const hash=new EvidenceSource(source).contentHash;
  const metadata={what:quote,sourceId:"test",sourceContentHash:hash,pages:[1],sourceOffset:0,sourceQuote:quote,
    sourceSpans:[{pageNumber:1,sourceOffset:0,sourceQuote:quote}]};
  await writeFile(join(directory,"source.md"),quote);
  await writeFile(join(directory,"input.json"),JSON.stringify({inputHash:hash,sourceId:"test",configuration:{apiKey:"SENSITIVE_SENTINEL"},documents:[
    {pageContent:"Fact: GENERATED_LABEL",metadata:{...metadata,factType:"condition",tags:["fact"]}},
    {pageContent:"Claim: GENERATED_LABEL",metadata:{...metadata,claimType:"opinion",claimPolarity:"asserts",tags:["claim"]}},
  ]}));
  return {directory,options:{input:join(directory,"input.json"),source:join(directory,"source.md"),output:join(directory,"review")}};
}

describe("consistency sidecar command",()=>{
  it("defaults to offline observation, ignores private settings and preserves input exactly",async()=>{
    const {options}=await input(),before=await readFile(options.input,"utf8");
    const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Unexpected network"));
    const {report}=await runConsistencyReview({...options,settings:"does-not-exist-private-settings.json"});
    expect(report).toMatchObject({recordCount:2,evidenceChanged:false,chatModelCalls:0,embeddingsMode:"off",phase:"citation-only"});
    expect(report.items).toHaveLength(1);expect(network).not.toHaveBeenCalled();
    expect(await readFile(options.input,"utf8")).toBe(before);
    const exported=await readFile(join(options.output,"review.json"),"utf8");
    expect(exported).not.toMatch(/SENSITIVE_SENTINEL|GENERATED_LABEL|apiKey/);
    expect(await readFile(join(options.output,"review.csv"),"utf8")).toContain("humanVerdict");
    expect(await readFile(join(options.output,"aligned-priority-review.csv"),"utf8")).toContain("likely-aligned");
    expect(await readFile(join(options.output,"quotation-groups.csv"),"utf8")).toContain("Casey seemed comfortable");
    expect(report.quotationGroups[0].members).toHaveLength(2);
  });
  it("preserves related assertions separately from the aligned review queue",async()=>{
    const {directory,options}=await input();
    const saved=JSON.parse(await readFile(options.input,"utf8"));
    saved.documents[1].metadata.what="Avery recommended additional reading instruction.";
    await writeFile(options.input,JSON.stringify(saved));
    const args={...options,embeddings:"azure",scope:"account-1",cache:join(directory,"cache"),endpoint:"https://example.openai.azure.com",dimensions:"2"};
    const {report}=await runConsistencyReview(args,{createEmbedder:()=>({embedBatch:async(texts:string[])=>texts.map(()=>[1,0]),
      usage:{httpAttempts:1,inputTokens:8,responsesWithoutUsage:0}})});
    expect(report.items).toHaveLength(1);
    expect(report.items[0].alignment.status).toBe("related-only");
    expect(report.summary.alignedPriorityPairs).toBe(0);
    expect((await readFile(join(options.output,"aligned-priority-review.csv"),"utf8")).trim().split("\n")).toHaveLength(1);
    expect(await readFile(join(options.output,"related-passages.csv"),"utf8")).toContain("additional reading instruction");
    expect(report.quotationGroups[0].members).toHaveLength(2);
  });
  it("replays vectors without calls and never overwrites an existing review directory",async()=>{
    const {directory,options}=await input();
    const createEmbedder=vi.fn(()=>({embedBatch:vi.fn(async(texts:string[])=>texts.map(()=>[1,0])),
      usage:{httpAttempts:1,inputTokens:8,responsesWithoutUsage:0}}));
    const args={...options,embeddings:"azure",scope:"account-1",cache:join(directory,"cache"),endpoint:"https://example.openai.azure.com",dimensions:"2"};
    const first=await runConsistencyReview(args,{createEmbedder});
    expect(first.report.embeddingCache).toMatchObject({newInputs:1,reusedInputs:1});
    expect(first.report.items[0].discovery).toContain("embedding");
    const second=await runConsistencyReview({...args,output:join(directory,"cached-review"),embeddings:"cached"});
    expect(second.report.embeddingUsage.httpAttempts).toBe(0);
    expect(second.report.embeddingCache.cacheHits).toBe(1);
    await expect(runConsistencyReview(args,{createEmbedder})).rejects.toThrow();
    expect(createEmbedder).toHaveBeenCalledTimes(1);
  });
  it("retains the free queue and redacts optional embedding failures",async()=>{
    const {directory,options}=await input();
    const result=await runConsistencyReview({...options,embeddings:"azure",scope:"account-1",cache:join(directory,"cache"),endpoint:"https://example.openai.azure.com",dimensions:"2"},
      {createEmbedder:()=>({embedBatch:async()=>{throw new Error("SENSITIVE_SENTINEL request");},usage:{httpAttempts:1,inputTokens:0,responsesWithoutUsage:0}})});
    expect(result.report.phase).toBe("embedding-partial");expect(result.report.items).toHaveLength(1);
    expect(result.report.embeddingUsage.usageComplete).toBe(false);
    expect(JSON.stringify(result.report)).not.toContain("SENSITIVE_SENTINEL");
  });
  it("marks missing cached vectors as partial coverage",async()=>{
    const {directory,options}=await input();
    const {report}=await runConsistencyReview({...options,embeddings:"cached",scope:"account-1",cache:join(directory,"empty-cache"),endpoint:"https://example.openai.azure.com"});
    expect(report.phase).toBe("embedding-partial");expect(report.embeddingCache.missingInputs).toBe(1);
    expect(report.embeddingUsage.httpAttempts).toBe(0);
  });
  it("rejects source changes before making any embedding requests",async()=>{
    const {options}=await input();await writeFile(options.source,"Different source");
    await expect(runConsistencyReview(options)).rejects.toThrow("source changed");
  });
  it("escapes multiline CSV and protects spreadsheet formula cells",()=>{
    const csv=consistencyReviewCsv([{id:"id",discovery:["citation-lexical"],differences:["evidence-kind"],riskDifferences:[],lexicalSimilarity:1,cosineSimilarity:null,
      left:{index:0,label:{kind:"fact"},statement:'=HYPERLINK("example")\ntext',sourceSpans:[]},
      right:{index:1,label:{kind:"claim"},statement:"Claim",sourceSpans:[]}}]);
    expect(csv).toContain('"\'=HYPERLINK(""example"")\ntext"');
  });
});
