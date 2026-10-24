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

describe("contributions of holdings without a price yet", () => {
  const days = daysBetween("2026-03-01", "2026-03-05");

  it("counts a manual coin as contributed once it is first priced", () => {
    // Saved on 2.3. before any price; priced on 4.3. at 100,00, 5.3. 120,00.
    const series = investmentAccountSeries(
      {
        holdings: [{ assetId: "coin", date: "2026-03-02", quantity: "2" }],
        prices: [
          {
            assetId: "coin",
            date: "2026-03-04",
            priceMinor: "10000",
            currency: "EUR",
          },
          {
            assetId: "coin",
            date: "2026-03-05",
            priceMinor: "12000",
            currency: "EUR",
          },
        ],
        fxRates: [],
        transactions: [],
        syncedCash: false,
      },
      days,
    );
    const values = withHoldings([], series).map((point) => point.amountMinor);
    expect(values).toEqual([null, 0, 0, 20_000, 24_000]);
    const result = portfolioPerformance(
      [{ values, flows: series.flows }],
      days.length,
    );
    expect(points(result, "contributedMinor")).toEqual([
      null,
      0,
      0,
      20_000,
      20_000,
    ]);
    expect(points(result, "gainMinor")).toEqual([null, 0, 0, 0, 4_000]);
  });

  it("counts units transferred in unpriced once priced, but not unpriced buys", () => {
    const tx = (
      type: "transfer" | "buy",
      assetId: string,
      amountMinor: number,
    ) => ({
      assetId,
      type,
      tradeDate: "2026-03-02",
      quantity: "1",
      amountMinor,
      currency: "EUR",
    });
    const series = investmentAccountSeries(
      {
        holdings: [
          { assetId: "in", date: "2026-03-02", quantity: "1" },
          { assetId: "bought", date: "2026-03-02", quantity: "1" },
        ],
        prices: ["in", "bought"].map((assetId) => ({
          assetId,
          date: "2026-03-04",
          priceMinor: "5000",
          currency: "EUR",
        })),
        fxRates: [],
        transactions: [
          {
            assetId: null,
            type: "transfer",
            tradeDate: "2026-03-01",
            quantity: null,
            amountMinor: 5_000,
            currency: "EUR",
          },
          tx("transfer", "in", 0),
          tx("buy", "bought", -5_000),
        ],
        syncedCash: false,
      },
      days,
    );
    const values = withHoldings([], series).map((point) => point.amountMinor);
    // Cash 50,00 spent on the unpriced buy; both units priced on 4.3.
    expect(values).toEqual([5_000, 0, 0, 10_000, 10_000]);
    const result = portfolioPerformance(
      [{ values, flows: series.flows }],
      days.length,
    );
    // The transferred unit is contributed, the bought one restores the
    // cash it took.
    expect(points(result, "contributedMinor")).toEqual([
      5_000, 5_000, 5_000, 10_000, 10_000,
    ]);
    expect(points(result, "gainMinor")).toEqual([0, -5_000, -5_000, 0, 0]);
  });

  it("does not count a synced account's snapshot changes as flows", () => {
    // Kraken-like: cash synced, a coin bought with it (no ledger yet).
    const series = investmentAccountSeries(
      {
        holdings: [{ assetId: "coin", date: "2026-03-02", quantity: "1" }],
        prices: [
          {
            assetId: "coin",
            date: "2026-03-01",
            priceMinor: "4000",
            currency: "EUR",
          },
        ],
        fxRates: [],
        transactions: [],
        syncedCash: true,
      },
      days,
    );
    expect(series.flows).toEqual([0, 0, 0, 0, 0]);
    const cash = [10_000, 6_000, 6_000, 6_000, 6_000].map((amountMinor) => ({
      amountMinor,
      estimated: false,
    }));
    const values = withHoldings(cash, series).map((point) => point.amountMinor);
    expect(values).toEqual(Array(5).fill(10_000));
  });

  it("counts a synced account's EUR and coin transfers as contributions", () => {
    const series = investmentAccountSeries(
      {
        holdings: [{ assetId: "coin", date: "2026-03-03", quantity: "2" }],
        prices: [
          {
            assetId: "coin",
            date: "2026-03-01",
            priceMinor: "4000",
            currency: "EUR",
          },
          {
            assetId: "coin",
            date: "2026-03-05",
            priceMinor: "4500",
            currency: "EUR",
          },
        ],
        fxRates: [],
        transactions: [
          {
            assetId: null,
            type: "transfer",
            tradeDate: "2026-03-02",
            quantity: null,
            amountMinor: 3_000,
            currency: "EUR",
          },
          {
            assetId: "coin",
            type: "transfer",
            tradeDate: "2026-03-03",
            quantity: "2",
            amountMinor: 0,
            currency: "EUR",
          },
        ],
        syncedCash: true,
      },
      days,
    );
    expect(series.derivedCash).toBeNull();
    expect(series.flows).toEqual([0, 3_000, 8_000, 0, 0]);
    const cash = [1_000, 4_000, 4_000, 4_000, 4_000].map((amountMinor) => ({
      amountMinor,
      estimated: false,
    }));
    const values = withHoldings(cash, series).map((point) => point.amountMinor);
    const result = portfolioPerformance(
      [{ values, flows: series.flows }],
      days.length,
    );
    expect(points(result, "contributedMinor")).toEqual([
      1_000, 4_000, 12_000, 12_000, 12_000,
    ]);
    expect(result.gainMinor).toBe(1_000);
  });
});

