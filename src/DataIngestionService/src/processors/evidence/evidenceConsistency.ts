import { createHash } from "node:crypto";
import type { Document } from "@langchain/core/documents";
import { z } from "zod";
import { EvidenceSource, type SourceSpan } from "./evidenceSource.js";
import { assessAssertionAlignment, type AssertionAlignment } from "./evidenceAssertionAlignment.js";

export const CONSISTENCY_VERSION = "2";
export const CONSISTENCY_INPUT_VERSION = "source-context-1";
export const consistencyHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown): string => typeof value === "string" ? value : "";
const normal = (value: unknown): string => text(value).normalize("NFKC").replace(/\s+/g," ").trim().toLowerCase();
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const spanSchema = z.object({pageNumber:z.number().int().nonnegative(),sourceOffset:z.number().int().nonnegative(),sourceQuote:z.string().min(1)});
export const consistencyLabelSchema = z.object({
  kind:z.enum(["event","fact","claim"]),type:z.string().min(1),
  polarity:z.enum(["asserts","denies","uncertain"]).nullable(),facets:z.array(z.string()).default([]),
}).strict().superRefine((label,ctx) => {
  if ((label.kind === "claim") !== (label.polarity !== null)) ctx.addIssue({code:"custom",message:"Only claims require polarity"});
});
export type ConsistencyLabel = z.infer<typeof consistencyLabelSchema>;
export interface ConsistencyRecord {
  id:string; index:number; sourceId:string; sourceContentHash:string; documentGroup:string;
  statement:string; label:ConsistencyLabel; sourceSpans:SourceSpan[];
  // The source-derived input is independent of every generated label and statement.
  embeddingInput:string; inputHash:string; inputTruncated:boolean;
  fields:{claimant:string; people:string[]; dates:unknown};
  review?:{reviewer:string; reviewedAt:string; rationale:string};
}

function labelFor(metadata: Record<string, unknown>): ConsistencyLabel {
  const tags = strings(metadata.tags);
  const kind = metadata.claimType ? "claim" : metadata.factType ? "fact" : tags.includes("event") ? "event" : null;
  return consistencyLabelSchema.parse({kind,
    type:kind === "claim" ? metadata.claimType : kind === "fact" ? metadata.factType : tags.find(tag => tag.startsWith("eventType:"))?.slice(10),
    polarity:kind === "claim" ? metadata.claimPolarity : null,
    facets:[...new Set(tags.filter(tag => tag.startsWith("facet:")))].sort()});
}

