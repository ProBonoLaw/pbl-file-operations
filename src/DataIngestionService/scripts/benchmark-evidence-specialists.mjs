import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Document } from "@langchain/core/documents";
import { evidenceSkillsFingerprint } from "../dist/src/processors/evidence/evidenceSkills.js";
import { findCanonicalizationPairs } from "../dist/src/processors/evidence/evidenceCanonicalization.js";
import { EvidenceSource } from "../dist/src/processors/evidence/evidenceSource.js";

const {values} = parseArgs({options:{input:{type:"string"},output:{type:"string"},
  settings:{type:"string"},live:{type:"boolean",default:false}}});
assert(values.input && values.output, "Provide --input FIXTURE.json and --output DIRECTORY");
assert(!values.live || values.settings, "Live model calls require --live --settings FILE");
const inputPath = resolve(values.input), output = resolve(values.output);
const raw = await readFile(inputPath, "utf8"), fixture = JSON.parse(raw);
const hash = value => createHash("sha256").update(value).digest("hex");
assert.equal(fixture.version, 1);
assert(Array.isArray(fixture.tasks) && fixture.tasks.length > 0 && fixture.tasks.length <= 12);
assert.equal(new Set(fixture.tasks.map(task => task.id)).size, fixture.tasks.length);
const sourceText = await readFile(resolve(dirname(inputPath), fixture.source.path), "utf8");
assert.equal(hash(sourceText), fixture.source.sha256, "Source changed after fixture preparation");
const document = new Document({pageContent:sourceText,metadata:{sourceId:fixture.source.sourceId,
  pages:sourceText.split("<!-- PageBreak -->").map((_, index) => index + 1)}});
const source = new EvidenceSource(document);
const plan = fixture.tasks.map(task => {
  assert(/^[a-z0-9-]+$/.test(task.id), "Use simple task IDs");
  if (task.kind === "attribution") {
    const window = source.windows().find(w => w.pageNumber === task.pageNumber && w.startOffset === task.startOffset);
    assert(window && task.candidates.length > 0 && task.candidates.length <= 8, "Attribution task must fit a bounded window");
    assert.equal(new Set(task.candidates.map(c => c.id)).size, task.candidates.length);
    for (const candidate of task.candidates) {
      assert.equal(candidate.kind, "claim");
      assert(source.locate(window, candidate.item.sourceQuote), "Candidate must have a valid primary anchor");
    }
    return {id:task.id,kind:task.kind,candidateCount:task.candidates.length};
  }
  assert.equal(task.kind, "identity");
  assert(task.documents.length >= 2 && task.documents.length <= 20);
  for (const item of task.documents) {
    assert.equal(item.metadata.sourceContentHash, source.contentHash);
    for (const span of item.metadata.sourceSpans) {
      const page = source.pages.find(p => p.pageNumber === span.pageNumber);
      assert.equal(page?.text.slice(span.sourceOffset, span.sourceOffset + span.sourceQuote.length), span.sourceQuote);
    }
  }
  const pairs = findCanonicalizationPairs(task.documents);
  assert(pairs.length > 0 && pairs.length <= 12, "Identity tasks need 1–12 eligible pairs");
  return {id:task.id,kind:task.kind,documentCount:task.documents.length,pairCount:pairs.length};
});

let configuration = {}, configurationHash = null, events = [];
if (values.live) {
  const settings = JSON.parse(await readFile(resolve(values.settings), "utf8"));
  for (const name of Object.keys(process.env)) if (/^(AZURE_OPENAI_|EVIDENCE_|LANGCHAIN_|LANGSMITH_)/.test(name)) delete process.env[name];
  for (const [name,value] of Object.entries(settings)) {
    if (/^(AZURE_OPENAI_|EVIDENCE_)/.test(name) && ["string","number","boolean"].includes(typeof value)) process.env[name] = String(value);
  }
  process.env.LANGSMITH_TRACING = "false";
  configurationHash = hash(JSON.stringify(Object.entries(process.env).filter(([key]) =>
    /^(AZURE_OPENAI_|EVIDENCE_)/.test(key) && !/(?:API_KEY|SECRET|ACCESS_TOKEN|SPECIALIST_MODE)$/.test(key)).sort()));
  configuration = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:EVIDENCE_(?:PRIMARY|INDEPENDENT|RECONCILIATION)_(?:DEPLOYMENT_NAME|PROVIDER|REASONING|SERVICE_TIER)|AZURE_OPENAI_API_DEPLOYMENT_NAME|AZURE_OPENAI_VERBOSITY)$/.test(key)));
  const {default:appInsights} = await import("applicationinsights");
  appInsights.setup("InstrumentationKey=00000000-0000-0000-0000-000000000000");
  appInsights.defaultClient.config.disableAppInsights = true;
  Object.assign(appInsights.defaultClient, {
    trackEvent(event) { events.push(event); },
    trackException({exception,properties}) { events.push({name:"exception",properties:{...properties,errorType:exception.name}}); },
  });
}
const implementationRoot = new URL("../dist/src/processors/evidence/",import.meta.url);
const implementationFiles = (await readdir(implementationRoot)).filter(name=>name.endsWith(".js")).sort();
const implementationHash = hash(JSON.stringify(await Promise.all(implementationFiles.map(async name=>
  [name,hash(await readFile(new URL(name,implementationRoot)))]))));
