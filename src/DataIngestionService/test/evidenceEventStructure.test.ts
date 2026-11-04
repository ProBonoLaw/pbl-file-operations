import { Document } from "@langchain/core/documents";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { compatibleEventStructures, eventCitationId, eventStructureField, mergeEventStructures,
  orderedEventCitations, resolveEventStructure, validateResolvedEventStructure } from "../src/processors/evidence/evidenceEventStructure.ts";
import { linkEventMentions } from "../src/processors/evidence/evidenceEventMentions.ts";
import { formatEvidenceContent } from "../src/processors/evidence/evidenceContent.ts";
import { applyEvidenceCorrections } from "../src/processors/evidence/evidenceReconciliation.ts";
import { deduplicateEvidenceDocuments } from "../src/processors/evidence/evidenceDeduplication.ts";
import { findCanonicalizationPairs, applyCanonicalizationDecisions } from "../src/processors/evidence/evidenceCanonicalization.ts";

const quote = "On 4 March 2025, Jordan paid Casey 500 dollars.";
const span = {pageNumber: 1, sourceOffset: 12, sourceQuote: quote};
const item = () => ({who: ["Jordan", "Casey"], sourceQuote: quote, supportingQuotes: [], eventStructure: {
  trigger: "paid", roles: [{role: "payer" as const, participant: 0, citations: [0]},
    {role: "payee" as const, participant: 1, citations: [0]}],
}});
function document(page = 1, overrides: Record<string, unknown> = {}): Document {
  const primary = {...span, pageNumber: page};
  const metadata = {what: "Jordan paid Casey 500 dollars.", who: item().who,
    whenStarted: {year: "2025", month: "3", day: "4"}, whenEnded: null, where: "Unknown", why: "Unknown",
    tags: ["event", "eventType:payment"], sourceContentHash: "document-hash", sourceId: "document-1",
    evidenceSchemaVersion: "3", pages: [page], sourceOffset: primary.sourceOffset, sourceQuote: quote,
    sourceSpans: [primary], extractedBy: ["synthetic"], eventStructure: resolveEventStructure(item(), [primary]), ...overrides};
  return new Document({metadata, pageContent: formatEvidenceContent(metadata)});
}

