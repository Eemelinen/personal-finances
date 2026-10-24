import { describe, expect, it } from "vitest";
import { portfolioPerformance } from "@/server/investments/performance";
import {
  investmentAccountSeries,
  withHoldings,
} from "@/server/investments/valuation-series";
import { daysBetween } from "@/server/reports/balance-series";

// Contributions vs market gain (F-022): money and units moved in are
// contributions, price moves, dividends and fees are the market's.

const points = (
  result: ReturnType<typeof portfolioPerformance>,
  key: "valueMinor" | "contributedMinor" | "gainMinor",
) => result.points.map((point) => point[key]);

describe("portfolioPerformance", () => {
  it("starts contributed at the first day's value", () => {
    const result = portfolioPerformance(
      [{ values: [1_000, 1_100, 1_050], flows: [0, 0, 0] }],
      3,
    );
    expect(points(result, "contributedMinor")).toEqual([1_000, 1_000, 1_000]);
    expect(points(result, "gainMinor")).toEqual([0, 100, 50]);
    expect(result).toMatchObject({
      startMinor: 1_000,
      endMinor: 1_050,
      contributionsMinor: 0,
      gainMinor: 50,
    });
  });

  it("counts deposits and withdrawals as contributions, not gains", () => {
    // Day 1: a 500 deposit; day 2: prices add 30; day 3: a 200 withdrawal.
    const result = portfolioPerformance(
      [
        {
          values: [1_000, 1_500, 1_530, 1_330],
          flows: [0, 500, 0, -200],
        },
      ],
      4,
    );
    expect(points(result, "contributedMinor")).toEqual([
      1_000, 1_500, 1_500, 1_300,
    ]);
    expect(points(result, "gainMinor")).toEqual([0, 0, 30, 30]);
    expect(result.contributionsMinor).toBe(300);
    expect(result.gainMinor).toBe(30);
  });

  it("brings an account that starts within the range in as a contribution", () => {
    const result = portfolioPerformance(
      [
        { values: [1_000, 1_010, 1_020], flows: [0, 0, 0] },
        // Its first day's deposit is part of the value it enters with.
        { values: [null, 400, 410], flows: [0, 400, 0] },
      ],
      3,
    );
    expect(points(result, "valueMinor")).toEqual([1_000, 1_410, 1_430]);
    expect(points(result, "contributedMinor")).toEqual([1_000, 1_400, 1_400]);
    expect(points(result, "gainMinor")).toEqual([0, 10, 30]);
    expect(result.contributionsMinor).toBe(400);
    expect(
      result.startMinor! + result.contributionsMinor + result.gainMinor!,
    ).toBe(result.endMinor);
  });

  it("is unknown until some account has a value", () => {
    const result = portfolioPerformance(
      [{ values: [null, null, 200], flows: [0, 0, 0] }],
      3,
    );
    expect(points(result, "valueMinor")).toEqual([null, null, 200]);
    expect(points(result, "gainMinor")).toEqual([null, null, 0]);
    // Unknown at the start, so the value it enters with is contributed.
    expect(result.startMinor).toBeNull();
    expect(result.contributionsMinor).toBe(200);
  });

  it("is empty without accounts", () => {
    const result = portfolioPerformance([], 2);
    expect(result.startMinor).toBeNull();
    expect(result.gainMinor).toBeNull();
    expect(result.contributionsMinor).toBe(0);
  });

  it("takes the last value of an account that disappears out as a withdrawal", () => {
    const result = portfolioPerformance(
      [
        { values: [100, 100, 100], flows: [0, 0, 0] },
        { values: [50, 60, null], flows: [0, 0, 0] },
      ],
      3,
    );
    expect(points(result, "contributedMinor")).toEqual([150, 150, 90]);
    expect(points(result, "gainMinor")).toEqual([0, 10, 10]);
  });
});

