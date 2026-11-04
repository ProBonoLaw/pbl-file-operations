import { z } from "zod";
import { formatEvidenceDate } from "./evidenceContent.js";

// Share the same occurrence-link rule with extraction, general review and date recovery.
// Citation and calendar validation alone cannot establish this semantic relationship.
export const EVENT_DATE_LINK_INSTRUCTIONS = [
  "Assign an event date or uncertainty bounds only when source wording temporally links THIS occurrence to that date or interval. Topic, section proximity, and participation in the same overall matter do not establish a temporal link.",
  "For example, consent to an evaluation or notice of its purpose is not dated by a list of examination sessions; those actions could precede the sessions. Likewise, preparation for a hearing is not automatically dated by the hearing. Leave calendar dates unknown unless the source explicitly connects the action to the time.",
  "A source statement that an action occurred during one of specified sessions supports uncertainty bounds; a statement that it concerned those sessions does not. Both endpoints need temporal support. Do not convert a one-sided before/after relationship into a closed interval.",
].join("\n");

const parts = () => z.object({
  year: z.string(), month: z.string(), day: z.string(), season: z.string(), quarter: z.string(),
}).describe("Only source-supported date precision. Use empty strings for unknown parts.");

// This small native schema does not expose any evidence fields for rewriting.
export const EventDateDecisionSchema = z.object({
  candidateId: z.string(),
  status: z.enum(["dated", "unknown", "conflict"])
    .describe("unknown means calendar dates are unknown; source-supported relative timing or duration may still be supplied."),
  relation: z.enum(["point", "duration", "bounded", "approximate", "unknown"])
    .describe("bounded means an occurrence somewhere within uncertainty bounds, never continuous duration."),
  start: parts(), end: parts(),
  qualifier: z.string().describe("Source-supported uncertainty wording. Required for bounded or approximate dates."),
  explanation: z.string().min(1).describe("Explain the link to this occurrence, the scoped unsuccessful search, or substantive conflict."),
  supportingQuotes: z.array(z.object({ pageNumber: z.number().int().nonnegative(), quote: z.string().min(1) }))
    .describe("Exact source passages establishing the date AND its link to this occurrence. Required for dated results."),
}).strict();
export const EventDateResponseSchema = z.object({ decisions: z.array(EventDateDecisionSchema) });
export type EventDateDecision = z.infer<typeof EventDateDecisionSchema>;

export function eventDateMeaning(value: unknown): string {
  if (!value) return "";
  const { status, relation, start, end, qualifier } = EventDateDecisionSchema.parse(value);
  return JSON.stringify({ status, relation, start, end, qualifier });
}

export function validateEventDateDecision(value: unknown): EventDateDecision {
  const result = EventDateDecisionSchema.parse(value);
  for (const date of [result.start, result.end]) {
    for (const key of Object.keys(date) as (keyof typeof date)[]) {
      date[key] = /^(null|unknown|n\/a|not applicable)$/i.test(date[key].trim()) ? "" : date[key].trim();
    }
    if (date.season && !/^(spring|summer|fall|autumn|winter)$/i.test(date.season)) throw new Error("Invalid event season");
    if (date.quarter && !/^Q[1-4]$/i.test(date.quarter)) throw new Error("Invalid event quarter");
    formatEvidenceDate(date); // Calendar and numeric precision validation.
  }
  const start = formatEvidenceDate(result.start), end = formatEvidenceDate(result.end);
  if (result.status === "conflict") {
    if (start || end || result.relation !== "unknown" || result.qualifier) throw new Error("Conflicted result must leave dates, relation and qualifier unknown");
  } else if (result.status === "unknown") {
    if (start || end) throw new Error("Unknown calendar date must leave every start/end date part empty");
    if (!["unknown", "duration", "approximate"].includes(result.relation)) {
      throw new Error("Unknown calendar dates cannot assign a point date or uncertainty bounds");
    }
    if (result.relation !== "unknown" && !result.qualifier.trim()) {
      throw new Error("Relative duration or approximate timing requires its source wording in qualifier");
    }
    if (result.qualifier.trim() && !result.supportingQuotes.length) {
      throw new Error("Relative timing requires a supporting source quotation");
    }
  } else {
    if ((!start && !end) || result.relation === "unknown" || !result.supportingQuotes.length) {
      throw new Error("Recovered event date requires a date, relation, and supporting citations");
    }
    if (result.relation === "point" && (!start || end)) throw new Error("Point date requires only a start date");
    if (result.relation === "bounded" && (!start || !end)) throw new Error("Uncertainty bounds require both endpoints");
    if (["bounded", "approximate"].includes(result.relation) && !result.qualifier.trim()) {
      throw new Error("Uncertain event date requires its qualifier");
    }
    const comparable = (date: EventDateDecision["start"]) => date.year && date.month && date.day
      ? [Number(date.year), Number(date.month), Number(date.day)] : null;
    const a = comparable(result.start), b = comparable(result.end);
    if (a && b) {
      const index = a.findIndex((part, i) => part !== b[i]);
      if (index >= 0 && a[index] > b[index]) throw new Error("Event date endpoints are reversed");
    }
  }
  return result;
}