describe("compact event structure", () => {
  it("resolves a source trigger and role citations locally without model-generated offsets", () => {
    const result = resolveEventStructure(item(), [span])!;
    expect(result.trigger).toEqual({...span, sourceOffset: span.sourceOffset + quote.indexOf("paid"), sourceQuote: "paid"});
    expect(result.roles).toEqual([
      {role: "payer", participant: "Jordan", citationIds: [eventCitationId(span)]},
      {role: "payee", participant: "Casey", citationIds: [eventCitationId(span)]},
    ]);
    expect(document().pageContent).toContain("Payer: Jordan\nPayee: Casey");
    expect(document().pageContent).not.toContain("cite:");
  });

  it("allows implicit events and unknown roles without inventing structure", () => {
    expect(resolveEventStructure({who: [], eventStructure: {trigger: "", roles: []}}, [span]))
      .toEqual({version: 1, trigger: null, roles: []});
    expect(resolveEventStructure({who: []}, [span])).toBeUndefined();
  });

  it("clears ungrounded trigger annotations while rejecting invalid roles and broken indexes", () => {
    const original = item();
    expect(resolveEventStructure({...original, eventStructure: {...original.eventStructure, trigger: "pay"}}, [span]))
      .toMatchObject({trigger: null, triggerIssue: "unmatched"});
    expect(resolveEventStructure(original, [{...span, sourceQuote: quote + " " + quote}]))
      .toMatchObject({trigger: null, triggerIssue: "ambiguous"});
    expect(resolveEventStructure(original, [{...span, sourceQuote: "The invoice was unpaid."}]))
      .toMatchObject({trigger: null, triggerIssue: "unmatched"});
    for (const roles of [
      [{role: "payer" as const, participant: 2, citations: [0]}],
      [{role: "payer" as const, participant: 0, citations: [1]}],
      [{role: "payer" as const, participant: 0, citations: [0, 0]}],
      [original.eventStructure.roles[0], original.eventStructure.roles[0]],
    ]) expect(() => resolveEventStructure({...original, eventStructure: {trigger: "paid", roles}}, [span])).toThrow();
    expect(() => resolveEventStructure({...original, who: ["Unknown", "Casey"]}, [span])).toThrow("participant");
    expect(eventStructureField().safeParse({trigger: "paid", roles: [{role: "guiltyParty", participant: 0, citations: [0]}]}).success).toBe(false);
    const unresolved = resolveEventStructure({...original, eventStructure: {...original.eventStructure, trigger: "unknown"}}, [span]);
    expect(compatibleEventStructures(unresolved, unresolved)).toBe(false);
  });

  it("preserves citation indexing when duplicate quotations are collapsed", () => {
    const supporting = {pageNumber: 8, sourceOffset: 5, sourceQuote: "Payer J-1 is Jordan."};
    const original = {...item(), supportingQuotes: [{pageNumber: 1, quote}, {pageNumber: 8, quote: supporting.sourceQuote}],
      eventStructure: {trigger: "paid", roles: [{role: "payer" as const, participant: 0, citations: [0, 2]}]}};
    const ordered = orderedEventCitations(original, [span, supporting]);
    expect(ordered).toEqual([span, span, supporting]);
    const resolved = resolveEventStructure(original, ordered)!;
    expect(resolved.roles[0].citationIds).toEqual([eventCitationId(span), eventCitationId(supporting)]);
    expect(validateResolvedEventStructure(resolved, [span, supporting])).toEqual(resolved);
    expect(() => validateResolvedEventStructure(resolved, [span])).toThrow("citation");
  });

  it("requires full replacement when a compact correction would change index meanings", () => {
    const schema = z.object({who: z.array(z.string()), sourceQuote: z.string(),
      supportingQuotes: z.array(z.object({pageNumber: z.number(), quote: z.string()})), eventStructure: eventStructureField()});
    const correction = {field: "who" as const, text: null, people: ["Casey", "Jordan"], facets: [], supportingQuotes: []};
    expect(() => applyEvidenceCorrections(item(), [correction], schema)).toThrow("complete replacement");
  });

  it("does not confuse case-distinct source passages while restoring citation order", () => {
    const upper = {pageNumber: 2, sourceOffset: 0, sourceQuote: "Sender: JORDAN"};
    const lower = {pageNumber: 2, sourceOffset: 40, sourceQuote: "Sender: Jordan"};
    expect(orderedEventCitations({...item(), supportingQuotes: [{pageNumber: 2, quote: lower.sourceQuote}]},
      [span, upper, lower])).toEqual([span, lower]);
  });
});

