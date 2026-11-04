import { createHash } from "node:crypto";
import { z } from "zod";
import type { SourceSpan } from "./evidenceSource.js";

const ROLES = ["actor", "speaker", "sender", "recipient", "payer", "payee", "observer",
  "affectedPerson", "provider", "patient", "subject", "applicant", "decisionMaker", "signatory", "witness"] as const;

// Fresh instances avoid nested schema references rejected by structured-output providers.
export const eventStructureField = () => z.object({
  trigger: z.string().describe("Short exact eventive phrase in sourceQuote, including eventive nouns. Empty if implicit or not uniquely identifiable; never invent a trigger."),
  roles: z.array(z.object({
    role: z.enum(ROLES),
    participant: z.number().int().nonnegative().describe("Zero-based index in this event's who array."),
    citations: z.array(z.number().int().nonnegative()).min(1)
      .describe("Indexes: 0 is sourceQuote; 1..N refer to supportingQuotes in order. Cite the role relationship and any identity link."),
  }).strict()).describe("Only source-supported participant roles. Omit unknown roles. Several people may share a role."),
}).strict();
export type EventStructure = z.infer<ReturnType<typeof eventStructureField>>;

const spanField = () => z.object({pageNumber: z.number().int().nonnegative(),
  sourceOffset: z.number().int().nonnegative(), sourceQuote: z.string().min(1)});
export const resolvedEventStructureField = () => z.object({
  version: z.literal(1), trigger: spanField().nullable(),
  triggerIssue: z.enum(["ambiguous", "unmatched"]).optional(),
  roles: z.array(z.object({role: z.enum(ROLES), participant: z.string().min(1), citationIds: z.array(z.string()).min(1)})),
});
export type ResolvedEventStructure = z.infer<ReturnType<typeof resolvedEventStructureField>>;

export const EVENT_STRUCTURE_INSTRUCTIONS = [
  "EVENT STRUCTURE: For every event provide eventStructure with a short exact trigger from sourceQuote and source-supported participant roles. The trigger may be a verb or a noun. Use trigger='' for an implicit occurrence or an ambiguous phrase; this must not suppress a supported event.",
  "Roles refer to who by zero-based participant index. Citation 0 means sourceQuote; citations 1..N mean supportingQuotes in order. Cite enough passages to establish both identity and role. A nearby name does not establish a role. Omit uncertain roles, retain the event and its known participants, and never infer motive or fault from a role.",
  "Separate speaker/sender from recipient, payer from payee, and observer from affected person. 'Morgan told Reed that Jordan fell' supports a communication with Morgan as speaker and Reed as recipient; Morgan is the claimant for the reported fall. Jordan is not a participant in that communication merely because its content mentions Jordan.",
  "Before leaving roles or trigger empty, inspect the primary and supporting passages for explicit actions, including passive verbs and eventive nouns. 'The parents consented to use of the report by the agency' supports parents as decisionMaker and 'consented' as trigger; it does not establish that the agency participated in the consent. 'The school sent the parents a notice' supports school as sender and parents as recipient. A list under 'Interventions Discussed' does not by itself name a speaker, recipient or agreement participant. Do not invent attendees, an agreement or an action from a plan item.",
  "If correcting eventStructure or changing an annotated event's who, sourceQuote or supportingQuotes, return a complete replacement event with consistent indexes. Do not use compact corrections for those fields. Preserve all supported dates, qualifiers and citations. No character offsets or mention IDs are requested; the application computes them.",
].join("\n");

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normal = (text: string) => text.normalize("NFKC").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
export const eventCitationId = (span: SourceSpan): string => "cite:" + hash([span.pageNumber, span.sourceOffset, span.sourceQuote]);

