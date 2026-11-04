import { z } from "zod";
import { resolvedEventStructureField, validateResolvedEventStructure } from "./evidenceEventStructure.js";

export const EVIDENCE_CONTENT_VERSION = "3";

const dateSchema = z.object({
  year: z.string().nullable().optional(),
  month: z.string().nullable().optional(),
  day: z.string().nullable().optional(),
  season: z.string().nullable().optional(),
  quarter: z.string().nullable().optional(),
});

const contentMetadataSchema = z.object({
  what: z.string().min(1),
  tags: z.array(z.string()),
  who: z.array(z.string()).optional(),
  subject: z.array(z.string()).optional(),
  reportedBy: z.array(z.string()).optional(),
  claimant: z.string().optional(),
  claimType: z.string().optional(),
  claimPolarity: z.enum(["asserts", "denies", "uncertain"]).optional(),
  factType: z.string().optional(),
  eventStructure: resolvedEventStructureField().optional(),
  where: z.string().optional(),
  why: z.string().optional(),
  whenStarted: dateSchema.nullable().optional(),
  whenEnded: dateSchema.nullable().optional(),
  asOf: dateSchema.nullable().optional(),
  eventDateResolution: z.object({
    status: z.enum(["dated", "unknown", "conflict"]),
    relation: z.enum(["point", "duration", "bounded", "approximate", "unknown"]),
    start: dateSchema, end: dateSchema, qualifier: z.string(),
  }).optional(),
  sourceSpans: z.array(z.object({
    pageNumber: z.number().int().nonnegative(),
    sourceOffset: z.number().int().nonnegative(),
    sourceQuote: z.string().min(1),
  })).min(1),
});

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function known(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && !/^(null|unknown|n\/a|not applicable)$/i.test(trimmed) ? trimmed : null;
}

/** Format only the supplied precision; never infer a day, year, or time zone. */
export function formatEvidenceDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = dateSchema.parse(value);
  const year = known(date.year);
  const month = known(date.month);
  const day = known(date.day);
  const season = known(date.season);
  const quarter = known(date.quarter);
  if (year && (!/^[+-]?\d+$/.test(year) || !Number.isSafeInteger(Number(year)))) {
    throw new Error("Evidence date has an invalid year");
  }
  if (month && (!/^\d+$/.test(month) || Number(month) < 1 || Number(month) > 12)) {
    throw new Error("Evidence date has an invalid month");
  }
  if (day && (!/^\d+$/.test(day) || Number(day) < 1 || Number(day) > 31)) {
    throw new Error("Evidence date has an invalid day");
  }
  if (month && day) {
    const leap = !year || Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (Number(day) > days[Number(month) - 1]) throw new Error("Evidence date is not a valid calendar date");
  }

  let text: string | null;
  if (month) {
    text = [day ? String(Number(day)) : null, MONTHS[Number(month) - 1], year].filter(Boolean).join(" ");
  } else if (day) {
    text = [year, `day ${Number(day)} (month unknown)`].filter(Boolean).join(", ");
  } else {
    text = [season, quarter, year].filter(Boolean).join(" ") || null;
  }
  if (text && (month || day)) {
    const extra = [season, quarter].filter(Boolean).join("; ");
    if (extra) text += ` (${extra})`;
  }
  return text;
}

/** Shared by ingestion and backfill so stored text and its vector stay aligned. */
export function formatEvidenceContent(value: unknown): string {
  const metadata = contentMetadataSchema.parse(value);
  const lines: string[] = [];
  const addDate = (label: string, date: unknown) => {
    const text = formatEvidenceDate(date);
    if (text) lines.push(`${label}: ${text}`);
  };
  const addPeople = (label: string, people: string[] | undefined) => {
    const names = people?.map(name => name.trim()).filter(Boolean);
    if (names?.length) lines.push(`${label}: ${names.join(", ")}`);
  };
  const addRoles = () => {
    if (!metadata.eventStructure) return;
    const structure = validateResolvedEventStructure(metadata.eventStructure, metadata.sourceSpans);
    for (const role of structure.roles) {
      const label = role.role.replace(/([A-Z])/g, " $1").toLowerCase();
      lines.push(`${label[0].toUpperCase() + label.slice(1)}: ${role.participant}`);
    }
  };

  // Use kind-specific fields before inherited tags, which may include user tags.
  if (metadata.claimType) {
    if (!metadata.claimant || !metadata.claimPolarity) throw new Error("Claim attribution and polarity are required");
    lines.push(`Claim by ${metadata.claimant} (${metadata.claimType}; ${metadata.claimPolarity}): ${metadata.what}`);
    addDate("Date referenced by the claim", metadata.whenStarted);
    addDate("End date referenced by the claim", metadata.whenEnded);
  } else if (metadata.factType) {
    lines.push(`Fact: ${metadata.what}`);
    addDate("As of", metadata.asOf);
    if (metadata.factType === "undatedOccurrence") {
      addPeople("Participants", metadata.who?.length ? metadata.who : metadata.subject);
      addPeople("Reported by", metadata.reportedBy);
      if (known(metadata.where)) lines.push(`Location: ${known(metadata.where)}`);
      if (known(metadata.why)) lines.push(`Reason: ${known(metadata.why)}`);
      if (metadata.eventDateResolution?.status === "unknown" && metadata.eventDateResolution.qualifier) {
        lines.push(`Relative timing (calendar date unknown): ${metadata.eventDateResolution.qualifier}`);
      }
      addRoles();
    } else {
      addPeople("Subject", metadata.subject);
      addPeople("Reported by", metadata.reportedBy);
    }
  } else if (metadata.tags.includes("event")) {
    lines.push(`Event: ${metadata.what}`);
    const resolution = metadata.eventDateResolution;
    if (resolution?.status === "dated" && resolution.relation === "bounded") {
      addDate("Earliest possible occurrence", resolution.start);
      addDate("Latest possible occurrence", resolution.end);
      lines.push(`Date uncertainty: ${resolution.qualifier}; these bounds do not imply continuous activity.`);
    } else {
      addDate(resolution?.relation === "approximate" ? "Approximate event date" : "Event start date", metadata.whenStarted);
      addDate("Event end date", metadata.whenEnded);
      if (resolution?.status === "dated" && resolution.qualifier) lines.push(`Date qualifier: ${resolution.qualifier}`);
      if (resolution?.status === "unknown" && resolution.qualifier) {
        lines.push(`Relative timing (calendar date unknown): ${resolution.qualifier}`);
      }
    }
    addPeople("Participants", metadata.who);
    addRoles();
  } else {
    throw new Error("Unrecognized evidence kind");
  }

  metadata.sourceSpans.forEach((span, index) => {
    lines.push(`${index ? "Supporting" : "Source"} page: ${span.pageNumber}`);
    lines.push(`${index ? "Supporting" : "Source"} quote: ${span.sourceQuote}`);
  });
  return lines.join("\n");
}
