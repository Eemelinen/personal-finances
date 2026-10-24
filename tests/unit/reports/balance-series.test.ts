import { describe, expect, it } from "vitest";
import {
  accountSeries,
  addMonthsToDay,
  daysBetween,
  parseBalanceRange,
  rangeStart,
  sumSeries,
  type AccountHistoryInput,
} from "@/server/reports/balance-series";

const snapshot = (date: string, amountMinor: number, balanceType = "CLBD") => ({
  date,
  amountMinor,
  currency: "EUR",
  balanceType,
});

const series = (
  input: Partial<AccountHistoryInput>,
  from: string,
  to: string,
) =>
  accountSeries(
    { snapshots: [], flows: [], firstTransactionDate: null, ...input },
    daysBetween(from, to),
  );

const amounts = (points: { amountMinor: number | null }[]) =>
  points.map((point) => point.amountMinor);

describe("ranges", () => {
  it("parses known ranges and falls back to 3 months", () => {
    expect(parseBalanceRange("1y")).toBe("1y");
    expect(parseBalanceRange("all")).toBe("all");
    expect(parseBalanceRange("12m")).toBe("3m");
    expect(parseBalanceRange(undefined)).toBe("3m");
  });

  it("starts the day after the same day months earlier", () => {
    expect(rangeStart("3m", "2026-10-24", null)).toBe("2026-07-25");
    expect(rangeStart("6m", "2026-10-24", null)).toBe("2026-04-25");
    expect(rangeStart("1y", "2026-10-24", null)).toBe("2025-10-25");
    expect(
      daysBetween(rangeStart("1y", "2026-10-24", null), "2026-10-24"),
    ).toHaveLength(365);
  });

  it("clamps the day of month", () => {
    expect(addMonthsToDay("2026-05-31", -3)).toBe("2026-02-28");
    expect(rangeStart("3m", "2026-05-31", null)).toBe("2026-03-01");
    expect(addMonthsToDay("2028-02-29", -12)).toBe("2027-02-28");
  });

  it("starts all at the earliest data, or today without any", () => {
    expect(rangeStart("all", "2026-10-24", "2024-02-10")).toBe("2024-02-10");
    expect(rangeStart("all", "2026-10-24", null)).toBe("2026-10-24");
    expect(rangeStart("all", "2026-10-24", "2026-11-01")).toBe("2026-10-24");
  });

  it("lists days across a month end", () => {
    expect(daysBetween("2026-02-27", "2026-03-02")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
    expect(daysBetween("2026-03-02", "2026-03-01")).toEqual([]);
  });
});

describe("accountSeries gap filling", () => {
  it("carries the last known balance over days without a sync", () => {
    const points = series(
      {
        snapshots: [snapshot("2026-10-02", 1_000), snapshot("2026-10-05", 700)],
      },
      "2026-10-02",
      "2026-10-07",
    );
    expect(amounts(points)).toEqual([1_000, 1_000, 1_000, 700, 700, 700]);
    expect(points.every((point) => !point.estimated)).toBe(true);
  });

  it("carries a snapshot from before the range into it", () => {
    const points = series(
      { snapshots: [snapshot("2026-09-01", 5_000)] },
      "2026-10-01",
      "2026-10-02",
    );
    expect(amounts(points)).toEqual([5_000, 5_000]);
  });

  it("uses the display balance type of the latest day", () => {
    const points = series(
      {
        snapshots: [
          snapshot("2026-10-01", 900, "CLBD"),
          snapshot("2026-10-01", 950, "ITAV"),
          snapshot("2026-10-02", 800, "CLBD"),
        ],
      },
      "2026-10-01",
      "2026-10-02",
    );
    expect(amounts(points)).toEqual([950, 800]);
  });

  it("ignores snapshots after the range", () => {
    const points = series(
      { snapshots: [snapshot("2026-10-10", 100)] },
      "2026-10-01",
      "2026-10-03",
    );
    expect(amounts(points)).toEqual([null, null, null]);
  });

  it("is unknown before the first snapshot without transactions", () => {
    const points = series(
      { snapshots: [snapshot("2026-10-03", 100)] },
      "2026-10-01",
      "2026-10-04",
    );
    expect(points).toEqual([
      { amountMinor: null, estimated: false },
      { amountMinor: null, estimated: false },
      { amountMinor: 100, estimated: false },
      { amountMinor: 100, estimated: false },
    ]);
  });
});

describe("accountSeries backward reconstruction", () => {
  it("subtracts the transactions booked after each day, marked estimated", () => {
    // Closing balance on 5.10. is 1 000,00. Booked: +200,00 on 2.10.,
    // −50,00 on 4.10., −30,00 on 5.10. (included in that day's balance).
    const points = series(
      {
        snapshots: [
          snapshot("2026-10-05", 100_000),
          snapshot("2026-10-06", 90_000),
        ],
        flows: [
          { date: "2026-10-02", amountMinor: 20_000 },
          { date: "2026-10-04", amountMinor: -5_000 },
          { date: "2026-10-05", amountMinor: -3_000 },
          // After the first snapshot: not used.
          { date: "2026-10-06", amountMinor: -10_000 },
        ],
        firstTransactionDate: "2026-10-02",
      },
      "2026-09-30",
      "2026-10-06",
    );
    expect(points).toEqual([
      { amountMinor: null, estimated: false },
      { amountMinor: null, estimated: false },
      // 1 000 + 30 + 50 = 1 080 on 2.10. and 3.10., 1 030 on 4.10.
      { amountMinor: 108_000, estimated: true },
      { amountMinor: 108_000, estimated: true },
      { amountMinor: 103_000, estimated: true },
      { amountMinor: 100_000, estimated: false },
      { amountMinor: 90_000, estimated: false },
    ]);
  });

  it("goes back to the first transaction even when it is before the range", () => {
    const points = series(
      {
        snapshots: [snapshot("2026-10-04", 1_000)],
        flows: [
          { date: "2026-10-03", amountMinor: 100 },
          { date: "2026-10-04", amountMinor: 200 },
        ],
        firstTransactionDate: "2026-01-15",
      },
      "2026-10-02",
      "2026-10-04",
    );
    expect(points).toEqual([
      { amountMinor: 700, estimated: true },
      { amountMinor: 800, estimated: true },
      { amountMinor: 1_000, estimated: false },
    ]);
  });

  it("does not reconstruct when the first snapshot is before the range", () => {
    const points = series(
      {
        snapshots: [snapshot("2026-09-01", 1_000)],
        flows: [{ date: "2026-10-02", amountMinor: 500 }],
        firstTransactionDate: "2026-08-01",
      },
      "2026-10-01",
      "2026-10-02",
    );
    expect(points).toEqual([
      { amountMinor: 1_000, estimated: false },
      { amountMinor: 1_000, estimated: false },
    ]);
  });

  it("starts from the display balance of the first snapshot day", () => {
    const points = series(
      {
        snapshots: [
          snapshot("2026-10-02", 400, "CLBD"),
          snapshot("2026-10-02", 500, "ITAV"),
        ],
        flows: [{ date: "2026-10-02", amountMinor: 50 }],
        firstTransactionDate: "2026-10-01",
      },
      "2026-10-01",
      "2026-10-02",
      // Default preference: ITAV before CLBD.
    );
    expect(amounts(points)).toEqual([450, 500]);
  });
});

describe("sumSeries", () => {
  it("sums known balances and marks a day estimated when any part is", () => {
    const total = sumSeries(
      [
        [
          { amountMinor: null, estimated: false },
          { amountMinor: 100, estimated: true },
          { amountMinor: 120, estimated: false },
        ],
        [
          { amountMinor: null, estimated: false },
          { amountMinor: 50, estimated: false },
          { amountMinor: -20, estimated: false },
        ],
      ],
      3,
    );
    expect(total).toEqual([
      { amountMinor: null, estimated: false },
      { amountMinor: 150, estimated: true },
      { amountMinor: 100, estimated: false },
    ]);
  });
});