/** Indices address the original ordered quotations, before citation deduplication. */
export function resolveEventStructure(item: {who: string[]; eventStructure?: EventStructure},
  orderedSpans: readonly SourceSpan[]): ResolvedEventStructure | undefined {
  if (item.eventStructure === undefined) return undefined;
  const structure = eventStructureField().parse(item.eventStructure);
  const primary = orderedSpans[0];
  if (!primary) throw new Error("Event structure requires a valid primary citation");
  let trigger: SourceSpan | null = null;
  let triggerIssue: "ambiguous" | "unmatched" | undefined;
  const phrase = structure.trigger.trim();
  if (phrase) {
    const pattern = phrase.split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const matches = [...primary.sourceQuote.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, "gu"))];
    if (matches.length !== 1) triggerIssue = matches.length ? "ambiguous" : "unmatched";
    else trigger = {pageNumber: primary.pageNumber, sourceOffset: primary.sourceOffset + matches[0].index,
      sourceQuote: matches[0][0]};
  }
  const seen = new Set<string>();
  const roles = structure.roles.map(({role, participant, citations}) => {
    const person = item.who[participant]?.trim();
    if (!person || /^(unknown|null|n\/a|not applicable)$/i.test(person)) throw new Error("Event role has an invalid or unknown participant index");
    const key = JSON.stringify([role, normal(person)]);
    if (seen.has(key)) throw new Error("Event structure repeats a participant role");
    seen.add(key);
    if (new Set(citations).size !== citations.length || citations.some(index => !orderedSpans[index])) {
      throw new Error("Event role has duplicate or out-of-range citation indexes");
    }
    return {role, participant: person, citationIds: [...new Set(citations.map(index => eventCitationId(orderedSpans[index])))]};
  });
  return {version: 1, trigger, roles, ...(triggerIssue ? {triggerIssue} : {})};
}

/** Restore input citation ordering from the validated, possibly deduplicated spans. */
export function orderedEventCitations(item: {sourceQuote: string; supportingQuotes: {pageNumber: number; quote: string}[]},
  spans: readonly SourceSpan[]): SourceSpan[] {
  const quoteKey = (text: string) => text.replace(/\s+/g, " ").trim();
  const primary = spans[0];
  if (!primary || quoteKey(primary.sourceQuote) !== quoteKey(item.sourceQuote)) throw new Error("Missing event primary citation");
  return [primary, ...item.supportingQuotes.map(quote => {
    const found = spans.find(span => span.pageNumber === quote.pageNumber && quoteKey(span.sourceQuote) === quoteKey(quote.quote));
    if (!found) throw new Error("Missing event supporting citation");
    return found;
  })];
}

export function validateResolvedEventStructure(value: unknown, spans: readonly SourceSpan[]): ResolvedEventStructure {
  const structure = resolvedEventStructureField().parse(value);
  const available = new Set(spans.map(eventCitationId));
  const roles = new Set<string>();
  for (const role of structure.roles) {
    const key = JSON.stringify([role.role, normal(role.participant)]);
    if (roles.has(key) || new Set(role.citationIds).size !== role.citationIds.length) throw new Error("Event structure repeats a role or citation");
    roles.add(key);
    if (role.citationIds.some(id => !available.has(id))) throw new Error("Event role citation is missing from sourceSpans");
  }
  const trigger = structure.trigger;
  if (trigger && !spans.slice(0, 1).some(span => span.pageNumber === trigger.pageNumber && trigger.sourceOffset >= span.sourceOffset
    && span.sourceQuote.slice(trigger.sourceOffset - span.sourceOffset,
      trigger.sourceOffset - span.sourceOffset + trigger.sourceQuote.length) === trigger.sourceQuote)) {
    throw new Error("Event trigger is missing from sourceSpans");
  }
  return structure;
}

export function eventRoleSignature(structure: ResolvedEventStructure): string {
  return JSON.stringify(structure.roles.map(role => JSON.stringify([role.role, normal(role.participant)])).sort());
}

/** A generic subject can be refined by an explicit role for the same person.
 * Specific roles must still agree: payer/payee and other reversals are conflicts.
 */
type ParticipantAlias = (first: string, second: string) => boolean;
function compatibleRoles(first: ResolvedEventStructure, second: ResolvedEventStructure, alias?: ParticipantAlias, reviewContextRoles = false): boolean {
  const labels = [...first.roles, ...second.roles].map(role => role.participant);
  const matches = (a: string, b: string) => normal(a) === normal(b) || !!alias?.(a, b);
  const personKey = (person: string) => {
    const variants = labels.filter(label => matches(person, label));
    // A short label cannot bridge two different full names. Retain all labels
    // in the resulting roles; this key is used only to check compatibility.
    return variants.every(a => variants.every(b => matches(a, b)))
      ? variants.map(normal).sort()[0] : normal(person);
  };
  const byPerson = (structure: ResolvedEventStructure) => {
    const result = new Map<string, Set<string>>();
    for (const role of structure.roles) {
      const person = personKey(role.participant);
      const roles = result.get(person) ?? new Set<string>();
      roles.add(role.role);
      result.set(person, roles);
    }
    return result;
  };
  const left = byPerson(first), right = byPerson(second);
  if (left.size !== right.size) return false;
  return [...left].every(([person, roles]) => {
    const other = right.get(person);
    if (!other) return false;
    // Provider and observer may describe the same person's participation in
    // one event. This is a review lead, never a universal role equivalence.
    const comparedRoles = (values: Set<string>) => [...new Set([...values].filter(role => role !== "subject")
      .map(role => reviewContextRoles && (role === "provider" || role === "observer") ? "provider/observer" : role))];
    const specific = comparedRoles(roles);
    const otherSpecific = comparedRoles(other);
    return !specific.length || !otherSpecific.length
      || specific.length === otherSpecific.length && specific.every(role => otherSpecific.includes(role));
  });
}

