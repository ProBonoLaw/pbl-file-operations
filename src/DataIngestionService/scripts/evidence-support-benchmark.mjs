import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Document } from "@langchain/core/documents";
import { z } from "zod";
import { eventCitationId, validateResolvedEventStructure } from "../src/processors/evidence/evidenceEventStructure.ts";

const kind = z.enum(["event", "fact", "claim"]);
const checkSchema = z.object({
  path: z.string().min(1),
  candidateSupport: z.enum(["supported", "refuted", "not-established"]),
  equals: z.unknown().optional(), oneOf: z.array(z.unknown()).min(1).optional(),
  contains: z.array(z.unknown()).min(1).optional(),
  pattern: z.string().optional(), notPattern: z.string().optional(),
}).strict().refine(value => ["equals", "oneOf", "contains", "pattern", "notPattern"]
  .filter(key => Object.hasOwn(value, key)).length === 1, "Each field check requires exactly one matcher");

const expectedSchema = z.object({kind, checks: z.array(checkSchema).min(1),
  roleEvidence: z.array(z.object({role: z.string(), participant: z.string(),
    evidenceSets: z.array(z.array(z.string()).min(1)).min(1)})).optional(),
  evidenceSets: z.array(z.array(z.string()).min(1)).min(1)});

const suiteSchema = z.object({
  version: z.literal(1), description: z.string(),
  cases: z.array(z.object({
    id: z.string().min(1), dimension: z.string(), pages: z.array(z.string().min(1)).min(1),
    targetPage: z.number().int().positive(),
    contextMode: z.enum(["oracle", "document"]).default("oracle"),
    evidence: z.array(z.object({id: z.string(), page: z.number().int().positive(), quote: z.string().min(1)})),
    candidates: z.array(z.object({kind, page: z.number().int().positive().optional(), item: z.record(z.unknown())})).min(1),
    expected: z.array(expectedSchema),
    expectedAlternatives: z.array(z.array(expectedSchema).min(1)).optional(),
    note: z.string().optional(),
  })).min(1),
});

/** Fail early on broken gold references, ambiguous quotes and duplicate case IDs. */
export function validateSupportSuite(value) {
  const suite = suiteSchema.parse(value);
  assert.equal(new Set(suite.cases.map(item => item.id)).size, suite.cases.length, "Duplicate case ID");
  for (const item of suite.cases) {
    assert.ok(item.pages[item.targetPage - 1], `Invalid target page: ${item.id}`);
    assert.ok(item.candidates.every(candidate => item.pages[(candidate.page ?? item.targetPage) - 1]), `Invalid candidate page: ${item.id}`);
    const ids = new Set(item.evidence.map(unit => unit.id));
    assert.equal(ids.size, item.evidence.length, `Duplicate evidence ID: ${item.id}`);
    for (const unit of item.evidence) {
      const page = item.pages[unit.page - 1];
      assert.ok(page?.includes(unit.quote), `Gold quote missing: ${item.id}/${unit.id}`);
      assert.equal(page.indexOf(unit.quote), page.lastIndexOf(unit.quote), `Ambiguous gold quote: ${item.id}/${unit.id}`);
    }
    for (const expected of [item.expected,...(item.expectedAlternatives ?? [])].flat()) {
      for (const set of expected.evidenceSets) for (const id of set) assert.ok(ids.has(id), `Unknown evidence ID: ${id}`);
      for (const role of expected.roleEvidence ?? []) for (const set of role.evidenceSets) {
        for (const id of set) assert.ok(ids.has(id), `Unknown role evidence ID: ${id}`);
      }
      for (const check of expected.checks) {
        if (check.pattern !== undefined) new RegExp(check.pattern, "iu");
        if (check.notPattern !== undefined) new RegExp(check.notPattern, "iu");
      }
    }
  }
  return suite;
}

const nullDates = (prefix, extended = false) => Object.fromEntries(
  (extended ? ["Year", "Month", "Day", "Season", "Quarter"] : ["Year", "Month", "Day"])
    .map(part => [prefix + part, null]));

/** Only source and candidates enter the production replay; gold never does. */
export function supportCaseInput(item) {
  const hash = text => createHash("sha256").update(text).digest("hex");
  // Descriptive case names can reveal the intended correction. Keep them out
  // of source metadata and candidate IDs visible to the model.
  const sourceId = "support-" + hash(JSON.stringify([item.pages, item.candidates])).slice(0, 16);
  const document = new Document({pageContent: item.pages.join("<!-- PageBreak -->"), metadata: {
    sourceId, title: "Synthetic source support benchmark", pages: item.pages.map((_, i) => i + 1),
  }});
  const candidates = item.candidates.map((candidate, index) => ({
    id: `${sourceId}:${index}`, kind: candidate.kind, extractedBy: ["benchmark:fixed-candidate"],
    item: {
      where: "Unknown", facets: [], supportingQuotes: [],
      ...(candidate.kind === "event" ? {
        ...nullDates("whenStarted", true), ...nullDates("whenEnded", true),
        what: "", who: [], why: "Unknown", eventType: "other",
      } : candidate.kind === "claim" ? {
        ...nullDates("whenStarted"), ...nullDates("whenEnded"),
        statement: "", claimant: "Unknown", claimType: "factualAssertion", polarity: "asserts", who: [],
      } : { ...nullDates("asOf"), what: "", subject: [], reportedBy: [], factType: "other" }),
      ...candidate.item,
    },
  }));
  return { document, store: {
    mode: "replay",
    async get(window) {
      return {version: 1, sourceContentHash: hash(document.pageContent), pageNumber: window.pageNumber,
        startOffset: window.startOffset, textHash: hash(window.text),
        candidates: window.startOffset === 0 ? candidates.filter((_, index) =>
          (item.candidates[index].page ?? item.targetPage) === window.pageNumber) : []};
    },
    async put() { throw new Error("Benchmark replay must not capture candidates"); },
  }};
}

