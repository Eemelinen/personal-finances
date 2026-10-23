import { describe, expect, it } from "vitest";
import { formatDay, formatMoney } from "@/lib/format";

describe("formatMoney", () => {
  it("formats minor units as fi-FI money", () => {
    // fi-FI groups with a no-break space and uses the minus sign U+2212.
    expect(formatMoney(-123_456, "EUR")).toBe("−1 234,56 €");
    expect(formatMoney(5, "EUR")).toBe("0,05 €");
    expect(formatMoney(350_000, "EUR")).toBe("3\u00a0500,00\u00a0€");
  });
});

describe("formatDay", () => {
  it("formats a day as d.m.yyyy", () => {
    expect(formatDay("2026-01-05")).toBe("5.1.2026");
    expect(formatDay("2025-12-31")).toBe("31.12.2025");
  });
});