/** Nested excerpts at the same occurrence are annotation boundaries, not events. */
function compatibleTriggers(first: SourceSpan | null, second: SourceSpan | null): boolean {
  if (!first || !second) return first === second;
  const contains = (outer: SourceSpan, inner: SourceSpan) => outer.pageNumber === inner.pageNumber
    && inner.sourceOffset >= outer.sourceOffset
    && outer.sourceQuote.slice(inner.sourceOffset - outer.sourceOffset,
      inner.sourceOffset - outer.sourceOffset + inner.sourceQuote.length) === inner.sourceQuote;
  return contains(first, second) || contains(second, first);
}

/** Unknown annotations never silently erase known roles; opposing directions stay separate. */
export function compatibleEventStructures(left: unknown, right: unknown, alias?: ParticipantAlias, reviewContextRoles = false): boolean {
  if (left === undefined || right === undefined) return left === right;
  const first = resolvedEventStructureField().safeParse(left), second = resolvedEventStructureField().safeParse(right);
  return first.success && second.success && !first.data.triggerIssue && !second.data.triggerIssue
    && compatibleRoles(first.data, second.data, alias, reviewContextRoles)
    && compatibleTriggers(first.data.trigger, second.data.trigger);
}

/** Only overlapping role annotations at one known occurrence can earn review.
 * Directional roles, missing/ambiguous triggers and different occurrences keep
 * their strict identity checks. Participant identities still require review.
 */
export function reviewableEventStructures(left: unknown, right: unknown): boolean {
  const first = resolvedEventStructureField().safeParse(left), second = resolvedEventStructureField().safeParse(right);
  if (!first.success || !second.success || first.data.triggerIssue || second.data.triggerIssue
    || !first.data.trigger || !second.data.trigger || !compatibleTriggers(first.data.trigger, second.data.trigger)) return false;
  const flexible = new Map([["patient", "patient/affectedPerson"], ["affectedPerson", "patient/affectedPerson"],
    ["provider", "provider/observer"], ["observer", "provider/observer"]]);
  const signature = (structure: ResolvedEventStructure) => JSON.stringify([...new Set(structure.roles.map(role =>
    flexible.get(role.role) ?? JSON.stringify([role.role, normal(role.participant)])))].sort());
  return signature(first.data) === signature(second.data);
}

export function mergeEventStructures(left: unknown, right: unknown, alias?: ParticipantAlias, reviewContextRoles = false,
  reviewedAnnotations = false): ResolvedEventStructure | undefined {
  if (!compatibleEventStructures(left, right, alias, reviewContextRoles)
    && !(reviewedAnnotations && reviewableEventStructures(left, right))) throw new Error("Cannot merge incompatible event roles or triggers");
  if (left === undefined) return undefined;
  const first = resolvedEventStructureField().parse(left), second = resolvedEventStructureField().parse(right);
  const roles = new Map<string, ResolvedEventStructure["roles"][number]>();
  for (const role of [...first.roles, ...second.roles]) {
    const key = JSON.stringify([role.role, normal(role.participant)]);
    const previous = roles.get(key);
    roles.set(key, {...previous ?? role, citationIds: [...new Set([...(previous?.citationIds ?? []), ...role.citationIds])]});
  }
  // The inner excerpt remains valid within either original primary quotation.
  const trigger = first.trigger && second.trigger && second.trigger.sourceQuote.length < first.trigger.sourceQuote.length
    ? second.trigger : first.trigger;
  return {...first, trigger, roles: [...roles.values()]};
}
