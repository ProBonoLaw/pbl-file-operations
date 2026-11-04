import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Document } from "@langchain/core/documents";
import { prepareConsistencyRecords, prepareReviewedExamples, detectEvidenceConsistency, CONSISTENCY_INPUT_VERSION } from "../dist/src/processors/evidence/evidenceConsistency.js";
import { consistencyEmbeddingIdentity, createConsistencyEmbedder, loadConsistencyVectors } from "../dist/src/processors/evidence/evidenceConsistencyEmbeddings.js";

// Spreadsheet cells can contain source text. Quoting alone does not prevent formulas.
const cell = value => {
  const raw=typeof value==="string" ? value : JSON.stringify(value??"");
  const safe=/^[\s]*[=+@-]/.test(raw) ? "'"+raw : raw;
  return `"${safe.replaceAll('"','""')}"`;
};
export function consistencyReviewCsv(items) {
  const header=["reviewId","discovery","differences","riskDifferences","lexicalSimilarity","cosineSimilarity",
    "assertionAlignment","alignmentReasons","assertionNormalizations","leftOnlyTerms","rightOnlyTerms","quotationGroupIds",
    "leftIndex","rightIndex","leftLabel","rightLabel","leftStatement","rightStatement","leftCitations","rightCitations",
    "referenceReview","humanVerdict","incorrectSide","correctLabel","reviewer","reviewNotes"];
  const rows=items.map(item=>[item.id,item.discovery,item.differences,item.riskDifferences,item.lexicalSimilarity,item.cosineSimilarity,
    item.alignment?.status??"",item.alignment?.reasons??[],item.alignment?.normalizations??[],item.alignment?.leftOnlyTerms??[],item.alignment?.rightOnlyTerms??[],item.quotationGroupIds??[],
    item.left.index,item.right.index,item.left.label,item.right.label,item.left.statement,item.right.statement,
    item.left.sourceSpans,item.right.sourceSpans,item.right.review??null,"","","","",""]);
  return [header,...rows].map(row=>row.map(cell).join(",")).join("\n")+"\n";
}
export function consistencyQuotationCsv(groups) {
  const header=["quotationGroupId","sourceId","recordCount","primaryQuotation","occurrences","records","reviewPairIds","likelyAlignedPairIds"];
  const rows=groups.map(group=>[group.id,group.sourceId,group.members.length,group.members[0].sourceSpans[0].sourceQuote,
    [...new Map(group.members.map(member=>[JSON.stringify(member.sourceSpans[0]),member.sourceSpans[0]])).values()],
    group.members.map(member=>({id:member.id,index:member.index,statement:member.statement,label:member.label})),group.reviewPairIds,group.likelyAlignedPairIds]);
  return [header,...rows].map(row=>row.map(cell).join(",")).join("\n")+"\n";
}

