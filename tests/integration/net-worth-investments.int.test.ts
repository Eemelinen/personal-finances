import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accounts,
  assets,
  balanceSnapshots,
  fxRates,
  holdings,
  institutions,
  investmentTransactions,
  prices,
} from "@/server/db/schema";
import { addDays } from "@/server/dates";
import { getBalanceHistory } from "@/server/queries/balance-history";
import { getDashboardOverview } from "@/server/queries/dashboard";
import {
  getAllocation,
  getPortfolioPerformance,
} from "@/server/queries/portfolio";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// Net worth with investments (F-022) against a real Postgres 18: brokerage
// and crypto accounts in the balance history and the dashboard, valued per
// day with the prices and rates known that day; today's allocation by asset
// class and account; the portfolio's contributions and market gain. Each
// test starts from empty tables; the clock is pinned.

const TIME_ZONE = "Europe/Helsinki";
const NOW = new Date("2026-10-23T23:30:00Z");
const TODAY = "2026-10-24";
const ago = (days: number) => addDays(TODAY, -days);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.db.execute(
    sql`TRUNCATE ${institutions}, ${accounts}, ${balanceSnapshots}, ${assets}, ${holdings}, ${investmentTransactions}, ${prices}, ${fxRates} CASCADE`,
  );
});

async function account(
  name: string,
  type: "checking" | "savings" | "brokerage" | "crypto",
  institution = name,
) {
  const [bank] = await testDb.db
    .insert(institutions)
    .values({
      name: institution,
      country: "FI",
      provider: type === "brokerage" ? "csv" : "enable_banking",
      providerRef: randomUUID(),
    })
    .returning();
  const [row] = await testDb.db
    .insert(accounts)
    .values({ institutionId: bank.id, type, name, currency: "EUR" })
    .returning();
  return row;
}

async function asset(
  symbol: string,
  assetClass: "stock" | "etf" | "fund" | "crypto",
  currency = "EUR",
) {
  const [row] = await testDb.db
    .insert(assets)
    .values({ symbol, assetClass, currency })
    .returning();
  return row;
}

async function snapshot(accountId: string, daysAgo: number, amount: number) {
  await testDb.db.insert(balanceSnapshots).values({
    accountId,
    date: ago(daysAgo),
    amountMinor: amount,
    currency: "EUR",
    balanceType: "CLBD",
  });
}

async function holding(
  accountId: string,
  assetId: string,
  daysAgo: number,
  quantity: string,
) {
  await testDb.db
    .insert(holdings)
    .values({ accountId, assetId, date: ago(daysAgo), quantity });
}

async function price(
  assetId: string,
  daysAgo: number,
  priceMinor: string,
  currency = "EUR",
) {
  await testDb.db.insert(prices).values({
    assetId,
    date: ago(daysAgo),
    priceMinor,
    currency,
    source: "twelve_data",
  });
}

async function trade(
  accountId: string,
  values: {
    daysAgo: number;
    type: "buy" | "sell" | "dividend" | "fee" | "transfer";
    amountMinor: number;
    assetId?: string;
    quantity?: string;
  },
) {
  await testDb.db.insert(investmentTransactions).values({
    accountId,
    assetId: values.assetId ?? null,
    type: values.type,
    dedupeHash: randomUUID(),
    tradeDate: ago(values.daysAgo),
    quantity: values.quantity ?? null,
    amountMinor: values.amountMinor,
    currency: "EUR",
  });
}

/**
 * A Nordnet-like portfolio without a synced balance: 5 000,00 deposited 60
 * days ago, 100 shares bought at 30,00 50 days ago (the close rises to 40,00
 * 10 days ago) and 10 USD-quoted shares at 20,00 $ 40 days ago.
 */
