import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatDuration,
  formatDay,
  formatLocalDay,
  formatMonth,
  formatPercent,
} from "@/lib/format";

// Money formatting: tests/unit/format/money.test.ts.

describe("formatDay", () => {
  it("formats a day as d.m.yyyy", () => {
    expect(formatDay("2026-01-05")).toBe("5.1.2026");
    expect(formatDay("2025-12-31")).toBe("31.12.2025");
  });
});

describe("formatDateTime", () => {
  it("formats a point in time fi-FI in the given time zone", () => {
    const instant = new Date("2026-01-05T07:04:00Z");
    expect(formatDateTime(instant, "Europe/Helsinki")).toBe(
      "5.1.2026 klo 9.04",
    );
    expect(formatDateTime(instant, "UTC")).toBe("5.1.2026 klo 7.04");
  });
});

describe("formatDuration", () => {
  it("shows milliseconds, seconds with a fi-FI decimal, or minutes", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(349.6)).toBe("350 ms");
    expect(formatDuration(1_000)).toBe("1 s");
    expect(formatDuration(1_250)).toBe("1,2 s");
    expect(formatDuration(59_999)).toBe("59,9 s");
    expect(formatDuration(125_400)).toBe("2 min 5 s");
  });
});

describe("formatLocalDay", () => {
  it("takes the day in the given time zone", () => {
    const instant = new Date("2026-03-31T22:30:00Z");
    expect(formatLocalDay(instant, "Europe/Helsinki")).toBe("1.4.2026");
    expect(formatLocalDay(instant, "UTC")).toBe("31.3.2026");
  });
});

describe("formatMonth", () => {
  it("shows a month as its short name and year", () => {
    expect(formatMonth("2026-10")).toBe("Oct 2026");
    expect(formatMonth("2027-01")).toBe("Jan 2027");
    expect(formatMonth("2026-09")).toBe("Sep 2026");
  });
});

describe("formatPercent", () => {
  it("formats a share as fi-FI percent with one decimal", () => {
    expect(formatPercent(0.748)).toBe("74,8 %");
    expect(formatPercent(1)).toBe("100 %");
    expect(formatPercent(-0.05)).toBe("−5 %");
  });
});
