import { createHash } from "node:crypto";
import { Document } from "@langchain/core/documents";
import { EVIDENCE_CONTENT_VERSION, formatEvidenceContent, formatEvidenceDate } from "./evidenceContent.js";
import { EvidenceSource, type SourceSpan } from "./evidenceSource.js";
import { needsClaimantReview } from "./evidenceAttribution.js";

export const EVIDENCE_CLASSIFICATION_RULE_VERSION = "2";

export interface ClassificationTrace {
  id: string;
  version: string;
  ruleId: string;
  action: "reclassified" | "polarity-corrected" | "flagged";
  reason: string;
  original: Record<string, unknown>;
  cue: SourceSpan & { section: string };
  attribution?: "existing-reporter" | "unknown";
}

const text = (value: unknown): string => typeof value === "string" ? value : "";
const normal = (value: unknown): string => text(value).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const unique = (values: string[]): string[] => [...new Set(values)];
const history = (value: unknown): ClassificationTrace[] => Array.isArray(value) ? value as ClassificationTrace[] : [];

/** Keep the audit for every contributing record through either deduplication pass. */
export function mergeClassificationHistory(left: Record<string, unknown>, right: Record<string, unknown>) {
  const entries = [...history(left.classificationHistory), ...history(right.classificationHistory)];
  return entries.length ? { classificationHistory: [...new Map(entries.map(entry => [JSON.stringify(entry), entry])).values()] } : {};
}