async function nordnet() {
  const brokerage = await account("Nordnet 1", "brokerage", "Nordnet");
  const stock = await asset("AAA1", "stock");
  const usd = await asset("USX", "etf", "USD");
  await trade(brokerage.id, {
    daysAgo: 60,
    type: "transfer",
    amountMinor: 500_000,
  });
  await trade(brokerage.id, {
    daysAgo: 50,
    type: "buy",
    amountMinor: -300_000,
    assetId: stock.id,
    quantity: "100",
  });
  await trade(brokerage.id, {
    daysAgo: 40,
    type: "buy",
    amountMinor: -18_000,
    assetId: usd.id,
    quantity: "10",
  });
  await holding(brokerage.id, stock.id, 50, "100");
  await holding(brokerage.id, usd.id, 40, "10");
  await price(stock.id, 50, "3000");
  await price(stock.id, 10, "4000");
  await price(usd.id, 40, "2000", "USD");
  // A rate from before the range carries over; a later one replaces it.
  await testDb.db.insert(fxRates).values([
    { date: ago(200), currency: "USD", rate: "1.25" },
    { date: ago(5), currency: "USD", rate: "1" },
  ]);
  return { brokerage, stock, usd };
}

describe("net-worth series with investments", () => {
  it("values the holdings with each day's prices on top of the derived cash", async () => {
    const { brokerage } = await nordnet();
    const checking = await account("Käyttötili", "checking", "Nordea");
    await snapshot(checking.id, 70, 100_000);

    const history = await getBalanceHistory({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
      range: "3m",
    });
    const series = history.accounts.find((a) => a.id === brokerage.id)!;
    const on = (daysAgo: number) =>
      series.points[history.days.indexOf(ago(daysAgo))].amountMinor;
    // Before the deposit nothing is known; then the cash, then cash +
    // shares at the price known each day.
    expect(on(61)).toBeNull();
    expect(on(60)).toBe(500_000);
    expect(on(50)).toBe(200_000 + 300_000);
    // 10 × 20,00 $ / 1,25 = 160,00 €.
    expect(on(40)).toBe(182_000 + 300_000 + 16_000);
    expect(on(10)).toBe(182_000 + 400_000 + 16_000);
    // The rate of 5 days ago: 10 × 20,00 $ / 1.
    expect(on(0)).toBe(182_000 + 400_000 + 20_000);
    expect(series.points.every((point) => !point.estimated)).toBe(true);

    const last = history.days.length - 1;
    expect(history.netWorth[last]).toEqual({
      amountMinor: 100_000 + 602_000,
      estimated: false,
      partial: false,
    });
    // Before the deposit the portfolio is unknown, so net worth is partial.
    expect(history.netWorth[history.days.indexOf(ago(61))].partial).toBe(true);
    expect(history.omitted).toEqual({ withoutBalance: 0, otherCurrency: 0 });
  });

  it("adds a crypto account's synced cash and a manual wallet's holdings", async () => {
    const kraken = await account("Kraken", "crypto");
    const wallet = await account("Ledger", "crypto", "Manual");
    const btc = await asset("BTC", "crypto");
    await snapshot(kraken.id, 20, 10_000);
    await holding(kraken.id, btc.id, 20, "0.1");
    await holding(wallet.id, btc.id, 30, "0.5");
    await holding(wallet.id, btc.id, 3, "0");
    await price(btc.id, 30, "5000000");
    await price(btc.id, 15, "6000000");

    const history = await getBalanceHistory({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
      range: "all",
    });
    // `all` starts at the first holding.
    expect(history.days[0]).toBe(ago(30));
    const points = (id: string) =>
      history.accounts.find((a) => a.id === id)!.points;
    const at = (id: string, daysAgo: number) =>
      points(id)[history.days.indexOf(ago(daysAgo))].amountMinor;
    expect(at(kraken.id, 21)).toBeNull();
    expect(at(kraken.id, 20)).toBe(10_000 + 500_000);
    expect(at(kraken.id, 0)).toBe(10_000 + 600_000);
    expect(at(wallet.id, 30)).toBe(2_500_000);
    expect(at(wallet.id, 15)).toBe(3_000_000);
    // Sold out: known, and 0.
    expect(at(wallet.id, 3)).toBe(0);
  });

  it("counts the daily valuation in the dashboard's net worth and change", async () => {
    const { brokerage } = await nordnet();
    const overview = await getDashboardOverview({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
    });
    expect(overview.totals.netWorth).toEqual({
      amountMinor: 602_000,
      // 30 days ago: 182 000 + 100 × 30,00 + 160,00.
      changeMinor: 602_000 - 498_000,
    });
    const row = overview.banks
      .flatMap((bank) => bank.accounts)
      .find((a) => a.id === brokerage.id)!;
    expect(row).toMatchObject({
      balance: null,
      holdingsMinor: 420_000,
      derivedCashMinor: 182_000,
    });
    expect(row.sparkline.at(-1)).toEqual({ date: TODAY, amountMinor: 602_000 });
    expect(row.sparkline.find((point) => point.date === ago(30))).toEqual({
      date: ago(30),
      amountMinor: 498_000,
    });
  });
});