const spanSchema = z.object({pageNumber: z.number().int().positive(), sourceOffset: z.number().int().nonnegative(),
  sourceQuote: z.string().min(1)});
const predictionSchema = z.object({
  caseId: z.string(),
  documents: z.array(z.object({metadata: z.object({what: z.string().min(1), tags: z.array(z.string()),
    sourceSpans: z.array(spanSchema).min(1)}).passthrough()}).passthrough()),
  availableEvidenceIds: z.array(z.string()).nullable(),
  failure: z.enum(["schema", "invocation", "loop", "pipeline"]).optional(),
}).passthrough();

function fieldMatches(metadata, check) {
  const actual = check.path.split(".").reduce((value, key) => value?.[key], metadata);
  if (Object.hasOwn(check, "equals")) return isDeepStrictEqual(actual, check.equals);
  if (check.oneOf) return check.oneOf.some(value => isDeepStrictEqual(actual, value));
  if (check.contains) return Array.isArray(actual) && check.contains.every(expected => actual.some(value => {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      return value && typeof value === "object" && Object.entries(expected).every(([key, entry]) => isDeepStrictEqual(value[key], entry));
    }
    return isDeepStrictEqual(value, expected);
  }));
  if (typeof actual !== "string") return false;
  return check.pattern !== undefined ? new RegExp(check.pattern, "iu").test(actual)
    : !new RegExp(check.notPattern, "iu").test(actual);
}

function documentKind(metadata) {
  return metadata.tags.includes("event") ? "event" : metadata.tags.includes("claim") ? "claim"
    : metadata.tags.includes("fact") ? "fact" : null;
}

function citedEvidence(item, metadata) {
  return item.evidence.filter(unit => {
    const start = item.pages[unit.page - 1].indexOf(unit.quote);
    return metadata.sourceSpans.some(span => span.pageNumber === unit.page && span.sourceOffset <= start
      && span.sourceOffset + span.sourceQuote.length >= start + unit.quote.length);
  }).map(unit => unit.id);
}

const completeSet = (sets, ids) => ids === null ? null : sets.some(set => set.every(id => ids.includes(id)));

// A single output cannot satisfy multiple expected records (e.g. opposing claims).
function hasAssignment(matches, used = new Set(), index = 0) {
  if (index === matches.length) return true;
  return matches[index].some(output => !used.has(output)
    && hasAssignment(matches, new Set([...used, output]), index + 1));
}