/** Build a source-only representation. Never strip or reuse rendered pageContent. */
export function prepareConsistencyRecords(documents: readonly Document[], sourceDocument: Document,
  documentGroup = String(sourceDocument.metadata.sourceId ?? "")): ConsistencyRecord[] {
  if (!documentGroup.trim()) throw new Error("A document group is required for evaluation isolation");
  const source = new EvidenceSource(sourceDocument);
  const sourceId = String(sourceDocument.metadata.sourceId ?? "");
  if (!sourceId) throw new Error("Consistency sourceId is required");
  const pages = new Map(source.pages.map(page => [page.pageNumber,page.text]));
  const headings = new Map<number, {offset:number; section:string}[]>();
  const stack:{depth:number; title:string}[] = [];
  for (const page of source.pages) {
    const entries = [{offset:0,section:stack.map(item=>item.title).join(" / ")}];
    for (const match of page.text.matchAll(/^ {0,3}(#{1,6})\s+(.+)$/gm)) {
      while (stack.length && stack.at(-1)!.depth >= match[1].length) stack.pop();
      stack.push({depth:match[1].length,title:match[2]});
      entries.push({offset:match.index,section:stack.map(item=>item.title).join(" / ")});
    }
    headings.set(page.pageNumber,entries);
  }
  return documents.map((document,index) => {
    const m = document.metadata;
    const spans = z.array(spanSchema).min(1).parse(m.sourceSpans);
    const primary = spans[0];
    if (m.sourceContentHash !== source.contentHash || String(m.sourceId) !== sourceId
      || m.sourceQuote !== primary.sourceQuote || m.sourceOffset !== primary.sourceOffset || m.pages?.[0] !== primary.pageNumber
      || spans.some(span => pages.get(span.pageNumber)?.slice(span.sourceOffset,span.sourceOffset+span.sourceQuote.length) !== span.sourceQuote)) {
      throw new Error(`Unverified consistency source or citation at record ${index}`);
    }
    const page = pages.get(primary.pageNumber)!;
    const end = primary.sourceOffset+primary.sourceQuote.length;
    const section = headings.get(primary.pageNumber)!.findLast(item=>item.offset<=primary.sourceOffset)!.section;
    const input = {quote:primary.sourceQuote.slice(0,2400),
      precedingContext:page.slice(Math.max(0,primary.sourceOffset-200),primary.sourceOffset),
      followingContext:page.slice(end,end+200),section:section.slice(-400)};
    const embeddingInput = JSON.stringify(input);
    const statement = text(m.what).trim();
    if (!statement) throw new Error(`Missing proposition at record ${index}`);
    const label = labelFor(m);
    return {id:consistencyHash([sourceId,source.contentHash,index,primary,statement,label]),index,
      sourceId,sourceContentHash:source.contentHash,documentGroup,statement,label,sourceSpans:spans,
      embeddingInput,inputHash:consistencyHash([CONSISTENCY_INPUT_VERSION,embeddingInput]),
      inputTruncated:primary.sourceQuote.length>2400 || section.length>400,
      fields:{claimant:text(m.claimant),people:[...new Set([...strings(m.who),...strings(m.subject),...strings(m.reportedBy)])].sort(),
        dates:structuredClone({asOf:m.asOf??null,whenStarted:m.whenStarted??null,whenEnded:m.whenEnded??null,eventDateResolution:m.eventDateResolution??null})}};
  });
}

const exampleBundleSchema = z.object({version:z.literal(1),scope:z.string().min(1),
  sources:z.array(z.object({sourceId:z.string().min(1),documentGroup:z.string().min(1),pageContent:z.string().min(1),
    pages:z.array(z.number().int().nonnegative()).min(1)})).min(1),
  examples:z.array(z.object({id:z.string().min(1),sourceId:z.string().min(1),sourceContentHash:z.string().min(1),
    sourceSpans:z.array(spanSchema).min(1),label:consistencyLabelSchema,
    review:z.object({status:z.literal("human-reviewed"),reviewer:z.string().trim().min(1),reviewedAt:z.string().datetime(),rationale:z.string().trim().min(1)})})),
});

/** Labels enter reference retrieval only through an explicitly reviewed, source-validated bundle. */
export function prepareReviewedExamples(value: unknown, scope: string, target: readonly ConsistencyRecord[]) {
  const bundle = exampleBundleSchema.parse(value);
  if (bundle.scope !== scope) throw new Error("Reviewed-example scope does not match this run");
  if (new Set(bundle.sources.map(source=>source.sourceId)).size !== bundle.sources.length
    || new Set(bundle.examples.map(example=>example.id)).size !== bundle.examples.length) throw new Error("Duplicate reference source/example IDs");
  const records:ConsistencyRecord[] = [];
  let excludedSameDocument = 0;
  for (const example of bundle.examples) {
    const source = bundle.sources.find(source=>source.sourceId===example.sourceId);
    if (!source || source.pages.length !== source.pageContent.split("<!-- PageBreak -->").length
      || new Set(source.pages).size !== source.pages.length) throw new Error("Invalid reference source/pages");
    const primary = example.sourceSpans[0], label = example.label;
    const metadata = {sourceId:source.sourceId,sourceContentHash:example.sourceContentHash,sourceSpans:example.sourceSpans,
      pages:example.sourceSpans.map(span=>span.pageNumber),sourceOffset:primary.sourceOffset,sourceQuote:primary.sourceQuote,
      what:primary.sourceQuote,tags:[label.kind,...label.facets,...(label.kind === "event" ? [`eventType:${label.type}`] : [])],
      ...(label.kind === "claim" ? {claimType:label.type,claimPolarity:label.polarity} : label.kind === "fact" ? {factType:label.type} : {})};
    const [record] = prepareConsistencyRecords([{metadata,pageContent:""} as Document],
      {pageContent:source.pageContent,metadata:{sourceId:source.sourceId,pages:source.pages}} as Document,source.documentGroup);
    if (target.some(item=>item.sourceContentHash===record.sourceContentHash || item.sourceId===record.sourceId || item.documentGroup===record.documentGroup)) {
      excludedSameDocument++;
      continue;
    }
    records.push({...record,id:`reference:${example.id}`,index:records.length,review:{reviewer:example.review.reviewer,
      reviewedAt:example.review.reviewedAt,rationale:example.review.rationale}});
  }
  return {records,excludedSameDocument};
}

export function labelDifferences(left: ConsistencyLabel, right: ConsistencyLabel): string[] {
  return [left.kind!==right.kind ? "evidence-kind" : null,
    left.kind===right.kind && left.type!==right.type ? "subtype" : null,
    left.kind==="claim" && right.kind==="claim" && left.polarity!==right.polarity ? "polarity" : null,
    JSON.stringify([...left.facets].sort())!==JSON.stringify([...right.facets].sort()) ? "facets" : null].filter((v):v is string=>v!==null);
}
const words = (value:string) => new Set((normal(value).match(/[\p{L}\p{N}]+/gu)??[])
  .filter(word=>!/^(the|a|an|is|was|are|were|of|to|in|and|or|at|for|with|that|this)$/.test(word)));
function lexicalSimilarity(left:string,right:string):number {
  if (normal(left)===normal(right)) return 1;
  const a=words(left),b=words(right),common=[...a].filter(word=>b.has(word)).length;
  return common<3 ? 0 : 2*common/Math.max(1,a.size+b.size);
}
function citationOverlap(left:ConsistencyRecord,right:ConsistencyRecord):boolean {
  const a=left.sourceSpans[0],b=right.sourceSpans[0];
  return left.sourceContentHash===right.sourceContentHash && left.sourceId===right.sourceId && a.pageNumber===b.pageNumber
    && Math.min(a.sourceOffset+a.sourceQuote.length,b.sourceOffset+b.sourceQuote.length)-Math.max(a.sourceOffset,b.sourceOffset)>=Math.min(12,a.sourceQuote.length,b.sourceQuote.length);
}
function riskDifferences(left:ConsistencyRecord,right:ConsistencyRecord):string[] {
  const checks:[string,(record:ConsistencyRecord)=>unknown][] = [
    ["negation",record=>/\b(no|not|never|without|denied|denies)\b/i.test(record.statement)],
    ["modality",record=>/\b(may|might|could|possible|alleged|suspected|should|recommend\w*)\b/i.test(record.statement)],
    ["numbers",record=>[...new Set(record.statement.match(/\b\d+(?:[.,:/-]\d+)*\b/g)??[])].sort()],
    ["attribution",record=>normal(record.fields.claimant)],
    ["people",record=>record.fields.people.map(normal).sort()],
    ["dates",record=>record.fields.dates],
  ];
  return checks.filter(([,value])=>JSON.stringify(value(left))!==JSON.stringify(value(right))).map(([name])=>name);
}
const view = (record:ConsistencyRecord) => ({id:record.id,index:record.index,sourceId:record.sourceId,
  sourceContentHash:record.sourceContentHash,documentGroup:record.documentGroup,statement:record.statement,
  embeddingInputHash:record.inputHash,inputTruncated:record.inputTruncated,
  label:record.label,sourceSpans:record.sourceSpans,fields:record.fields,...(record.review ? {review:record.review} : {})});
export interface ConsistencyReviewItem {
  id:string; left:ReturnType<typeof view>; right:ReturnType<typeof view>; differences:string[];
  discovery:("citation-lexical"|"quotation-group"|"embedding"|"reviewed-example")[]; lexicalSimilarity:number; cosineSimilarity:number|null;
  riskDifferences:string[]; review:{verdict:""; notes:""};
  alignment:AssertionAlignment; quotationGroupIds:string[];
  reviewedNeighbors?:{record:ReturnType<typeof view>;cosineSimilarity:number}[];
}
export interface ConsistencyQuotationGroup {
  id:string; sourceId:string; sourceContentHash:string;
  members:ReturnType<typeof view>[];
  reviewPairIds:string[];
  likelyAlignedPairIds:string[];
}
/** Exact text after whitespace normalization, isolated by source identity.
 * Different occurrences retain their original page/offset and every record.
 */
export function groupRepeatedQuotations(records:readonly ConsistencyRecord[]):ConsistencyQuotationGroup[] {
  const groups=new Map<string,ConsistencyRecord[]>();
  for(const record of records){
    const quote=record.sourceSpans[0].sourceQuote.replace(/\s+/g," ").trim();
    const key=consistencyHash(["quotation-group-1",record.sourceId,record.sourceContentHash,quote]);
    const members=groups.get(key)??[];members.push(record);groups.set(key,members);
  }
  return [...groups].filter(([,members])=>members.length>1).map(([id,members])=>({id,
    sourceId:members[0].sourceId,sourceContentHash:members[0].sourceContentHash,
    members:members.map(view),reviewPairIds:[],likelyAlignedPairIds:[]}));
}
export interface ConsistencyOptions {
  lexicalThreshold?:number; embeddingThreshold?:number; topK?:number; maxPairs?:number; maxComparisons?:number;
  vectors?:readonly (readonly number[]|null)[]; examples?:readonly ConsistencyRecord[]; exampleVectors?:readonly (readonly number[]|null)[];
}
function normalizedVectors(vectors: readonly (readonly number[]|null)[]|undefined,count:number): (number[]|null)[] {
  if (!vectors) return Array.from({length:count},()=>null);
  if (vectors.length!==count) throw new Error("Embedding count does not match records");
  return vectors.map(vector=>{
    if (vector===null) return null;
    if (!vector.length || vector.some(value=>!Number.isFinite(value))) throw new Error("Invalid consistency vector");
    const norm=Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm===0) throw new Error("Invalid consistency vector norm");
    return vector.map(value=>value/norm);
  });
}

/** Observe disagreements only. This function never changes, rejects or merges evidence. */
export function detectEvidenceConsistency(records: readonly ConsistencyRecord[], options:ConsistencyOptions = {}) {
  const config={lexicalThreshold:options.lexicalThreshold??0.7,embeddingThreshold:options.embeddingThreshold??0.88,
    topK:options.topK??5,maxPairs:options.maxPairs??1000,maxComparisons:options.maxComparisons??250_000};
  for (const name of ["lexicalThreshold","embeddingThreshold"] as const)
    if (!Number.isFinite(config[name]) || config[name]<0 || config[name]>1) throw new Error(`Invalid ${name}`);
  for (const name of ["topK","maxPairs","maxComparisons"] as const)
    if (!Number.isSafeInteger(config[name]) || config[name]<1) throw new Error(`Invalid ${name}`);
  const items=new Map<string,ConsistencyReviewItem>();
  const quotationGroups=groupRepeatedQuotations(records);
  const groupByRecord=new Map(quotationGroups.flatMap(group=>group.members.map(member=>[member.id,group.id] as const)));
  const stats={lexicalComparisons:0,embeddingComparisons:0,embeddingPairsExamined:0,lexicalBudgetExhausted:false,embeddingBudgetExhausted:false,
    quotationComparisons:0,quotationBudgetExhausted:false,
    queueTruncated:false,recordsWithoutEmbeddings:0,examplesWithoutEmbeddings:0};
  const add=(left:ConsistencyRecord,right:ConsistencyRecord,discovery:ConsistencyReviewItem["discovery"][number],cosine:number|null=null)=>{
    const id=consistencyHash([CONSISTENCY_VERSION,left.id,right.id]);
    const found=items.get(id);
    if (found) {if(!found.discovery.includes(discovery))found.discovery.push(discovery);if(cosine!==null)found.cosineSimilarity=cosine;return;}
    if (items.size>=config.maxPairs) {stats.queueTruncated=true;return;}
    items.set(id,{id,left:view(left),right:view(right),differences:labelDifferences(left.label,right.label),discovery:[discovery],
      lexicalSimilarity:lexicalSimilarity(left.statement,right.statement),cosineSimilarity:cosine,
      alignment:assessAssertionAlignment(left,right),
      quotationGroupIds:[...new Set([groupByRecord.get(left.id),groupByRecord.get(right.id)].filter((id):id is string=>Boolean(id)))],
      riskDifferences:riskDifferences(left,right),review:{verdict:"",notes:""}});
  };
  // Group by page, not assigned kind: cross-kind disagreements are the point.
  const pages=new Map<string,ConsistencyRecord[]>();
  for (const record of records) {
    const key=JSON.stringify([record.sourceId,record.sourceContentHash,record.sourceSpans[0].pageNumber]);
    const bucket=pages.get(key)??[];bucket.push(record);pages.set(key,bucket);
  }
  // Shared source wording is free retrieval, but only likely matching assertions
  // create extra pairs. All other statements remain visible in the group export.
  const recordById=new Map(records.map(record=>[record.id,record]));
  quotations: for(const group of quotationGroups){
    for(let i=0;i<group.members.length;i++)for(let j=i+1;j<group.members.length;j++){
      if(stats.quotationComparisons>=config.maxComparisons){stats.quotationBudgetExhausted=true;break quotations;}
      stats.quotationComparisons++;
      const [left,right]=[recordById.get(group.members[i].id)!,recordById.get(group.members[j].id)!].sort((a,b)=>a.index-b.index);
      if(labelDifferences(left.label,right.label).length && assessAssertionAlignment(left,right).status==="likely-aligned")
        add(left,right,"quotation-group");
    }
  }
  lexical: for (const bucket of pages.values()) {
    bucket.sort((a,b)=>a.sourceSpans[0].sourceOffset-b.sourceSpans[0].sourceOffset || a.index-b.index);
    for (let i=0;i<bucket.length;i++) for (let j=i+1;j<bucket.length;j++) {
      if (bucket[j].sourceSpans[0].sourceOffset>=bucket[i].sourceSpans[0].sourceOffset+bucket[i].sourceSpans[0].sourceQuote.length) break;
      if (stats.lexicalComparisons>=config.maxComparisons) {stats.lexicalBudgetExhausted=true;break lexical;}
      stats.lexicalComparisons++;
      const [left,right]=[bucket[i],bucket[j]].sort((a,b)=>a.index-b.index);
      if (citationOverlap(left,right) && labelDifferences(left.label,right.label).length
        && lexicalSimilarity(left.statement,right.statement)>=config.lexicalThreshold) add(left,right,"citation-lexical");
    }
  }
  const examples=options.examples??[];
  if(examples.some(example=>!example.review?.reviewer.trim() || !example.review.rationale.trim() || !Number.isFinite(Date.parse(example.review.reviewedAt))))
    throw new Error("Reference examples must include explicit adjudication provenance");
  const vectors=normalizedVectors(options.vectors,records.length), referenceVectors=normalizedVectors(options.exampleVectors,examples.length);
  const sizes=new Set([...vectors,...referenceVectors].filter((v):v is number[]=>v!==null).map(vector=>vector.length));
  if (sizes.size>1) throw new Error("Consistency vector dimensions differ");
  stats.recordsWithoutEmbeddings=vectors.filter(vector=>vector===null).length;
  stats.examplesWithoutEmbeddings=referenceVectors.filter(vector=>vector===null).length;
  const neighbors=new Map<number,{right:number; score:number; reference:boolean}[]>();
  const reviewedNeighbors=new Map<number,{right:number; score:number; reference:boolean}[]>();
  const remember=(left:number,right:number,score:number,reference:boolean)=>{
    const map=reference ? reviewedNeighbors : neighbors;
    const bucket=map.get(left)??[];bucket.push({right,score,reference});
    bucket.sort((a,b)=>b.score-a.score || Number(b.reference)-Number(a.reference) || a.right-b.right);
    bucket.length=Math.min(bucket.length,config.topK);map.set(left,bucket);
  };
  const compare=(i:number,j:number,reference:boolean):boolean=>{
    if (stats.embeddingPairsExamined>=config.maxComparisons) {stats.embeddingBudgetExhausted=true;return false;}
    stats.embeddingPairsExamined++;
    const left=vectors[i],right=reference ? referenceVectors[j] : vectors[j];
    if (!left || !right) return true;
    const a=records[i],b=reference ? examples[j] : records[j];
    if (reference && (a.documentGroup===b.documentGroup || a.sourceContentHash===b.sourceContentHash || a.sourceId===b.sourceId)) return true;
    // Reference retrieval must include agreeing examples, rather than seeking
    // only dissenting labels and manufacturing a disagreement.
    if (!reference && !labelDifferences(a.label,b.label).length) return true;
    stats.embeddingComparisons++;
    const score=Math.max(-1,Math.min(1,left.reduce((sum,value,k)=>sum+value*right[k],0)));
    if(score>=config.embeddingThreshold) {
      remember(i,j,score,reference);
      if(!reference)remember(j,i,score,false);
    }
    return true;
  };
  // Reference examples get first use of the explicit comparison budget. Round
  // robin across targets avoids spending the budget on only the first record.
  if(vectors.some(vector=>vector!==null)) {
    references: for(let j=0;j<examples.length;j++) for(let i=0;i<records.length;i++) if(!compare(i,j,true))break references;
    pairs: for(let distance=1;distance<records.length;distance++) for(let i=0;i+distance<records.length;i++)
      if(!compare(i,i+distance,false))break pairs;
  }
  for(const [i,bucket]of neighbors)for(const neighbor of bucket){
    const [a,b]=[i,neighbor.right].sort((a,b)=>a-b);add(records[a],records[b],"embedding",neighbor.score);
  }
  for(const [i,bucket]of reviewedNeighbors)for(const neighbor of bucket){
    if(!labelDifferences(records[i].label,examples[neighbor.right].label).length)continue;
    add(records[i],examples[neighbor.right],"reviewed-example",neighbor.score);
    const item=items.get(consistencyHash([CONSISTENCY_VERSION,records[i].id,examples[neighbor.right].id]));
    if(item)item.reviewedNeighbors=bucket.map(match=>({record:view(examples[match.right]),cosineSimilarity:match.score}));
  }
  const priority=(item:ConsistencyReviewItem)=>item.differences.includes("evidence-kind") ? 3 : item.differences.includes("polarity") ? 2
    : item.differences.includes("subtype") ? 1 : 0;
  const alignmentRank={"likely-aligned":2,uncertain:1,"related-only":0};
  const ordered=[...items.values()].sort((a,b)=>alignmentRank[b.alignment.status]-alignmentRank[a.alignment.status]
    || Number(b.discovery.includes("reviewed-example"))-Number(a.discovery.includes("reviewed-example"))
    || priority(b)-priority(a) || (b.cosineSimilarity??b.lexicalSimilarity)-(a.cosineSimilarity??a.lexicalSimilarity) || a.id.localeCompare(b.id));
  const groupsById=new Map(quotationGroups.map(group=>[group.id,group]));
  for(const item of ordered)for(const id of item.quotationGroupIds){
    const group=groupsById.get(id)!;
    group.reviewPairIds.push(item.id);
    if(item.alignment.status==="likely-aligned")group.likelyAlignedPairIds.push(item.id);
  }
  return {version:CONSISTENCY_VERSION,mode:"observation-only" as const,config,stats,
    summary:{reviewPairs:ordered.length,priorityPairs:ordered.filter(item=>priority(item)>0).length,
      facetOnlyPairs:ordered.filter(item=>priority(item)===0).length,
      alignedPriorityPairs:ordered.filter(item=>priority(item)>0 && item.alignment.status==="likely-aligned").length,
      byAlignment:Object.fromEntries(["likely-aligned","uncertain","related-only"].map(status=>[status,ordered.filter(item=>item.alignment.status===status).length])),
      repeatedQuotationGroups:quotationGroups.length,groupedRecords:quotationGroups.reduce((sum,group)=>sum+group.members.length,0),
      byDifference:Object.fromEntries(["evidence-kind","subtype","polarity","facets"].map(reason=>[reason,ordered.filter(item=>item.differences.includes(reason)).length]))},
    items:ordered,quotationGroups};
}