describe("getAllocation", () => {
  it("breaks today's net worth down by asset class and by account", async () => {
    const { brokerage } = await nordnet();
    const fund = await asset("FUND", "fund");
    const btc = await asset("BTC", "crypto");
    const wallet = await account("Ledger", "crypto", "Manual");
    await holding(wallet.id, btc.id, 3, "0.01");
    await holding(wallet.id, fund.id, 3, "1");
    await price(btc.id, 3, "6000000");
    await price(fund.id, 3, "5000");
    const unpriced = await asset("NOPRICE", "stock");
    await holding(wallet.id, unpriced.id, 3, "5");
    const checking = await account("Käyttötili", "checking", "Nordea");
    await snapshot(checking.id, 2, -20_000);
    const savings = await account("Säästötili", "savings", "Nordea");
    await snapshot(savings.id, 2, 300_000);
    await account("CSV-tili", "checking", "Nordea");

    const allocation = await getAllocation({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
    });
    // Cash: 182 000 derived + 300 000 − 20 000; stocks and ETFs: AAA1
    // 400 000 + USX 20 000; funds 5 000; crypto 60 000.
    const positive = 462_000 + 420_000 + 5_000 + 60_000;
    expect(allocation.classes).toEqual([
      {
        id: "cash",
        label: "Cash",
        valueMinor: 462_000,
        share: 462_000 / positive,
      },
      {
        id: "stocks",
        label: "Stocks and ETFs",
        valueMinor: 420_000,
        share: 420_000 / positive,
      },
      {
        id: "funds",
        label: "Funds",
        valueMinor: 5_000,
        share: 5_000 / positive,
      },
      {
        id: "crypto",
        label: "Crypto",
        valueMinor: 60_000,
        share: 60_000 / positive,
      },
    ]);
    expect(allocation.totalMinor).toBe(positive);
    expect(
      allocation.accounts.map((a) => [a.name, a.cashMinor, a.holdingsMinor]),
    ).toEqual([
      ["Nordnet 1", 182_000, 420_000],
      ["Säästötili", 300_000, 0],
      ["Ledger", 0, 65_000],
      ["Käyttötili", -20_000, 0],
    ]);
    const overdrawn = allocation.accounts.at(-1)!;
    expect(overdrawn.share).toBeNull();
    expect(allocation.accounts[0].id).toBe(brokerage.id);
    expect(allocation.unpriced).toBe(1);
    expect(allocation.omitted).toEqual({ withoutBalance: 1, otherCurrency: 0 });
  });

  it("is empty without balances or holdings", async () => {
    await account("CSV-tili", "checking", "Nordea");
    const allocation = await getAllocation({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
    });
    expect(allocation.empty).toBe(true);
    expect(allocation.classes).toEqual([]);
  });
});