const hedge = /\b(?:suggest(?:s|ed|ing)?|suspect(?:s|ed)?)\b|\b(?:may|might|could)\s+(?:be|have|reflect|indicate|represent|result|demonstrate|benefit|develop)\b|\b(?:is|was|are|were|indicates?)\s+(?:an?\s+)?(?:possible|probable|likely)\b|\b(?:risk for|possibly|probably)\b/i;
const observation = /\b(?:appear(?:s|ed)?|seem(?:s|ed)?)\s+(?:(?:to be|very|quite|somewhat)\s+)?(?:tense|comfortable|anxious|relaxed|distressed|upset|happy|sad|tired|alert|confused|cooperative)\b/i;
const negativeObservation = /\b(?:did|does|do)\s+not\s+appear\s+(?:to be\s+)?(?:tense|anxious|distressed|upset|confused)\b/i;
const recommendation = /\b(?:recommend(?:s|ed|ation|ations)?|advises?|advised)\b/i;
// Do not treat the noun in "use of this report by the agency" as a reporting verb.
const reportPredicate = /\b(?:reported|stated|said|testified|alleged)\s+(?:that\s+)?\S|\b(?:reports|states|says|alleges)\s+that\b/i;
const interpretiveSection = /\b(?:impressions?|interpretation|conclusions?|clinical opinion)\b/i;
const interpretation = /\b(?:ability|abilities|skills?|performance|functioning|development)\s+(?:is|was|are|were)\s+(?:(?:reported|classified|described|judged|rated)\s+)?(?:(?:as|in|within)\s+)?(?:the\s+)?(?:high[- ]average|low[- ]average|average|superior|impaired|delayed|strong|weak)\b|\b(?:qualifies? for|meets? (?:the )?(?:diagnostic )?criteria)\b/i;
const numericResult = /\b(?:score(?:s|d)?|percentile|T-score|SS|measured|measurement|weight|height|temperature|amount|balance)\b[^.!?\n]{0,65}\d|\b\d+(?:st|nd|rd|th)\s+percentile\b/i;
const instrumentDefinition = /\b(?:test|scale|index|inventory|questionnaire|instrument|subtest|CBC|GARS-3|VMI|KCPT|VCI|FSIQ)\b.{0,100}\b(?:measures?|assesses?|contain(?:s|ing)?|includes?|comprises?|designed to|used to|has|have)\b/i;
const recordDescription = /\b(?:is titled|is named|titled|named|lists?|contains?|includes?)\b.{0,55}\b(?:book|resource|title|recommendation|diagnosis|diagnoses|address|code)\b|\b(?:listed|recorded|documented)\s+diagnos(?:is|es)\b|\b(?:program|book|resource)\b.{0,65}\b(?:is titled|is named|titled|named)\b/i;
const passiveReport = /\b(?:is|are|was|were|been)\s+reported\s+(?:as|to|with|without|by|that)\b/i;
const thirdParty = /\b(?:mother|father|parents?|caregiver|teacher|witness|patient)\s+(?:reports?|reported|states?|stated|says?|said)\b/i;
const denial = /\b(?:denies|denied)\b/i;
const cleanWords = (value: string): Set<string> => new Set((normal(value).match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter(word => !/^(?:the|a|an|is|was|are|were|of|to|in|and|or|as|at|for|with|his|her|its|that|this|report|reported)$/.test(word)));

interface Cue extends SourceSpan { section: string; table: boolean }

/** Index section boundaries once; a heading is context, never sufficient evidence by itself. */
class ClassificationSource {
  readonly source: EvidenceSource;
  private readonly headings = new Map<number, { offset: number; section: string }[]>();
  constructor(document: Document) {
    this.source = new EvidenceSource(document);
    const stack: { depth: number; title: string }[] = [];
    for (const page of this.source.pages) {
      const headings = [{ offset: 0, section: stack.map(h => h.title).join(" / ") }];
      for (const match of page.text.matchAll(/^ {0,3}(#{1,6})\s+(.+)$/gm)) {
        const depth = match[1].length;
        while (stack.length && stack.at(-1)!.depth >= depth) stack.pop();
        stack.push({ depth, title: match[2].replace(/\s+#+\s*$/, "").trim() });
        headings.push({offset:match.index, section:stack.map(h => h.title).join(" / ")});
      }
      this.headings.set(page.pageNumber, headings);
    }
  }

  valid(span: SourceSpan): boolean {
    return Number.isInteger(span.pageNumber) && Number.isInteger(span.sourceOffset) && span.sourceOffset >= 0
      && !!span.sourceQuote && this.source.pages.find(p => p.pageNumber === span.pageNumber)?.text
        .slice(span.sourceOffset, span.sourceOffset + span.sourceQuote.length) === span.sourceQuote;
  }

  cue(primary: SourceSpan, statement: string): Cue | null {
    const page = this.source.pages.find(p => p.pageNumber === primary.pageNumber)!;
    const end = primary.sourceOffset + primary.sourceQuote.length;
    const lineStart = page.text.lastIndexOf("\n", primary.sourceOffset - 1) + 1;
    const nextLine = page.text.indexOf("\n", end);
    const line = page.text.slice(lineStart, nextLine < 0 ? undefined : nextLine);
    const section = (offset: number) => this.headings.get(page.pageNumber)!.findLast(h => h.offset <= offset)!.section;
    if (/^\s*\|/.test(line) && !line.includes("\n")) {
      return {pageNumber:page.pageNumber, sourceOffset:lineStart, sourceQuote:line, section:section(lineStart), table:true};
    }
    // Expand a short primary fragment to its sentence; avoid borrowing cues from
    // another sentence in a long citation that was expanded for uniqueness.
    const previousBreak = page.text.lastIndexOf("\n\n", primary.sourceOffset);
    const nextBreak = page.text.indexOf("\n\n", end);
    const start = previousBreak < 0 ? 0 : previousBreak + 2;
    const stop = nextBreak < 0 ? page.text.length : nextBreak;
    if (stop - start > 6_000) return null;
    const words = cleanWords(statement);
    const candidates: { cue: Cue; score: number }[] = [];
    for (const match of page.text.slice(start, stop).matchAll(/[^]+?(?:[.!?](?=\s|$)|$)/g)) {
      const offset = start + match.index;
      if (!match[0].trim() || offset >= end || offset + match[0].length <= primary.sourceOffset) continue;
      const sourceWords = cleanWords(match[0]);
      const common = [...words].filter(word => sourceWords.has(word)).length;
      const score = common / Math.max(1, words.size);
      if (common < 3 || score < 0.45) continue;
      candidates.push({score, cue:{pageNumber:page.pageNumber, sourceOffset:offset, sourceQuote:match[0], section:section(offset), table:false}});
    }
    candidates.sort((a, b) => b.score - a.score);
    return !candidates.length || candidates.length > 1 && candidates[0].score - candidates[1].score < 0.15
      ? null : candidates[0].cue;
  }
}

interface Verdict { ruleId: string; reason: string; claimType?: "opinion" | "factualAssertion" | "denial"; polarity?: "asserts" | "uncertain" | "denies" }

function decide(statement: string, cue: Cue): Verdict | null {
  const source = cue.sourceQuote;
  // Table cells and recorded measurements can themselves contain labels such
  // as High Risk or Possible. They do not establish the underlying condition.
  if (cue.table) return hedge.test(statement) || recommendation.test(statement)
    ? {ruleId:"ambiguous-table-interpretation",reason:"Table anchor with interpretive wording; retain for review."} : null;
  if (instrumentDefinition.test(statement) || recordDescription.test(statement)) return null;
  if (numericResult.test(statement) && numericResult.test(source)) {
    return hedge.test(statement) || recommendation.test(statement)
      ? {ruleId:"mixed-measurement-interpretation",reason:"A measurement and interpretation may be combined; retain the complete item for review."} : null;
  }
  if (hedge.test(statement) && hedge.test(source)) return {ruleId:"source-hedged-interpretation",
    claimType:"opinion",polarity:"uncertain",reason:"The statement and its source sentence both express an uncertain interpretation."};
  if (observation.test(statement) && observation.test(source)) return {ruleId:"source-subjective-observation",
    claimType:"opinion",polarity:"asserts",reason:"An observer's impression remains an attributed opinion; negative wording alone is not a denial."};
  if (recommendation.test(statement) && recommendation.test(source)) return {ruleId:"source-recommendation",
    claimType:"opinion",polarity:"asserts",reason:"An explicit recommendation is supported by the source sentence."};
  if (interpretiveSection.test(cue.section) && interpretation.test(statement) && interpretation.test(source)
    && !numericResult.test(source)) return {ruleId:"section-supported-interpretation",
    claimType:"opinion",polarity:"asserts",reason:"An evaluative conclusion in an interpretation section is not a directly quoted numeric result."};
  if (denial.test(statement) && denial.test(source)) return {ruleId:"source-denial",claimType:"denial",polarity:"denies",
    reason:"Both statement and source explicitly describe a denial; retain the original wording."};
  if ((passiveReport.test(statement) || reportPredicate.test(statement)) && (passiveReport.test(source) || reportPredicate.test(source))
    && !/\b(?:score|percentile|scale|table|code)\b/i.test(statement)) return {ruleId:"source-reported-assertion",
    claimType:"factualAssertion",polarity:"asserts",reason:"The source and statement describe reported content rather than a recorded measurement."};
  if (hedge.test(statement) || observation.test(statement) || recommendation.test(statement) || passiveReport.test(statement)
    || interpretiveSection.test(cue.section) && interpretation.test(statement)) return {ruleId:"ambiguous-source-context",
    reason:"Potential claim wording lacks sufficiently specific matching source cues; retain for review."};
  return null;
}

function existingReporter(metadata: Record<string, unknown>, cue: Cue): string | null {
  const reporters = unique(strings(metadata.reportedBy).map(name => name.trim()).filter(name => !needsClaimantReview(name)));
  if (reporters.length !== 1) return null;
  const name = normal(reporters[0]);
  const spans = metadata.sourceSpans as SourceSpan[];
  // Reuse an already reviewed reporter only when their name is actually cited.
  // Never select a nearby author or infer a name from a relative role.
  const containsName = (quote: string) => {
    const normalized = normal(quote);
    return [...normalized.matchAll(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))]
      .some(match => !/[\p{L}\p{N}]/u.test(normalized[match.index - 1] ?? "")
        && !/[\p{L}\p{N}]/u.test(normalized[match.index + name.length] ?? ""));
  };
  if (!spans.some(span => containsName(span.sourceQuote))) return null;
  if (thirdParty.test(cue.sourceQuote) && !containsName(cue.sourceQuote)) return null;
  if ((passiveReport.test(cue.sourceQuote) || reportPredicate.test(cue.sourceQuote) || denial.test(cue.sourceQuote))
    && !containsName(cue.sourceQuote)) return null;
  return reporters[0];
}

/** Pure local guard: preserves every record and makes no model or network calls. */
export function classifyEvidenceDocuments(documents: readonly Document[], sourceDocument: Document) {
  const context = new ClassificationSource(sourceDocument);
  const changes: { index: number; trace: ClassificationTrace }[] = [];
  const flags: { index: number; trace: ClassificationTrace }[] = [];
  const classified = documents.map((document, index) => {
    const m = document.metadata;
    // Existing claims are never promoted to facts. Inspect only opinion claims
    // with observation wording for a narrowly defined polarity inconsistency.
    const reviewPolarity = m.claimType === "opinion" && ["denies", "uncertain"].includes(m.claimPolarity)
      && observation.test(text(m.what));
    if ((!m.factType || m.claimType) && !reviewPolarity
      || history(m.classificationHistory).some(entry => entry.version === EVIDENCE_CLASSIFICATION_RULE_VERSION)) return document;
    const primary = (m.sourceSpans as SourceSpan[] | undefined)?.[0];
    if (!primary || m.sourceContentHash !== context.source.contentHash || m.sourceOffset !== primary.sourceOffset
      || m.sourceQuote !== primary.sourceQuote || m.pages?.[0] !== primary.pageNumber
      || !(m.sourceSpans as SourceSpan[]).every(span => context.valid(span))) {
      throw new Error("Deterministic classification requires verified source identity and citations");
    }
    const statement = text(m.what);
    const cue = context.cue(primary, statement);
    let verdict: Verdict | null = cue ? decide(statement, cue) : hedge.test(statement) || observation.test(statement) || recommendation.test(statement) || passiveReport.test(statement)
      ? {ruleId:"ambiguous-source-context",reason:"The relevant source sentence cannot be selected unambiguously."} : null;
    if (reviewPolarity) {
      verdict = cue && negativeObservation.test(statement) && negativeObservation.test(cue.sourceQuote)
        && m.claimPolarity === "denies" && !denial.test(cue.sourceQuote) && !hedge.test(cue.sourceQuote) && !hedge.test(statement)
        ? {ruleId:"negative-observation-is-not-denial",claimType:"opinion",polarity:"asserts",
          reason:"The source asserts a negative observation without describing a denial."}
        : {ruleId:"observation-polarity-review",reason:"An observation has non-asserting polarity; preserve it for contextual review."};
    }
    if (verdict?.claimType && !reviewPolarity
      && (formatEvidenceDate(m.whenStarted) || formatEvidenceDate(m.whenEnded))) {
      verdict = {ruleId:"ambiguous-fact-date-fields",reason:"A fact already has claim/event date fields; retain it rather than overwrite their meaning."};
    }
    if (!verdict) return document;
    const original = Object.fromEntries(["what", "factType", "claimType", "claimant", "claimPolarity", "tags", "headers",
      "who", "subject", "reportedBy", "asOf", "whenStarted", "whenEnded"].filter(key => m[key] !== undefined).map(key => [key, structuredClone(m[key])]));
    const trace: ClassificationTrace = {id:createHash("sha256").update(JSON.stringify([
      EVIDENCE_CLASSIFICATION_RULE_VERSION, m.sourceContentHash, primary, original, verdict.ruleId])).digest("hex"),
    version:EVIDENCE_CLASSIFICATION_RULE_VERSION, ruleId:verdict.ruleId, action:verdict.claimType ? reviewPolarity ? "polarity-corrected" : "reclassified" : "flagged",
    reason:verdict.reason, original, cue:cue ?? {...primary,section:""}};
    const metadata: Record<string, unknown> = {...m, classificationHistory:[...history(m.classificationHistory),trace]};
    if (!verdict.claimType) {
      flags.push({index,trace});
      return new Document({pageContent:document.pageContent,metadata});
    }
    if (!reviewPolarity) {
      const reporter = existingReporter(m, cue!);
      trace.attribution = reporter ? "existing-reporter" : "unknown";
      // asOf is the date the content applies to, not the date of speaking.
      // Preserve it as the claim's referenced date and in the original audit.
      formatEvidenceDate(m.asOf);
      metadata.whenStarted = structuredClone(m.asOf ?? {year:null,month:null,day:null,season:null,quarter:null});
      metadata.whenEnded = null;
      metadata.claimant = reporter ?? "Unknown";
    }
    metadata.claimType = verdict.claimType;
    metadata.claimPolarity = verdict.polarity;
    metadata.tags = unique(strings(m.tags).filter(tag => !["fact", "event", "claim"].includes(tag)
      && !/^(?:factType|eventType|claimType|claimPolarity):/.test(tag)).concat("claim", `claimType:${verdict.claimType}`, `claimPolarity:${verdict.polarity}`));
    metadata.headers = [metadata.claimant, metadata.claimType, metadata.claimPolarity];
    delete metadata.factType;
    delete metadata.asOf;
    metadata.evidenceContentVersion = EVIDENCE_CONTENT_VERSION;
    changes.push({index,trace});
    return new Document({metadata,pageContent:formatEvidenceContent(metadata)});
  });
  return {documents:classified, changes, flags};
}