/** A sidecar evaluation command: no indexing client, extractor, or chat model is loaded. */
export async function runConsistencyReview(values, dependencies={}) {
  const started=performance.now();
  assert.ok(values.input && values.source && values.output,"Provide --input RESULT.json --source SOURCE.md --output NEW_DIRECTORY");
  const mode=values.embeddings??"off";
  assert.ok(["off","cached","azure"].includes(mode),"--embeddings must be off, cached, or azure");
  assert.ok(mode==="off" || values.scope && values.cache,"Embedding runs require --scope ACCOUNT_OR_CASE and --cache DIRECTORY");
  assert.ok(!values.examples || values.scope,"Reviewed examples require an explicit --scope");
  const saved=JSON.parse(await readFile(resolve(values.input),"utf8"));
  const content=await readFile(resolve(values.source),"utf8");
  const sourceHash=createHash("sha256").update(content).digest("hex");
  assert.equal(saved.inputHash??saved.sourceHash,sourceHash,"The source changed since extraction");
  assert.ok(Array.isArray(saved.documents),"Input must contain documents");
  const firstPage=Number(values["first-page"]??1);
  assert.ok(Number.isSafeInteger(firstPage) && firstPage>=0,"Invalid --first-page");
  const sourceId=String(saved.sourceId??saved.documents[0]?.metadata.sourceId??"empty-source");
  const source=new Document({pageContent:content,metadata:{sourceId,pages:content.split("<!-- PageBreak -->").map((_,i)=>i+firstPage)}});
  const group=values["document-group"]??sourceId;
  const records=prepareConsistencyRecords(saved.documents.map(document=>new Document(document)),source,group);
  const scope=values.scope??`local-document:${sourceHash}`;
  const references=values.examples ? prepareReviewedExamples(JSON.parse(await readFile(resolve(values.examples),"utf8")),scope,records)
    : {records:[],excludedSameDocument:0};
  const options={lexicalThreshold:Number(values["lexical-threshold"]??0.7),embeddingThreshold:Number(values["embedding-threshold"]??0.88),
    topK:Number(values["top-k"]??5),maxPairs:Number(values["max-pairs"]??1000),maxComparisons:Number(values["max-comparisons"]??250000)};
  const initial=detectEvidenceConsistency(records,{...options,examples:references.records});
  const output=resolve(values.output);
  await mkdir(dirname(output),{recursive:true,mode:0o700});
  // Reserve a new directory before any paid work, preserving prior review labels.
  await mkdir(output,{mode:0o700});
  const base={sourceHash,sourceId,documentGroup:group,scope,inputVersion:CONSISTENCY_INPUT_VERSION,
    recordCount:records.length,referenceCount:references.records.length,excludedSameDocumentExamples:references.excludedSameDocument,
    truncatedInputs:records.filter(record=>record.inputTruncated).length,embeddingsMode:mode,
    evidenceChanged:false,chatModelCalls:0};
  const persist=async report=>{
    await writeFile(resolve(output,"review.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});
    await writeFile(resolve(output,"review.csv"),consistencyReviewCsv(report.items),{mode:0o600});
    await writeFile(resolve(output,"priority-review.csv"),consistencyReviewCsv(report.items.filter(item=>item.differences.some(reason=>reason!=="facets"))),{mode:0o600});
    await writeFile(resolve(output,"aligned-priority-review.csv"),consistencyReviewCsv(report.items.filter(item=>item.alignment.status==="likely-aligned" && item.differences.some(reason=>reason!=="facets"))),{mode:0o600});
    await writeFile(resolve(output,"uncertain-review.csv"),consistencyReviewCsv(report.items.filter(item=>item.alignment.status==="uncertain")),{mode:0o600});
    await writeFile(resolve(output,"related-passages.csv"),consistencyReviewCsv(report.items.filter(item=>item.alignment.status==="related-only")),{mode:0o600});
    await writeFile(resolve(output,"quotation-groups.csv"),consistencyQuotationCsv(report.quotationGroups),{mode:0o600});
  };
  // Preserve the free queue even if optional embedding setup or requests fail.
  let report={...base,...initial,phase:"citation-only",elapsedMs:performance.now()-started,
    embeddingUsage:{httpAttempts:0,reportedInputTokens:0,outputTokens:0,usageComplete:true},errors:[]};
  await persist(report);
  if(mode!=="off") {
    let provider;
    try {
      const settings=values.settings ? JSON.parse(await readFile(resolve(values.settings),"utf8")) : process.env;
      const model=values.model??"text-embedding-3-small";
      const identity=consistencyEmbeddingIdentity({endpoint:values.endpoint??settings.AZURE_OPENAI_CUSTOM_ENDPOINT??"",
        deployment:values.deployment??settings[model==="text-embedding-3-large" ? "TEXT_EMBEDDING_LARGE_DEPLOYMENT_NAME" : "TEXT_EMBEDDING_SMALL_DEPLOYMENT_NAME"]??model,
        model,dimensions:values.dimensions===undefined ? undefined : Number(values.dimensions),apiVersion:values["api-version"]});
      provider=mode==="azure" ? (dependencies.createEmbedder??createConsistencyEmbedder)(identity,settings.AZURE_OPENAI_API_KEY??"") : undefined;
      const embedded=await loadConsistencyVectors([...references.records,...records],{scope,identity,
        directory:resolve(values.cache),provider,maxNewInputs:Number(values["max-new-inputs"]??2000)});
      const result=detectEvidenceConsistency(records,{...options,vectors:embedded.vectors.slice(references.records.length),
        examples:references.records,exampleVectors:embedded.vectors.slice(0,references.records.length)});
      report={...base,...result,phase:embedded.errors.length || embedded.stats.missingInputs ? "embedding-partial" : "complete",elapsedMs:performance.now()-started,
        embeddingIdentity:identity,embeddingCache:embedded.stats,
        embeddingUsage:{httpAttempts:provider?.usage.httpAttempts??0,reportedInputTokens:provider?.usage.inputTokens??0,outputTokens:0,
          usageComplete:!embedded.errors.length && !provider?.usage.responsesWithoutUsage},errors:embedded.errors};
    } catch {
      report={...report,phase:"embedding-failed",elapsedMs:performance.now()-started,
        embeddingUsage:{httpAttempts:provider?.usage.httpAttempts??0,reportedInputTokens:provider?.usage.inputTokens??0,outputTokens:0,usageComplete:false},
        errors:["Optional embedding stage failed. Check its settings/cache; the citation-only review queue is preserved."]};
    }
    await persist(report);
  }
  await writeFile(resolve(output,"README.md"),`# Evidence consistency review\n\nMode: observation only. Evidence was not changed or indexed.\n\n`
    + `Review rows: ${report.items.length}. Embedding mode: ${mode}. Phase: ${report.phase}.\n\n`
    + "Start with quotation-groups.csv to review repeated source wording together and aligned-priority-review.csv for likely matching assertions with kind/subtype/polarity differences. uncertain-review.csv preserves ambiguous matches; related-passages.csv holds related passages with different assertion terms. priority-review.csv still contains all material pairs, and review.csv retains every pair including facets. review.json preserves all records and exact citations. Fill humanVerdict with classification-error, legitimate-difference or uncertain; record incorrectSide, correctLabel, reviewer and reviewNotes.\n\n"
    + "Assertion alignment uses deterministic wording, term coverage and word order checks, with qualification, number and participant warnings. It uses neither generated labels nor embedding similarity as proof of equivalent meaning. Statuses are review-routing heuristics, not verified semantic judgments. Quotation groups preserve all members and occurrences and never merge evidence.\n\n"
    + "A shared quote or high similarity does not prove that two records state the same proposition. Preserve separate assertions, speakers, dates, negation and qualifications. Reference labels are usable only within their reviewed source context.\n\n"
    + "Similarity thresholds are uncalibrated retrieval cutoffs, not confidence probabilities. Inspect comparison/queue budgets and embedding coverage in review.json. This queue alone cannot measure recall or false-negative rates; review an independently sampled set of unflagged records too.\n\n"
    + "Cached vectors are local reuse, not provider prompt-cache tokens. reportedInputTokens counts only provider-reported usage; usageComplete=false means the total is unknown. No chat model is used.\n\n"
    + "These files contain source evidence. Share only reviewed exports, excluding private settings and embedding caches.\n",{mode:0o600});
  return {output,report};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const names=["input","source","output","embeddings","scope","cache","settings","examples","document-group","first-page",
    "endpoint","deployment","model","dimensions","api-version","lexical-threshold","embedding-threshold","top-k","max-pairs","max-comparisons","max-new-inputs"];
  const {values}=parseArgs({options:Object.fromEntries(names.map(name=>[name,{type:"string"}]))});
  try {
    const {output,report}=await runConsistencyReview(values);
    console.log(JSON.stringify({output,records:report.recordCount,reviewItems:report.items.length,phase:report.phase,
      summary:report.summary,stats:report.stats,embeddingCache:report.embeddingCache,embeddingUsage:report.embeddingUsage,errors:report.errors},null,2));
    if(report.errors.length)process.exitCode=1;
  } catch {
    console.error("Consistency review failed. Verify input/source hashes, source citations, options, and that the output directory is new.");
    process.exitCode=1;
  }
}
