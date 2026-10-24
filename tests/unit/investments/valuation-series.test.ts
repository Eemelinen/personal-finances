import { describe, expect, it } from "vitest";
import { valueHoldings } from "@/server/investments/valuation";
import {
  derivedCashSeries,
  holdingsSeries,
  investmentAccountSeries,
  snapshotMovements,
  withHoldings,
} from "@/server/investments/valuation-series";
import { daysBetween } from "@/server/reports/balance-series";

// Daily holdings values (F-022): the same answer as valueHoldings() on
// every day, from one pass over the rows.

const days = daysBetween("2026-03-01", "2026-03-07");

const holdings = [
  { assetId: "aaa", date: "2026-03-02", quantity: "10" },
  { assetId: "usx", date: "2026-03-03", quantity: "2" },
  { assetId: "aaa", date: "2026-03-05", quantity: "4" },
  { assetId: "usx", date: "2026-03-06", quantity: "0" },
];
const prices = [
  { assetId: "aaa", date: "2026-02-20", priceMinor: "1000", currency: "EUR" },
  { assetId: "aaa", date: "2026-03-04", priceMinor: "1250.5", currency: "EUR" },
  { assetId: "usx", date: "2026-03-03", priceMinor: "11000", currency: "USD" },
];
const fxRates = [{ date: "2026-03-04", currency: "USD", rate: "1.1" }];

describe("holdingsSeries", () => {
  it("values each day like valueHoldings() would", () => {
    const series = holdingsSeries({ holdings, prices, fxRates }, days);
    expect(series.map((day) => day.valueMinor)).toEqual(
      days.map((date, index) =>
        index === 0
          ? null
          : valueHoldings({ date, holdings, prices, fxRates }).valueMinor,
      ),
    );
    // Before the first snapshot nothing is known; USX has no rate until
    // 4.3.; 5.3. 4 × 12,505 + 2 × 110 / 1,1; sold out on 6.3.
    expect(series.map((day) => day.valueMinor)).toEqual([
      null,
      10_000,
      10_000,
      32_505,
      25_002,
      5_002,
      5_002,
    ]);
  });

  it("values the day's movements at the day's prices", () => {
    const series = holdingsSeries(
      {
        holdings,
        prices,
        fxRates,
        movements: [
          // Before the first day: ignored.
          { assetId: "aaa", date: "2026-02-28", quantity: "1" },
          { assetId: "aaa", date: "2026-03-02", quantity: "10" },
          { assetId: "aaa", date: "2026-03-05", quantity: "-6" },
          // No rate yet: counts 0.
          { assetId: "usx", date: "2026-03-03", quantity: "2" },
        ],
      },
      days,
    );
    expect(series.map((day) => day.movedMinor)).toEqual([
      0, 10_000, 0, 0, -7_503, 0, 0,
    ]);
  });
});

describe("snapshotMovements", () => {
  it("turns quantity snapshots into changes", () => {
    expect(snapshotMovements(holdings)).toEqual([
      { assetId: "aaa", date: "2026-03-02", quantity: "10" },
      { assetId: "usx", date: "2026-03-03", quantity: "2" },
      { assetId: "aaa", date: "2026-03-05", quantity: "-6" },
      { assetId: "usx", date: "2026-03-06", quantity: "-2" },
    ]);
  });
});

describe("derivedCashSeries", () => {
  it("sums the EUR cash effects up to each day", () => {
    expect(
      derivedCashSeries(
        [
          { tradeDate: "2026-03-04", amountMinor: -300, currency: "EUR" },
          { tradeDate: "2026-02-01", amountMinor: 1_000, currency: "EUR" },
          { tradeDate: "2026-03-02", amountMinor: -9_999, currency: "USD" },
        ],
        daysBetween("2026-01-31", "2026-02-01").concat(
          daysBetween("2026-03-03", "2026-03-04"),
        ),
      ),
    ).toEqual([null, 1_000, 1_000, 700]);
  });
});

describe("investmentAccountSeries", () => {
  it("uses a synced balance instead of deriving cash", () => {
    const series = investmentAccountSeries(
      {
        holdings,
        prices,
        fxRates,
        transactions: [
          {
            assetId: null,
            type: "transfer",
            tradeDate: "2026-03-01",
            quantity: null,
            amountMinor: 5_000,
            currency: "EUR",
          },
        ],
        syncedCash: true,
      },
      days,
    );
    expect(series.derivedCash).toBeNull();
    expect(series.flows[0]).toBe(5_000);
    const cash = days.map(() => ({ amountMinor: 700, estimated: true }));
    expect(withHoldings(cash, series).slice(0, 2)).toEqual([
      { amountMinor: 700, estimated: true },
      { amountMinor: 10_700, estimated: true },
    ]);
  });

  it("takes a manual wallet's flows from its snapshots", () => {
    const series = investmentAccountSeries(
      { holdings, prices, fxRates, transactions: [], syncedCash: false },
      days,
    );
    expect(series.derivedCash).toBeNull();
    expect(series.flows).toEqual([0, 10_000, 0, 0, -7_503, -20_000, 0]);
    expect(withHoldings([], series)[0]).toEqual({
      amountMinor: null,
      estimated: false,
    });
  });
});
