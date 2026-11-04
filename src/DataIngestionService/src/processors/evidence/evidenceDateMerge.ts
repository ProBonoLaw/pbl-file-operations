import { formatEvidenceDate } from "./evidenceContent.js";

const DATE_PARTS = ["year", "month", "day", "season", "quarter"] as const;

const known = (value: unknown): string | null => typeof value === "string"
  && value.trim() && !/^(unknown|null|n\/a|not applicable)$/i.test(value.trim()) ? value.trim() : null;

/** Return undefined when two partial dates conflict; otherwise retain every supported part. */
export function mergeCompatibleEvidenceDate(first: unknown, second: unknown): unknown | undefined {
  if (first == null && second == null) return null;
  if (first == null) return second;
  if (second == null) return first;
  if (typeof first !== "object" || typeof second !== "object" || Array.isArray(first) || Array.isArray(second)) {
    return undefined;
  }
  const left = first as Record<string, unknown>, right = second as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const part of DATE_PARTS) {
    const a = known(left[part]), b = known(right[part]);
    if (a && b && a !== b) return undefined;
    merged[part] = a ? left[part] : b ? right[part] : left[part] ?? right[part] ?? null;
  }
  const month = known(merged.month), quarter = known(merged.quarter);
  if (month && quarter && quarter.toUpperCase() !== `Q${Math.ceil(Number(month) / 3)}`) return undefined;
  try {
    formatEvidenceDate(merged);
  } catch {
    return undefined;
  }
  return merged;
}