describe("contributions of holdings an account enters with unpriced", () => {
  // Kraken-like: 1.3. a 100,00 deposit, a coin transferred in and one bought
  // for 30,00 before the first sync on 2.3.; the price job first prices the
  // coin on 4.3. at 100,00, then 5.3. at 120,00.
  const series = (days: string[]) =>
    investmentAccountSeries(
      {
        holdings: [{ assetId: "coin", date: "2026-03-02", quantity: "2" }],
        prices: [
          {
            assetId: "coin",
            date: "2026-03-04",
            priceMinor: "10000",
            currency: "EUR",
          },
          {
            assetId: "coin",
            date: "2026-03-05",
            priceMinor: "12000",
            currency: "EUR",
          },
        ],
        fxRates: [],
        transactions: [
          {
            assetId: null,
            type: "transfer",
            tradeDate: "2026-03-01",
            quantity: null,
            amountMinor: 10_000,
            currency: "EUR",
          },
          {
            assetId: "coin",
            type: "transfer",
            tradeDate: "2026-03-01",
            quantity: "1",
            amountMinor: 0,
            currency: "EUR",
          },
          {
            assetId: "coin",
            type: "buy",
            tradeDate: "2026-03-01",
            quantity: "1",
            amountMinor: -3_000,
            currency: "EUR",
          },
        ],
        syncedCash: true,
        cashFrom: "2026-03-02",
      },
      days,
    );
  const cash = (count: number) =>
    Array.from({ length: count }, () => ({
      amountMinor: 7_000,
      estimated: false,
    }));

  it("counts every unit held at the first snapshot once it is priced", () => {
    // The `all` range starts at the synced account's first snapshot.
    const days = daysBetween("2026-03-02", "2026-03-05");
    const account = series(days);
    // Both coins, the bought one too, and each only once.
    expect(account.flows).toEqual([0, 0, 20_000, 0]);
    const values = withHoldings(cash(days.length), account).map(
      (point) => point.amountMinor,
    );
    expect(values).toEqual([7_000, 7_000, 27_000, 31_000]);
    const result = portfolioPerformance(
      [{ values, flows: account.flows }],
      days.length,
    );
    expect(points(result, "contributedMinor")).toEqual([
      7_000, 7_000, 27_000, 27_000,
    ]);
    expect(points(result, "gainMinor")).toEqual([0, 0, 0, 4_000]);
  });

  it("counts units still unpriced on a later range's first day", () => {
    const days = daysBetween("2026-03-03", "2026-03-05");
    const account = series(days);
    expect(account.flows).toEqual([0, 20_000, 0]);
    const values = withHoldings(cash(days.length), account).map(
      (point) => point.amountMinor,
    );
    const result = portfolioPerformance(
      [{ values, flows: account.flows }],
      days.length,
    );
    expect(points(result, "gainMinor")).toEqual([0, 0, 4_000]);
    expect(result.contributionsMinor).toBe(20_000);
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
