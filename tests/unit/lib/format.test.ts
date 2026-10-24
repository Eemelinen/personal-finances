import { describe, expect, it } from "vitest";
import { formatDateTime, formatDay, formatLocalDay } from "@/lib/format";

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

describe("formatLocalDay", () => {
  it("takes the day in the given time zone", () => {
    const instant = new Date("2026-03-31T22:30:00Z");
    expect(formatLocalDay(instant, "Europe/Helsinki")).toBe("1.4.2026");
    expect(formatLocalDay(instant, "UTC")).toBe("31.3.2026");
  });
});