export function gradeSupportCase(item, rawPrediction) {
  if (item.expectedAlternatives?.length) {
    const {expectedAlternatives,...base} = item;
    const variants = [item.expected,...expectedAlternatives].map(expected =>
      gradeSupportCase({...base,expected},rawPrediction));
    return variants.find(result => result.passed) ?? variants[0];
  }
  const result = {caseId: item.id, dimension: item.dimension, passed: false, category: "missing-prediction"};
  if (rawPrediction === undefined) return result;
  const parsed = predictionSchema.safeParse(rawPrediction);
  if (!parsed.success || parsed.data.caseId !== item.id) return {...result, category: "schema"};
  const prediction = parsed.data;
  if (prediction.failure) return {...result, category: prediction.failure};
  const knownIds = new Set(item.evidence.map(unit => unit.id));
  if (prediction.availableEvidenceIds?.some(id => !knownIds.has(id))) return {...result, category: "schema"};
  const documents = prediction.documents;
  try {
    for (const {metadata} of documents) if (metadata.eventStructure) validateResolvedEventStructure(metadata.eventStructure, metadata.sourceSpans);
  } catch { return {...result, category: "citation"}; }
  const mentions = new Map(documents.filter(document => document.metadata.eventMentionId)
    .map(document => [document.metadata.eventMentionId, document.metadata]));
  if (documents.some(({metadata}) => metadata.possibleRelatedEventMentionIds !== undefined
    && (!Array.isArray(metadata.possibleRelatedEventMentionIds)
      || metadata.possibleRelatedEventMentionIds.some(id => id === metadata.eventMentionId || !mentions.has(id)
        || !mentions.get(id).possibleRelatedEventMentionIds?.includes(metadata.eventMentionId))))) {
    return {...result, category: "schema"};
  }
  const validQuotes = documents.every(({metadata}) => metadata.sourceSpans.every(span =>
    item.pages[span.pageNumber - 1]?.slice(span.sourceOffset, span.sourceOffset + span.sourceQuote.length) === span.sourceQuote));
  const rows = item.expected.map(expected => {
    const semanticMatches = documents.flatMap(({metadata}, index) => documentKind(metadata) === expected.kind
      && expected.checks.every(check => fieldMatches(metadata, check)) ? [index] : []);
    const evidenceMatches = semanticMatches.filter(index => {
      const metadata = documents[index].metadata;
      return completeSet(expected.evidenceSets, citedEvidence(item, metadata))
        && (expected.roleEvidence ?? []).every(expectedRole => metadata.eventStructure?.roles.some(role =>
          role.role === expectedRole.role && role.participant === expectedRole.participant
          && completeSet(expectedRole.evidenceSets, citedEvidence(item, {sourceSpans: metadata.sourceSpans
            .filter(span => role.citationIds.includes(eventCitationId(span)))}))));
    });
    return {semanticMatches, evidenceMatches,
      evidenceAvailable: completeSet(expected.evidenceSets, prediction.availableEvidenceIds),
      fields: expected.checks.map(check => ({path: check.path, candidateSupport: check.candidateSupport,
        matched: documents.some(({metadata}) => documentKind(metadata) === expected.kind && fieldMatches(metadata, check))}))};
  });
  const semanticPass = documents.length === item.expected.length && hasAssignment(rows.map(row => row.semanticMatches));
  const evidencePass = validQuotes && hasAssignment(rows.map(row => row.evidenceMatches));
  const passed = semanticPass && evidencePass;
  // Retrieval is a diagnostic limitation, not a proven causal explanation.
  const category = passed ? "none" : !validQuotes ? "citation"
    : semanticPass ? "evidence-selection"
      : rows.some(row => row.evidenceAvailable === false) ? "retrieval-limited"
        : rows.some(row => row.evidenceAvailable === null) ? "unclassified-context"
          : "semantic";
  return {...result, passed, category, semanticPass, evidencePass, fields: rows,
    outputCount: documents.length, expectedCount: item.expected.length};
}

export function gradeSupportSuite(suite, predictions) {
  assert.ok(Array.isArray(predictions), "Predictions must be an array");
  const known = new Set(suite.cases.map(item => item.id));
  const seen = new Set();
  for (const prediction of predictions) {
    assert.ok(known.has(prediction?.caseId), "Prediction has an unknown or missing case ID");
    assert.ok(!seen.has(prediction.caseId), "Duplicate prediction case ID");
    seen.add(prediction.caseId);
  }
  const cases = suite.cases.map(item => gradeSupportCase(item, predictions.find(row => row.caseId === item.id)));
  return {total: cases.length, passed: cases.filter(item => item.passed).length,
    dimensions: Object.fromEntries([...new Set(cases.map(item => item.dimension))].map(dimension => [dimension, {
      total: cases.filter(item => item.dimension === dimension).length,
      passed: cases.filter(item => item.dimension === dimension && item.passed).length,
    }])),
    failures: Object.fromEntries([...new Set(cases.filter(item => !item.passed).map(item => item.category))]
      .map(category => [category, cases.filter(item => item.category === category).length])), cases};
}

/** Sum call usage only; request aggregates and reasoning subsets must not be double counted. */
export function summarizeSupportRun(predictions) {
  const calls = predictions.flatMap(prediction => prediction.events ?? []).filter(event => event.name === "llm.call.token_usage");
  const total = (events, field) => events.some(event => typeof event.measurements?.[field] === "number")
    ? events.reduce((sum, event) => sum + (typeof event.measurements?.[field] === "number" ? event.measurements[field] : 0), 0) : null;
  const usage = events => ({calls: events.length, inputTokens: total(events, "inputTokens"),
    outputTokens: total(events, "outputTokens"), reasoningTokens: total(events, "reasoningTokens"),
    cachedInputTokens: total(events, "cachedInputTokens"),
    callsReportingCachedInput: events.filter(event => typeof event.measurements?.cachedInputTokens === "number").length});
  const keys = [...new Set(calls.map(event => JSON.stringify([event.properties?.model, event.properties?.stage])))];
  return {...usage(calls), caseElapsedMs: predictions.every(prediction => typeof prediction.elapsedMs === "number")
    ? predictions.reduce((sum, prediction) => sum + prediction.elapsedMs, 0) : null,
    byModelAndStage: keys.map(key => ({model: JSON.parse(key)[0], stage: JSON.parse(key)[1],
      ...usage(calls.filter(event => JSON.stringify([event.properties?.model, event.properties?.stage]) === key))})),
    scope: "Reported call usage only; reasoning is included in output tokens. Missing telemetry is unknown, not zero cost."};
}