const manifest = {fixtureHash:hash(raw),sourceHash:source.contentHash,skillsHash:await evidenceSkillsFingerprint(),
  implementationHash,runnerHash:hash(await readFile(new URL(import.meta.url))),
  dependencyHash:hash(await readFile(new URL("../bun.lock",import.meta.url))),configurationHash,
  live:values.live,configuration,plan,referenceProvenance:fixture.referenceProvenance ?? "unreviewed"};
await mkdir(output,{recursive:true,mode:0o700});
const readExisting = async path => {
  try { return JSON.parse(await readFile(path,"utf8")); } catch (error) { if(error.code === "ENOENT")return null; throw error; }
};
const existing = await readExisting(resolve(output,"manifest.json"));
if (existing) assert.deepEqual(existing,manifest,"Output belongs to a different fixture, skill version or configuration");
else await writeFile(resolve(output,"manifest.json"),JSON.stringify(manifest,null,2)+"\n",{flag:"wx",mode:0o600});
if (!values.live) {
  console.log(JSON.stringify({mode:"offline-validation",output,plan,modelCalls:0}));
  process.exit(0);
}

const {EvidenceExtractor} = await import("../dist/src/processors/evidence/evidenceExtractor.js");
const usageOf = selected => {
  const totals = {calls:0,inputTokens:0,outputTokens:0,reasoningTokens:0,cachedInputTokens:0,cacheWriteTokens:0};
  for (const event of selected.filter(event => event.name === "llm.call.token_usage")) {
    totals.calls++;
    for (const key of Object.keys(totals).filter(key => key !== "calls")) totals[key] += event.measurements?.[key] ?? 0;
  }
  return totals;
};
const results = [];
for (const [index,task] of fixture.tasks.entries()) {
  // Alternate order to reduce a consistent warm-cache/order advantage.
  for (const mode of index % 2 ? ["skills","off"] : ["off","skills"]) {
    const path = resolve(output,`${task.id}.${mode}.json`), saved = await readExisting(path);
    if (saved) {
      assert.equal(saved.fixtureHash,manifest.fixtureHash); assert.equal(saved.mode,mode); assert.equal(saved.task,task.id);
      results.push(saved); console.log(JSON.stringify({task:task.id,mode,reused:true})); continue;
    }
    process.env.EVIDENCE_SPECIALIST_MODE = mode;
    const extractor = new EvidenceExtractor("specialist-benchmark",fixture.source.sourceId);
    // Each comparison gets a fresh document context; the input candidates are immutable.
    const localSource = new EvidenceSource(document), started = Date.now();
    const before = JSON.stringify(task);
    events = [];
    const row = {task:task.id,kind:task.kind,mode,status:"completed",fixtureHash:manifest.fixtureHash};
    try {
      if (task.kind === "attribution") {
        const window = localSource.windows().find(w => w.pageNumber === task.pageNumber && w.startOffset === task.startOffset);
        // Exercise the same bounded implementation used by ingestion; no extraction or indexing.
        row.result = await extractor.resolveClaimAttributions(structuredClone(task.candidates),localSource,window,
          task.id,extractor.independentModel);
        assert.equal(row.result.length,task.candidates.length,"A candidate was lost");
        for (const candidate of task.candidates) assert(row.result.some(item => item.item.statement === candidate.item.statement),"Statement changed");
      } else {
        row.result = await extractor.canonicalizeDocuments(task.documents.map(item => new Document(structuredClone(item))),document);
        if (row.result.failedBatches) row.status = "failed";
      }
    } catch (error) { row.status="failed"; row.errorType=error.name; row.errorMessage=error.message; }
    assert.equal(JSON.stringify(task),before,"Fixture mutated during review");
    row.elapsedMs=Date.now()-started;
    row.usage=usageOf(events);
    row.events=events;
    await writeFile(path,JSON.stringify(row,null,2)+"\n",{flag:"wx",mode:0o600});
    results.push(row);
    console.log(JSON.stringify({task:task.id,mode,status:row.status,elapsedMs:row.elapsedMs,usage:row.usage}));
  }
}
const summary = {manifest,results:results.map(row => ({task:row.task,kind:row.kind,mode:row.mode,
  status:row.status,elapsedMs:row.elapsedMs,usage:row.usage,errorType:row.errorType,errorMessage:row.errorMessage})),byMode:{}};
for (const mode of ["off","skills"]) {
  const rows = results.filter(row => row.mode === mode);
  summary.byMode[mode] = {tasks:rows.length,failed:rows.filter(row=>row.status!=="completed").length,
    elapsedMs:rows.reduce((total,row)=>total+row.elapsedMs,0),usage:usageOf(rows.flatMap(row=>row.events))};
}
summary.caveats = ["Small saved-candidate replay; no extraction recall or large-document throughput measurement.",
  "Identical model configuration and task inputs across modes; ordering alternates but cache effects remain.",
  "No human labels are inferred from model agreement. Attribution and merge decisions require review.",
  "Reasoning tokens are included in output tokens. Skill-reference reads are included in model call usage.",
  "Failed task results are retained and reused; a retry requires a new explicitly selected output directory."];
await writeFile(resolve(output,"summary.json"),JSON.stringify(summary,null,2)+"\n",{mode:0o600});
console.log(JSON.stringify({output,byMode:summary.byMode}));
if(results.some(row=>row.status!=="completed"))process.exitCode=1;
