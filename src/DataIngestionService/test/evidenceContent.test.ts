import { describe, expect, it } from "vitest";
import { formatEvidenceContent, formatEvidenceDate } from "../src/processors/evidence/evidenceContent.ts";

const citation = { pageNumber: 2, sourceOffset: 12, sourceQuote: 'She said, "approximately March."\nThe record continues.' };
const base = { what: "A recorded observation.", tags: ["fact"], sourceSpans: [citation] };

describe("evidence dates for retrieval", () => {
  it.each([
    [{ year: "2025", month: "02", day: "28" }, "28 February 2025"],
    [{ year: "2024", month: "2", day: "29" }, "29 February 2024"],
    [{ year: "2025", month: "3" }, "March 2025"],
    [{ year: "2025", day: "Unknown" }, "2025"],
    [{ year: "2025", day: "n/a", month: "not applicable" }, "2025"],
    [{ year: "2025", day: "7" }, "2025, day 7 (month unknown)"],
    [{ month: "3", day: "7" }, "7 March"],
    [{ month: "3" }, "March"],
    [{ year: "2025", season: "spring", quarter: "Q2" }, "spring Q2 2025"],
    [{ year: "2025", month: "4", season: "spring" }, "April 2025 (spring)"],
    [{ year: "unknown", month: "", day: null }, null],
    [null, null],
  ])("preserves available precision for %j", (date, expected) => {
    expect(formatEvidenceDate(date)).toBe(expected);
  });

  it.each([
    { year: "2025", month: "2", day: "29" },
    { year: "1900", month: "2", day: "29" },
    { month: "4", day: "31" },
    { month: "13" },
    { day: "0" },
    { year: "2025ish" },
  ])("rejects invalid date components without inventing a date: %j", date => {
    expect(() => formatEvidenceDate(date)).toThrow();
  });
});

describe("evidence content", () => {
  it("includes a fact's applicable date, subject, reporter, and exact citations", () => {
    const content = formatEvidenceContent({ ...base, factType: "assessmentResult",
      asOf: { year: "2025", month: "3" }, subject: ["Casey"], reportedBy: ["Parent"],
      sourceSpans: [citation, { ...citation, pageNumber: 1, sourceQuote: "Assessment date: March 2025" }],
    });
    expect(content).toBe('Fact: A recorded observation.\nAs of: March 2025\nSubject: Casey\nReported by: Parent\nSource page: 2\nSource quote: She said, "approximately March."\nThe record continues.\nSupporting page: 1\nSupporting quote: Assessment date: March 2025');
  });

  it("retains the participants and attribution of a directly extracted undated occurrence", () => {
    const content = formatEvidenceContent({ ...base, factType:"undatedOccurrence", subject:["Casey"],
      reportedBy:["Morgan"], where:"Cedar House", sourceSpans:[citation] });
    expect(content).toContain("Participants: Casey");
    expect(content).toContain("Reported by: Morgan");
    expect(content).toContain("Location: Cedar House");
    expect(content).toContain("Source quote: She said");
  });

  it("preserves attribution, denial and approximate wording and labels claim dates as referenced dates", () => {
    const content = formatEvidenceContent({ ...base, what: "Denied involvement around early 2025.",
      tags: ["claim"], claimType: "allegation", claimant: "Jane", claimPolarity: "denies",
      whenStarted: { year: "2025" }, whenEnded: { year: "2026", month: "2" },
    });
    expect(content).toContain("Claim by Jane (allegation; denies): Denied involvement around early 2025.");
    expect(content).toContain("Date referenced by the claim: 2025\nEnd date referenced by the claim: February 2026");
    expect(content).not.toContain("Statement date");
  });

  it("includes both event dates without serializing unknown date parts", () => {
    const content = formatEvidenceContent({ ...base, tags: ["fact", "event"], who: ["Casey"],
      whenStarted: { year: "2024" }, whenEnded: { year: "2025", month: "3", day: "1" },
    });
    expect(content).toContain("Event start date: 2024\nEvent end date: 1 March 2025\nParticipants: Casey");
    expect(content).not.toMatch(/null|\{"year"/);
  });

  it("retains end-only dates without inventing a start date", () => {
    const content = formatEvidenceContent({ ...base, tags: ["event"], whenEnded: { year: "2025" } });
    expect(content).toContain("Event end date: 2025");
    expect(content).not.toContain("Event start date");
  });

  it("uses fact metadata even when inherited tags include event", () => {
    const content = formatEvidenceContent({ ...base, factType: "attribute", tags: ["event", "fact"],
      asOf: { year: null, month: "unknown" },
    });
    expect(content).toMatch(/^Fact:/);
    expect(content).not.toMatch(/As of:|Event start date|unknown|null/);
  });
});
