import type { EventExtractionResponse } from "./evidenceExtractionSchemas.js";

interface FactDate {
  year: string | null;
  month: string | null;
  day: string | null;
  season: string | null;
  quarter: string | null;
}

function parseWholeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function cleanDatePart(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && !/^(null|unknown|n\/a|not applicable)$/i.test(trimmed) ? trimmed : null;
}

export function emptyDate(): FactDate {
  return { year: null, month: null, day: null, season: null, quarter: null };
}

export function buildDate(parts: FactDate): FactDate | null {
  const year = cleanDatePart(parts.year);
  const month = cleanDatePart(parts.month);
  const day = cleanDatePart(parts.day);
  const season = cleanDatePart(parts.season);
  const quarter = cleanDatePart(parts.quarter);

  if (year !== null && parseWholeNumber(year) === null) return null;
  if (day !== null && (parseWholeNumber(day) === null || Number(day) < 1 || Number(day) > 31)) return null;

  const validMonth = month !== null && (parseWholeNumber(month) === null || Number(month) < 1 || Number(month) > 12)
    ? null : month;
  const date = { year, month: validMonth, day, season, quarter };
  return Object.values(date).some((value) => value !== null) ? date : null;
}

export function hasEventDate(item: EventExtractionResponse): boolean {
  const date = (prefix: "whenStarted" | "whenEnded") => buildDate({
    year: item[`${prefix}Year`], month: item[`${prefix}Month`], day: item[`${prefix}Day`],
    season: item[`${prefix}Season`], quarter: item[`${prefix}Quarter`],
  });
  return date("whenStarted") !== null || date("whenEnded") !== null;
}

export function knownOrUnknown(value: string): string {
  const trimmed = value.trim();
  return trimmed && !/^(unknown|null|n\/a)$/i.test(trimmed) ? trimmed : "Unknown";
}