describe("roles in duplicate review", () => {
  it.each([false, true])("preserves the event trigger when reviewed fact wording survives (promote citation: %s)", promote => {
    const factQuote = promote ? "Casey 500 dollars." : "Jordan paid Casey 500 dollars.";
    const factSpan = {...span, sourceQuote: factQuote, sourceOffset: span.sourceOffset + quote.indexOf(factQuote)};
    const event = document(1, {what: "Jordan paid 500 dollars."});
    const fact = document(1, {tags: ["fact", "factType:attribute"], factType: "attribute",
      subject: item().who, reportedBy: [], whenStarted: null, eventStructure: undefined,
      sourceQuote: factQuote, sourceOffset: factSpan.sourceOffset, sourceSpans: [factSpan]});
    for (const documents of [[event, fact], [fact, event]]) {
      const before = JSON.stringify(documents);
      const pairs = findCanonicalizationPairs(documents);
      expect(pairs).toHaveLength(1);
      const survivor = documents[pairs[0].leftIndex] === fact ? "left" : "right";
      expect(pairs[0].allowedSurvivors).toContain(survivor);
      const merged = applyCanonicalizationDecisions(documents, pairs, [{pairId: pairs[0].id,
        survivor, leftOnlyDetails: [], rightOnlyDetails: [], reason: "Same payment; preserve the named recipient."}]);
      expect(merged.documents).toHaveLength(1);
      const metadata = merged.documents[0].metadata;
      const primary = promote ? span : factSpan;
      expect(metadata.what).toBe(fact.metadata.what);
      expect(metadata.tags).toEqual(expect.arrayContaining(["event", "fact"]));
      expect(metadata.sourceSpans[0]).toEqual(primary);
      expect(metadata.sourceQuote).toBe(primary.sourceQuote);
      expect(metadata.sourceOffset).toBe(primary.sourceOffset);
      expect(metadata.sourceSpans).toHaveLength(2);
      expect(metadata.sourceSpans).toEqual(expect.arrayContaining([span, factSpan]));
      expect(validateResolvedEventStructure(metadata.eventStructure, metadata.sourceSpans)).toEqual(event.metadata.eventStructure);
      expect(merged.documents[0].pageContent).toBe(formatEvidenceContent(metadata));
      expect(JSON.stringify(documents)).toBe(before);
    }
  });

  it("does not relocate a trigger to another occurrence of the same text during a merge", () => {
    const event = document();
    const fact = document(1, {tags: ["fact", "factType:attribute"], factType: "attribute",
      eventStructure: undefined, whenStarted: null});
    event.metadata.eventStructure.trigger.sourceOffset += quote.length;
    expect(findCanonicalizationPairs([event, fact])).toEqual([]);
  });

  it("merges the same event with a refined subject role and nested trigger excerpts", () => {
    const primary = {...span, sourceQuote: "Treatment date: March 4, 2025."};
    const make = (trigger: string, role: "subject" | "patient") => document(1, {
      what: "Jordan received treatment.", who: ["Jordan"], sourceQuote: primary.sourceQuote,
      sourceSpans: [primary], eventStructure: resolveEventStructure({who: ["Jordan"], eventStructure: {
        trigger, roles: [{role, participant: 0, citations: [0]}],
      }}, [primary]),
    });
    const generic = make("Treatment date", "subject"), specific = make("Treatment", "patient");
    for (const documents of [[generic, specific], [specific, generic]]) {
      const merged = deduplicateEvidenceDocuments(documents);
      expect(merged).toHaveLength(1);
      const structure = validateResolvedEventStructure(merged[0].metadata.eventStructure, [primary]);
      expect(structure.trigger?.sourceQuote).toBe("Treatment");
      expect(structure.roles.map(role => role.role).sort()).toEqual(["patient", "subject"]);
      expect(structure.roles.every(role => role.citationIds.includes(eventCitationId(primary)))).toBe(true);
    }
    const conflicting = structuredClone(specific);
    conflicting.metadata.eventStructure.roles[0].role = "provider";
    expect(deduplicateEvidenceDocuments([specific, conflicting])).toHaveLength(2);
    expect(findCanonicalizationPairs([specific, conflicting])).toHaveLength(0);
  });

  it("reviews cross-kind assertions from the same citation even with little shared wording", () => {
    const primary = {...span, sourceQuote: "Treatment date: May 15, 2025."};
    const event = document(1, {what: "Jordan received treatment.", who: ["Jordan"],
      whenStarted: {year: "2025", month: "5", day: "15"},
      sourceQuote: primary.sourceQuote, sourceSpans: [primary], eventStructure: undefined});
    const fact = document(1, {what: "The treatment date recorded for this patient is May 15, 2025.",
      who: ["Jordan"], subject: ["Jordan"], reportedBy: [], factType: "attribute",
      tags: ["fact", "factType:attribute"], sourceQuote: primary.sourceQuote, sourceSpans: [primary],
      whenStarted: null, eventStructure: undefined});
    const pairs = findCanonicalizationPairs([event, fact]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].similarity).toBeLessThan(0.4);
    expect(pairs[0].allowedSurvivors).toEqual(["right"]);
    const merged = applyCanonicalizationDecisions([event, fact], pairs, [{pairId: pairs[0].id,
      survivor: "right", leftOnlyDetails: [], rightOnlyDetails: [], reason: "Same cited treatment occurrence and date."}]);
    expect(merged.documents).toHaveLength(1);
    expect(merged.documents[0].metadata.what).toBe(fact.metadata.what);
    expect(merged.documents[0].metadata.factType).toBeUndefined();
    expect(merged.documents[0].metadata.tags).toEqual(expect.arrayContaining(["event", "fact"]));
    expect(applyCanonicalizationDecisions([event, fact], pairs, []).documents).toHaveLength(2);
  });

  it("blocks role reversals in strict deduplication and canonicalization", () => {
    const first = document();
    const reversed = item();
    reversed.eventStructure.roles[0].participant = 1;
    reversed.eventStructure.roles[1].participant = 0;
    const second = document(1, {eventStructure: resolveEventStructure(reversed, [span])});
    expect(compatibleEventStructures(first.metadata.eventStructure, second.metadata.eventStructure)).toBe(false);
    expect(deduplicateEvidenceDocuments([first, second])).toHaveLength(2);
    expect(findCanonicalizationPairs([first, second])).toHaveLength(0);
    expect(() => mergeEventStructures(first.metadata.eventStructure, second.metadata.eventStructure)).toThrow("incompatible");
    const legacy = document(1, {eventStructure: undefined});
    expect(deduplicateEvidenceDocuments([first, legacy])).toHaveLength(2);
    expect(findCanonicalizationPairs([first, legacy])).toHaveLength(0);
  });

  it("retains every role citation when merging compatible annotated records", () => {
    const first = document();
    const support = {pageNumber: 2, sourceOffset: 0, sourceQuote: "Jordan was the payer."};
    const enriched = structuredClone(first.metadata.eventStructure);
    enriched.roles[0].citationIds.push(eventCitationId(support));
    const second = document(1, {eventStructure: enriched, sourceSpans: [span, support], pages: [1, 2]});
    const strict = deduplicateEvidenceDocuments([first, second]);
    expect(strict).toHaveLength(1);
    expect(strict[0].metadata.eventStructure.roles[0].citationIds).toContain(eventCitationId(support));
    second.metadata.what = "Jordan paid Casey 500 dollars on 4 March 2025.";
    const pairs = findCanonicalizationPairs([first, second]);
    expect(pairs).toHaveLength(1);
    const reviewed = applyCanonicalizationDecisions([first, second], pairs,
      [{pairId: pairs[0].id, survivor: "right", leftOnlyDetails: [], rightOnlyDetails: [], reason: "Same cited payment with preserved roles."}]);
    expect(reviewed.documents).toHaveLength(1);
    expect(reviewed.documents[0].metadata.eventStructure.roles[0].citationIds).toContain(eventCitationId(support));
  });

  it("keeps different trigger occurrences even within the same quotation", () => {
    const sourceQuote = "Jordan paid Casey and later refunded Casey.";
    const primary = {...span, sourceQuote};
    const first = document(1, {sourceQuote, sourceSpans: [primary],
      eventStructure: resolveEventStructure(item(), [primary])});
    const second = document(1, {sourceQuote, sourceSpans: [primary],
      eventStructure: resolveEventStructure({...item(), eventStructure: {...item().eventStructure, trigger: "refunded"}}, [primary])});
    expect(deduplicateEvidenceDocuments([first, second])).toHaveLength(2);
    expect(findCanonicalizationPairs([first, second])).toHaveLength(0);
  });
});

