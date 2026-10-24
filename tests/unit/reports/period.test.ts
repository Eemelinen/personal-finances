import { describe, expect, it } from "vitest";
import {
  addMonths,
  averageRange,
  isIsoDate,
  lastDay,
  monthsEnding,
  previousRange,
  resolvePeriod,
} from "@/server/reports/period";

const TODAY = "2026-10-24";

describe("resolvePeriod", () => {
  it("resolves the presets to whole months", () => {
    const range = (period: string) => {
      const { from, to } = resolvePeriod({ period }, TODAY);
      return [from, to];
    };
    expect(range("this-month")).toEqual(["2026-10-01", "2026-10-31"]);
    expect(range("last-month")).toEqual(["2026-09-01", "2026-09-30"]);
    expect(range("3m")).toEqual(["2026-08-01", "2026-10-31"]);
    expect(range("6m")).toEqual(["2026-05-01", "2026-10-31"]);
    expect(range("12m")).toEqual(["2025-11-01", "2026-10-31"]);
  });

  it("crosses a year boundary", () => {
    expect(resolvePeriod({ period: "last-month" }, "2026-01-05")).toEqual({
      id: "last-month",
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });

  it("accepts a valid custom range", () => {
    expect(
      resolvePeriod(
        { period: "custom", from: "2026-02-03", to: "2026-02-28" },
        TODAY,
      ),
    ).toEqual({ id: "custom", from: "2026-02-03", to: "2026-02-28" });
  });

  it("falls back to this month for anything else", () => {
    for (const params of [
      {},
      { period: "forever" },
      { period: "custom" },
      { period: "custom", from: "2026-03-10", to: "2026-03-01" },
      { period: "custom", from: "2026-02-30", to: "2026-03-01" },
      { period: "custom", from: "1.3.2026", to: "2026-03-31" },
      { period: "custom", from: "1900-01-01", to: "2026-03-31" },
    ]) {
      expect(resolvePeriod(params, TODAY).id).toBe("this-month");
    }
  });
});

describe("previousRange", () => {
  it("moves whole months back by as many months", () => {
    expect(previousRange({ from: "2026-10-01", to: "2026-10-31" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(previousRange({ from: "2026-01-01", to: "2026-03-31" })).toEqual({
      from: "2025-10-01",
      to: "2025-12-31",
    });
    expect(previousRange({ from: "2026-03-01", to: "2026-03-31" })).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("moves any other range back by as many days", () => {
    expect(previousRange({ from: "2026-03-02", to: "2026-03-08" })).toEqual({
      from: "2026-02-23",
      to: "2026-03-01",
    });
    expect(previousRange({ from: "2026-03-15", to: "2026-03-15" })).toEqual({
      from: "2026-03-14",
      to: "2026-03-14",
    });
  });
});

describe("averageRange", () => {
  it("is the six whole months before the period's first month", () => {
    expect(averageRange({ from: "2026-02-10", to: "2026-04-01" })).toEqual({
      from: "2025-08-01",
      to: "2026-01-31",
    });
  });
});

describe("month helpers", () => {
  it("adds months across years", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2025-12", 13)).toBe("2027-01");
    expect(monthsEnding("2026-02", 3)).toEqual([
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("knows month lengths and real days", () => {
    expect(lastDay("2028-02")).toBe("2028-02-29");
    expect(lastDay("2026-02")).toBe("2026-02-28");
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-1-01")).toBe(false);
  });
});
