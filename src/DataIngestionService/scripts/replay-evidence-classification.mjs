import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Document } from "@langchain/core/documents";
import { classifyEvidenceDocuments, EVIDENCE_CLASSIFICATION_RULE_VERSION } from "../dist/src/processors/evidence/evidenceClassification.js";

// Offline only: no settings, extractor, telemetry client, or model is loaded.
const {values} = parseArgs({options:{input:{type:"string"},source:{type:"string"},output:{type:"string"}}});
assert.ok(values.input && values.source && values.output,"Provide --input RESULT.json --source DOCUMENT.md --output REPLAY.json");
const input = JSON.parse(await readFile(resolve(values.input),"utf8"));
const content = await readFile(resolve(values.source),"utf8");
const hash = createHash("sha256").update(content).digest("hex");
assert.equal(input.inputHash ?? input.sourceHash,hash,"The source must match the saved extraction");
assert.ok(Array.isArray(input.documents),"Input must contain documents");
const source = new Document({pageContent:content,metadata:{sourceId:input.sourceId,
  pages:content.split("<!-- PageBreak -->").map((_,index) => index + 1)}});
const documents = input.documents.map(document => new Document(document));
const count = docs => docs.reduce((counts,{metadata:m}) => {
  counts[m.claimType ? "claims" : m.factType ? "facts" : "events"]++;
  return counts;
},{events:0,facts:0,claims:0});
const start = performance.now();
const result = classifyEvidenceDocuments(documents,source);
assert.equal(result.documents.length,documents.length,"Classification must preserve every record");
const output = {mode:"offline-classification-only",ruleVersion:EVIDENCE_CLASSIFICATION_RULE_VERSION,
  sourceHash:hash,originalCount:documents.length,finalCount:result.documents.length,
  before:count(documents),after:count(result.documents),elapsedMs:performance.now()-start,
  usage:{calls:0,inputTokens:0,outputTokens:0},...result};
await mkdir(dirname(resolve(values.output)),{recursive:true,mode:0o700});
// Explicit output allowlist: never copy configuration/settings from the input.
await writeFile(resolve(values.output),JSON.stringify(output,null,2)+"\n",{flag:"wx",mode:0o600});
console.log(JSON.stringify({output:resolve(values.output),before:output.before,after:output.after,
  changed:result.changes.length,flagged:result.flags.length,elapsedMs:output.elapsedMs,usage:output.usage},null,2));