describe("document-local event mention leads", () => {
  it("links matching mentions across distant pages while preserving both records and citations", () => {
    const documents = [document(1), document(100)];
    const original = JSON.stringify(documents);
    const linked = linkEventMentions(documents);
    expect(linked.pairCount).toBe(1);
    expect(linked.documents).toHaveLength(2);
    expect(linked.documents[0].metadata.possibleRelatedEventMentionIds).toEqual([linked.documents[1].metadata.eventMentionId]);
    expect(linked.documents[1].metadata.possibleRelatedEventMentionIds).toEqual([linked.documents[0].metadata.eventMentionId]);
    expect(findCanonicalizationPairs(linked.documents)).toHaveLength(0);
    expect(JSON.stringify(documents)).toBe(original);
    expect(linkEventMentions(documents)).toEqual(linked);
  });

  it("keeps recurring dates, role reversals, unknown roles and other sources apart", () => {
    const first = document();
    const reverse = item();
    reverse.eventStructure.roles[0].participant = 1;
    reverse.eventStructure.roles[1].participant = 0;
    const variants = [
      document(2, {whenStarted: {year: "2025", month: "3", day: "5"}}),
      document(2, {sourceContentHash: "different-source"}),
      document(2, {eventStructure: resolveEventStructure(reverse, [{...span, pageNumber: 2}])}),
      document(2, {eventStructure: resolveEventStructure({who: [], eventStructure: {trigger: "paid", roles: []}}, [{...span, pageNumber: 2}])}),
    ];
    for (const second of variants) expect(linkEventMentions([first, second]).pairCount).toBe(0);
  });

  it("bounds link fan-out in long documents and never drops an event", () => {
    const documents = Array.from({length: 120}, (_, i) => document(i + 1));
    const linked = linkEventMentions(documents);
    expect(linked.documents).toHaveLength(120);
    expect(linked.pairCount).toBeLessThanOrEqual(120 * 8 / 2);
    expect(linked.documents.every(document => document.metadata.possibleRelatedEventMentionIds.length <= 8)).toBe(true);
  });
});