describe("getPortfolioPerformance", () => {
  it("separates contributions from the market gain", async () => {
    await nordnet();
    const wallet = await account("Ledger", "crypto", "Manual");
    const btc = await asset("BTC", "crypto");
    await holding(wallet.id, btc.id, 20, "0.01");
    await price(btc.id, 30, "5000000");
    await price(btc.id, 1, "6000000");
    // Bank accounts are not part of the portfolio.
    const checking = await account("Käyttötili", "checking", "Nordea");
    await snapshot(checking.id, 70, 100_000);

    const report = await getPortfolioPerformance({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
      range: "3m",
    });
    expect(report.accounts.map((a) => a.name)).toEqual(["Ledger", "Nordnet 1"]);
    expect(report.accountId).toBeNull();
    const { performance, days } = report;
    const at = (daysAgo: number) =>
      performance.points[days.indexOf(ago(daysAgo))];
    // The deposit brings the portfolio in: 5 000,00 contributed.
    expect(at(60)).toEqual({
      valueMinor: 500_000,
      contributedMinor: 500_000,
      gainMinor: 0,
    });
    // The buy only moves cash into shares.
    expect(at(50).gainMinor).toBe(0);
    // The wallet's coins come in at 0,01 × 50 000,00.
    expect(at(20).contributedMinor).toBe(550_000);
    expect(performance).toMatchObject({
      // Nothing is known on the range's first day: everything came in.
      startMinor: null,
      // 182 000 + 400 000 + 20 000 + 60 000.
      endMinor: 662_000,
      contributionsMinor: 550_000,
      // AAA1 +100 000, USX +2 000 (bought for 180,00 €), BTC +10 000.
      gainMinor: 112_000,
    });

    const one = await getPortfolioPerformance({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
      range: "1y",
      accountId: wallet.id,
    });
    expect(one.accountId).toBe(wallet.id);
    expect(one.performance).toMatchObject({
      startMinor: null,
      endMinor: 60_000,
      contributionsMinor: 50_000,
      gainMinor: 10_000,
    });

    // From a start within the data, the value then is the baseline.
    const recent = await getPortfolioPerformance({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
      range: "all",
    });
    expect(recent.days[0]).toBe(ago(60));
    expect(recent.performance).toMatchObject({
      startMinor: 500_000,
      contributionsMinor: 50_000,
      gainMinor: 112_000,
    });
  });

  it("counts a holding saved before its first price as contributed once priced", async () => {
    // A manual coin saved 10 days ago; the price job first prices it 9 days
    // ago at 100,00, then 120,00.
    const wallet = await account("Ledger", "crypto", "Manual");
    const coin = await asset("NEWCOIN", "crypto");
    await holding(wallet.id, coin.id, 10, "3");
    await price(coin.id, 9, "10000");
    await price(coin.id, 2, "12000");

    const report = await getPortfolioPerformance({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
      range: "3m",
    });
    const at = (daysAgo: number) =>
      report.performance.points[report.days.indexOf(ago(daysAgo))];
    expect(at(10)).toEqual({
      valueMinor: 0,
      contributedMinor: 0,
      gainMinor: 0,
    });
    expect(at(9)).toEqual({
      valueMinor: 30_000,
      contributedMinor: 30_000,
      gainMinor: 0,
    });
    expect(report.performance).toMatchObject({
      endMinor: 36_000,
      contributionsMinor: 30_000,
      gainMinor: 6_000,
    });
  });

  it("does not stretch `all` back to a synced account's older ledger", async () => {
    const kraken = await account("Kraken", "crypto");
    const btc = await asset("BTC", "crypto");
    await snapshot(kraken.id, 5, 10_000);
    await trade(kraken.id, {
      daysAgo: 400,
      type: "transfer",
      amountMinor: 0,
      assetId: btc.id,
      quantity: "1",
    });
    const [performance, history] = await Promise.all([
      getPortfolioPerformance({
        db: testDb.db,
        now: NOW,
        timeZone: TIME_ZONE,
        range: "all",
      }),
      getBalanceHistory({
        db: testDb.db,
        now: NOW,
        timeZone: TIME_ZONE,
        range: "all",
      }),
    ]);
    expect(performance.days[0]).toBe(ago(5));
    expect(history.days[0]).toBe(ago(5));
    expect(performance.accounts.map((a) => a.id)).toEqual([kraken.id]);
  });

  it("ignores an unknown account id and is empty without investments", async () => {
    const report = await getPortfolioPerformance({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
      range: "3m",
      accountId: randomUUID(),
    });
    expect(report.accountId).toBeNull();
    expect(report.accounts).toEqual([]);
    expect(report.empty).toBe(true);
    expect(report.days.at(-1)).toBe(TODAY);
  });
});