describe("contributions vs market gain of an account's transactions", () => {
  const days = daysBetween("2026-03-01", "2026-03-06");
  const STOCK = "stock";

  /** A brokerage account without a synced balance (a Nordnet import). */
  function perform(
    transactions: Parameters<typeof investmentAccountSeries>[0]["transactions"],
    prices: { date: string; priceMinor: string }[],
  ) {
    const series = investmentAccountSeries(
      {
        // The holdings import-nordnet derives from the trades.
        holdings: transactions
          .filter((tx) => tx.assetId !== null)
          .reduce<{ assetId: string; date: string; quantity: string }[]>(
            (rows, tx) => {
              const before = Number(rows.at(-1)?.quantity ?? 0);
              rows.push({
                assetId: STOCK,
                date: tx.tradeDate,
                quantity: String(before + Number(tx.quantity)),
              });
              return rows;
            },
            [],
          ),
        prices: prices.map((price) => ({
          assetId: STOCK,
          currency: "EUR",
          ...price,
        })),
        fxRates: [],
        transactions,
        syncedCash: false,
      },
      days,
    );
    const values = withHoldings([], series).map((point) => point.amountMinor);
    return {
      series,
      values,
      result: portfolioPerformance(
        [{ values, flows: series.flows }],
        days.length,
      ),
    };
  }

  it("splits a deposit, a trade, a price move, a dividend and a fee", () => {
    const { series, values, result } = perform(
      [
        // 1.3. deposit 1 000,00
        {
          assetId: null,
          type: "transfer",
          tradeDate: "2026-03-01",
          quantity: null,
          amountMinor: 100_000,
          currency: "EUR",
        },
        // 2.3. buy 10 at 50,00 with a 5,00 fee
        {
          assetId: STOCK,
          type: "buy",
          tradeDate: "2026-03-02",
          quantity: "10",
          amountMinor: -50_500,
          currency: "EUR",
        },
        // 4.3. dividend 20,00
        {
          assetId: STOCK,
          type: "dividend",
          tradeDate: "2026-03-04",
          quantity: null,
          amountMinor: 2_000,
          currency: "EUR",
        },
        // 5.3. account fee 1,00
        {
          assetId: null,
          type: "fee",
          tradeDate: "2026-03-05",
          quantity: null,
          amountMinor: -100,
          currency: "EUR",
        },
      ],
      [
        { date: "2026-03-02", priceMinor: "5000" },
        // 3.3. the close rises to 55,00
        { date: "2026-03-03", priceMinor: "5500" },
      ],
    );
    expect(series.derivedCash).toEqual([
      100_000, 49_500, 49_500, 51_500, 51_400, 51_400,
    ]);
    expect(values).toEqual([
      100_000, 99_500, 104_500, 106_500, 106_400, 106_400,
    ]);
    expect(series.flows).toEqual([100_000, 0, 0, 0, 0, 0]);
    expect(points(result, "contributedMinor")).toEqual(Array(6).fill(100_000));
    // The fee of the buy, the price rise, the dividend, the account fee.
    expect(points(result, "gainMinor")).toEqual([
      0, -500, 4_500, 6_500, 6_400, 6_400,
    ]);
  });

  it("values units transferred in at the day's price as a contribution", () => {
    const { result } = perform(
      [
        {
          assetId: STOCK,
          type: "transfer",
          tradeDate: "2026-03-02",
          quantity: "4",
          amountMinor: 0,
          currency: "EUR",
        },
      ],
      [
        { date: "2026-03-01", priceMinor: "2500" },
        { date: "2026-03-04", priceMinor: "3000" },
      ],
    );
    // Cash 0 from the transfer day on; 4 × 25,00 enters, then 4 × 5,00 gain.
    expect(points(result, "valueMinor")).toEqual([
      null,
      10_000,
      10_000,
      12_000,
      12_000,
      12_000,
    ]);
    expect(points(result, "contributedMinor")).toEqual([
      null,
      10_000,
      10_000,
      10_000,
      10_000,
      10_000,
    ]);
    expect(result.gainMinor).toBe(2_000);
  });
});
