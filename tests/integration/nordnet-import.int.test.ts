import { readFileSync } from "node:fs";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeCsv } from "@/server/csv/values";
import {
  accounts,
  assets,
  fxRates,
  holdings,
  institutions,
  investmentTransactions,
  prices,
} from "@/server/db/schema";
import {
  importNordnetCsv,
  TRADE_PRICE_SOURCE,
} from "@/server/investments/import-nordnet";
import { readNordnetCsv } from "@/server/investments/nordnet-csv";
import {
  PriceApiError,
  TWELVE_DATA_SOURCE,
  type PriceClient,
  type PriceQuery,
} from "@/server/investments/price-client";
import { updatePrices } from "@/server/investments/update-prices";
import { getDashboardOverview } from "@/server/queries/dashboard";
import { getInvestmentsOverview } from "@/server/queries/investments";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// The Nordnet import against a real Postgres 18: accounts per portfolio,
// assets, deduped transactions, holdings derived from them (also when an
// older export arrives after a newer one), the price update with a mocked
// price API and ECB file, and the valued holdings on /investments and in
// net worth. Each test uses its own portfolio number, so accounts are apart.

const FIXTURE = "tests/fixtures/nordnet/transactions-utf16.csv";
const FIXTURE_PORTFOLIO = "99990001";
const TODAY = "2026-10-24";
const NOW = new Date(`${TODAY}T09:00:00Z`);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

const fixtureLines = decodeCsv(readFileSync(FIXTURE))
  .text.trimEnd()
  .split("\r\n");

/**
 * The fixture as UTF-8 for `portfolio`, with only the rows whose Id passes
 * `keep`, optionally with every Id replaced (a re-export with new ids).
 */
function exportOf(
  portfolio: string,
  options: { keep?: (id: number) => boolean; newIds?: boolean } = {},
): Uint8Array {
  const [header, ...rows] = fixtureLines;
  const kept = rows
    .filter((line) => options.keep?.(Number(line.split("\t")[0])) ?? true)
    .map((line) => {
      const cells = line.split("\t");
      cells[4] = portfolio;
      if (options.newIds) cells[0] = `9${cells[0]}`;
      return cells.join("\t");
    });
  return new TextEncoder().encode([header, ...kept].join("\n"));
}

async function importFile(bytes: Uint8Array) {
  return importNordnetCsv(readNordnetCsv(bytes), { db: testDb.db });
}

async function accountOf(portfolio: string) {
  const rows = await testDb.db
    .select()
    .from(accounts)
    .where(eq(accounts.providerAccountRef, portfolio));
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function holdingsOf(accountId: string) {
  return testDb.db
    .select({
      symbol: assets.symbol,
      date: holdings.date,
      quantity: holdings.quantity,
    })
    .from(holdings)
    .innerJoin(assets, eq(holdings.assetId, assets.id))
    .where(eq(holdings.accountId, accountId))
    .orderBy(asc(assets.symbol), asc(holdings.date));
}

const FULL_HOLDINGS = [
  { symbol: "AAA1", date: "2026-01-05", quantity: "100.000000000000000000" },
  { symbol: "AAA1", date: "2026-03-02", quantity: "60.000000000000000000" },
  { symbol: "AAA1", date: "2026-04-07", quantity: "80.000000000000000000" },
  {
    symbol: "NORDNET INDEKSI ESIM",
    date: "2026-01-05",
    quantity: "3.235000000000000000",
  },
  { symbol: "USX", date: "2026-02-10", quantity: "10.000000000000000000" },
];

describe("importNordnetCsv", () => {
  it("creates the portfolio's brokerage account, its assets, transactions and holdings", async () => {
    const summary = await importFile(readFileSync(FIXTURE));
    expect(summary).toMatchObject({
      rowsRead: 13,
      inserted: 11,
      duplicates: 0,
      errors: [],
      oversold: [],
    });
    expect(summary.skipped.map((s) => s.row)).toEqual([4, 5]);

    const account = await accountOf(FIXTURE_PORTFOLIO);
    expect(account).toMatchObject({
      type: "brokerage",
      name: `Nordnet ${FIXTURE_PORTFOLIO}`,
      currency: "EUR",
      connectionId: null,
      archived: false,
    });
    expect(summary.accounts).toEqual([
      {
        id: account.id,
        name: account.name,
        created: true,
        inserted: 11,
        duplicates: 0,
      },
    ]);
    const [institution] = await testDb.db
      .select()
      .from(institutions)
      .where(eq(institutions.id, account.institutionId));
    expect(institution).toMatchObject({
      name: "Nordnet",
      provider: "csv",
      providerRef: "nordnet",
    });

    expect(
      await testDb.db
        .select({
          symbol: assets.symbol,
          isin: assets.isin,
          assetClass: assets.assetClass,
          currency: assets.currency,
        })
        .from(assets)
        .orderBy(asc(assets.symbol)),
    ).toEqual([
      {
        symbol: "AAA1",
        isin: "FI4000000011",
        assetClass: "stock",
        currency: "EUR",
      },
      {
        symbol: "NORDNET INDEKSI ESIM",
        isin: "IE0000000019",
        assetClass: "fund",
        currency: "EUR",
      },
      {
        symbol: "USX",
        isin: "US0000000018",
        assetClass: "stock",
        currency: "USD",
      },
    ]);

    const stored = await testDb.db
      .select()
      .from(investmentTransactions)
      .where(eq(investmentTransactions.accountId, account.id))
      .orderBy(asc(investmentTransactions.providerTxnRef));
    expect(
      stored.map((t) => [t.providerTxnRef, t.type, t.amountMinor]),
    ).toEqual([
      ["1001", "transfer", 500_000],
      ["1002", "buy", -125_900],
      ["1003", "buy", -44_003],
      ["1004", "buy", -47_000],
      ["1005", "sell", 55_100],
      ["1006", "dividend", 3_000],
      ["1007", "fee", -750],
      ["1008", "fee", -200],
      ["1009", "transfer", -50_000],
      ["1012", "buy", -13_900],
      ["1013", "buy", -13_900],
    ]);
    expect(stored.find((t) => t.providerTxnRef === "1001")?.assetId).toBeNull();
    expect(stored.find((t) => t.providerTxnRef === "1005")).toMatchObject({
      tradeDate: "2026-03-02",
      quantity: "-40.000000000000000000",
      description: "MYYNTI · Myyty",
    });

    expect(await holdingsOf(account.id)).toEqual(FULL_HOLDINGS);

    // The trades' unit prices, one per asset and day.
    expect(
      await testDb.db
        .select({
          symbol: assets.symbol,
          date: prices.date,
          priceMinor: prices.priceMinor,
          currency: prices.currency,
          source: prices.source,
        })
        .from(prices)
        .innerJoin(assets, eq(prices.assetId, assets.id))
        .orderBy(asc(assets.symbol), asc(prices.date)),
    ).toEqual(
      [
        ["AAA1", "2026-01-05", "1250", "EUR"],
        ["AAA1", "2026-03-02", "1400", "EUR"],
        ["AAA1", "2026-04-07", "1300", "EUR"],
        ["NORDNET INDEKSI ESIM", "2026-01-05", "13602.3", "EUR"],
        ["USX", "2026-02-10", "5000", "USD"],
      ].map(([symbol, date, price, currency]) => ({
        symbol,
        date,
        priceMinor: `${price}${price.includes(".") ? "00000000000000000" : ".000000000000000000"}`,
        currency,
        source: TRADE_PRICE_SOURCE,
      })),
    );
  });

  it("adds nothing when the same export is imported again", async () => {
    const before = await testDb.db.select().from(investmentTransactions);
    const summary = await importFile(readFileSync(FIXTURE));
    expect(summary).toMatchObject({ inserted: 0, duplicates: 11 });
    expect(summary.accounts[0].created).toBe(false);
    expect(await testDb.db.select().from(investmentTransactions)).toHaveLength(
      before.length,
    );
    const account = await accountOf(FIXTURE_PORTFOLIO);
    expect(await holdingsOf(account.id)).toEqual(FULL_HOLDINGS);
    expect(await testDb.db.select().from(assets)).toHaveLength(3);
  });

  it("dedupes an overlapping re-export with new ids by the row hash", async () => {
    const portfolio = "99990002";
    await importFile(exportOf(portfolio, { keep: (id) => id <= 1006 }));
    const summary = await importFile(exportOf(portfolio, { newIds: true }));
    // 1001–1006 are stored already; 1007–1013 minus the two skipped are new.
    expect(summary).toMatchObject({ inserted: 5, duplicates: 6 });
    const account = await accountOf(portfolio);
    expect(
      await testDb.db
        .select()
        .from(investmentTransactions)
        .where(eq(investmentTransactions.accountId, account.id)),
    ).toHaveLength(11);
    expect(await holdingsOf(account.id)).toEqual(FULL_HOLDINGS);
  });

  it("keeps two identical trades of one day as two rows", async () => {
    const portfolio = "99990003";
    const once = exportOf(portfolio, { keep: (id) => id === 1012 });
    const twice = exportOf(portfolio, { keep: (id) => id >= 1012 });
    expect((await importFile(once)).inserted).toBe(1);
    // The second identical buy is new; the first is a duplicate, although
    // the export lists the newer one first.
    expect(await importFile(twice)).toMatchObject({
      inserted: 1,
      duplicates: 1,
    });
  });

  it("corrects holdings when an older export arrives after a newer one", async () => {
    const portfolio = "99990004";
    const newer = await importFile(
      exportOf(portfolio, { keep: (id) => id >= 1005 }),
    );
    expect(newer.oversold).toEqual(["AAA1"]);
    const account = await accountOf(portfolio);
    expect(await holdingsOf(account.id)).toEqual([
      { symbol: "AAA1", date: "2026-03-02", quantity: "0.000000000000000000" },
      { symbol: "AAA1", date: "2026-04-07", quantity: "20.000000000000000000" },
    ]);

    const older = await importFile(
      exportOf(portfolio, { keep: (id) => id < 1005 }),
    );
    expect(older).toMatchObject({ inserted: 4, oversold: [] });
    expect(await holdingsOf(account.id)).toEqual(FULL_HOLDINGS);
  });

  it("writes nothing when a row fails to insert", async () => {
    const portfolio = "99990005";
    const parsed = readNordnetCsv(exportOf(portfolio));
    parsed.rows[1] = { ...parsed.rows[1], currency: "EURO" };
    await expect(importNordnetCsv(parsed, { db: testDb.db })).rejects.toThrow();
    expect(
      await testDb.db
        .select()
        .from(accounts)
        .where(eq(accounts.providerAccountRef, portfolio)),
    ).toEqual([]);
  });
});

/** A mocked price API: closes by symbol; a missing symbol is unknown. */
function mockClient(
  closes: Record<string, { date: string; close: string; currency: string }>,
  calls: PriceQuery[] = [],
): PriceClient {
  return {
    async getClosingPrice(query) {
      calls.push(query);
      return closes[query.symbol] ?? null;
    },
  };
}

const ECB = async () => ({
  date: "2026-10-23",
  rates: [
    { currency: "USD", rate: "1.1" },
    { currency: "SEK", rate: "11.5" },
  ],
});

describe("updatePrices", () => {
  it("stores the ECB rates and a close per held security, reporting unknown symbols", async () => {
    // A security nobody holds any more is not priced, and crypto is not
    // asked of the stock price API (CoinGecko prices it, F-021; see
    // crypto-holdings.int.test.ts).
    const [account] = await testDb.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.providerAccountRef, FIXTURE_PORTFOLIO));
    const [soldOut, coin] = await testDb.db
      .insert(assets)
      .values([
        {
          symbol: "GONE",
          isin: "FI0000000099",
          assetClass: "stock",
          currency: "EUR",
        },
        {
          symbol: "BTC",
          coingeckoId: "bitcoin",
          assetClass: "crypto",
          currency: "EUR",
        },
      ])
      .returning({ id: assets.id });
    await testDb.db.insert(holdings).values([
      {
        accountId: account.id,
        assetId: soldOut.id,
        date: "2026-01-01",
        quantity: "5",
      },
      {
        accountId: account.id,
        assetId: soldOut.id,
        date: "2026-02-01",
        quantity: "0",
      },
      {
        accountId: account.id,
        assetId: coin.id,
        date: "2026-01-01",
        quantity: "0.5",
      },
    ]);

    const calls: PriceQuery[] = [];
    const result = await updatePrices({
      db: testDb.db,
      cryptoClient: null,
      fetchRates: ECB,
      client: mockClient(
        {
          AAA1: { date: "2026-10-22", close: "15", currency: "EUR" },
          USX: { date: "2026-10-22", close: "55.5", currency: "USD" },
        },
        calls,
      ),
    });
    expect(result).toEqual({
      fxDate: "2026-10-23",
      fxRates: 2,
      prices: 2,
      unknown: ["NORDNET INDEKSI ESIM"],
      problems: [],
    });
    expect(calls.map((c) => c.symbol)).toEqual([
      "AAA1",
      "NORDNET INDEKSI ESIM",
      "USX",
    ]);
    expect(calls[0]).toEqual({
      symbol: "AAA1",
      isin: "FI4000000011",
      currency: "EUR",
    });

    const stored = await testDb.db
      .select({ priceMinor: prices.priceMinor, source: prices.source })
      .from(prices)
      .innerJoin(assets, eq(prices.assetId, assets.id))
      .where(and(eq(assets.symbol, "USX"), eq(prices.date, "2026-10-22")));
    expect(stored).toEqual([
      { priceMinor: "5550.000000000000000000", source: TWELVE_DATA_SOURCE },
    ]);
    expect(
      await testDb.db
        .select({ currency: fxRates.currency, rate: fxRates.rate })
        .from(fxRates)
        .orderBy(asc(fxRates.currency)),
    ).toEqual([
      { currency: "SEK", rate: "11.500000000000000000" },
      { currency: "USD", rate: "1.100000000000000000" },
    ]);
  });

  it("overwrites a same-day price and rate on a re-run, and a trade price too", async () => {
    // A trade price of the day gives way to the closing price.
    const [usx] = await testDb.db
      .select()
      .from(assets)
      .where(eq(assets.symbol, "USX"));
    await testDb.db.insert(prices).values({
      assetId: usx.id,
      date: "2026-10-21",
      priceMinor: "1",
      currency: "USD",
      source: TRADE_PRICE_SOURCE,
    });
    const result = await updatePrices({
      db: testDb.db,
      cryptoClient: null,
      fetchRates: async () => ({
        date: "2026-10-23",
        rates: [{ currency: "USD", rate: "1.2" }],
      }),
      client: mockClient({
        AAA1: { date: "2026-10-22", close: "15", currency: "EUR" },
        USX: { date: "2026-10-21", close: "50", currency: "USD" },
      }),
    });
    expect(result.prices).toBe(2);
    const usxPrices = await testDb.db
      .select({
        date: prices.date,
        priceMinor: prices.priceMinor,
        source: prices.source,
      })
      .from(prices)
      .where(eq(prices.assetId, usx.id))
      .orderBy(asc(prices.date));
    expect(usxPrices.slice(-2)).toEqual([
      {
        date: "2026-10-21",
        priceMinor: "5000.000000000000000000",
        source: TWELVE_DATA_SOURCE,
      },
      {
        date: "2026-10-22",
        priceMinor: "5550.000000000000000000",
        source: TWELVE_DATA_SOURCE,
      },
    ]);
    const [rate] = await testDb.db
      .select({ rate: fxRates.rate })
      .from(fxRates)
      .where(and(eq(fxRates.currency, "USD"), eq(fxRates.date, "2026-10-23")));
    expect(rate.rate).toBe("1.200000000000000000");
    // Back to 1.1 for the valuation below.
    await updatePrices({
      db: testDb.db,
      fetchRates: ECB,
      client: null,
      cryptoClient: null,
    });
  });

  it("stops at an API that refuses and still stores the rates; skips prices without a key", async () => {
    const refusing: PriceClient = {
      async getClosingPrice() {
        throw new PriceApiError(
          "daily_limit",
          "The daily limit of 800 price requests is used up",
        );
      },
    };
    const stopped = await updatePrices({
      db: testDb.db,
      cryptoClient: null,
      fetchRates: ECB,
      client: refusing,
    });
    expect(stopped).toMatchObject({ fxRates: 2, prices: 0 });
    expect(stopped.problems).toEqual([
      "Stock prices stopped at AAA1: The daily limit of 800 price requests is used up",
    ]);

    const noKey = await updatePrices({
      db: testDb.db,
      cryptoClient: null,
      fetchRates: async () => {
        throw new PriceApiError(
          "unavailable",
          "The ECB responded with HTTP 503",
        );
      },
      client: null,
    });
    expect(noKey).toEqual({
      fxDate: null,
      fxRates: 0,
      prices: 0,
      unknown: [],
      problems: [
        "FX rates: The ECB responded with HTTP 503",
        "Stock prices: PRICE_API_KEY is not set",
      ],
    });
  });
});

describe("valued holdings", () => {
  it("lists quantity, price, value, gain and weight per holding", async () => {
    const account = await accountOf(FIXTURE_PORTFOLIO);
    const overview = await getInvestmentsOverview(TODAY, { db: testDb.db });
    const own = overview.holdings.filter((h) => h.accountId === account.id);
    // AAA1 80 × 15,00 = 1 200,00 against 1 033,40; USX 10 × 55,50 USD / 1,1
    // = 504,55 against 470,00; the fund at its trade price 136,023:
    // 3,235 × 136,023 = 440,03 against 440,03.
    expect(
      own.map((h) => ({
        symbol: h.symbol,
        quantity: h.quantity,
        price: h.price && [
          h.price.priceMinor,
          h.price.currency,
          h.price.date,
          h.price.source,
        ],
        valueMinor: h.valueMinor,
        costMinor: h.costMinor,
        gainMinor: h.gainMinor,
      })),
    ).toEqual([
      {
        symbol: "AAA1",
        quantity: "80.000000000000000000",
        price: [
          "1500.000000000000000000",
          "EUR",
          "2026-10-22",
          TWELVE_DATA_SOURCE,
        ],
        valueMinor: 120_000,
        costMinor: 103_340,
        gainMinor: 16_660,
      },
      {
        symbol: "USX",
        quantity: "10.000000000000000000",
        price: [
          "5550.000000000000000000",
          "USD",
          "2026-10-22",
          TWELVE_DATA_SOURCE,
        ],
        valueMinor: 50_455,
        costMinor: 47_000,
        gainMinor: 3_455,
      },
      {
        symbol: "NORDNET INDEKSI ESIM",
        quantity: "3.235000000000000000",
        price: [
          "13602.300000000000000000",
          "EUR",
          "2026-01-05",
          TRADE_PRICE_SOURCE,
        ],
        valueMinor: 44_003,
        costMinor: 44_003,
        gainMinor: 0,
      },
      {
        symbol: "BTC",
        quantity: "0.500000000000000000",
        price: null,
        valueMinor: null,
        costMinor: null,
        gainMinor: null,
      },
    ]);
    expect(own[0].gainShare).toBeCloseTo(16_660 / 103_340, 10);
    const weights = overview.holdings.map((h) => h.weight ?? 0);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(own[0].weight).toBeCloseTo(120_000 / overview.valueMinor, 10);
    expect(overview.complete).toBe(false); // BTC has no price.
    expect(overview.holdings.find((h) => h.symbol === "BTC")).toMatchObject({
      valueMinor: null,
      missing: "price",
      weight: null,
    });
    expect(overview.holdings.some((h) => h.symbol === "GONE")).toBe(false);
  });

  it("counts the holdings in net worth on the dashboard", async () => {
    const account = await accountOf(FIXTURE_PORTFOLIO);
    const overview = await getDashboardOverview({
      db: testDb.db,
      now: NOW,
      timeZone: "Europe/Helsinki",
    });
    const investments = await getInvestmentsOverview(TODAY, { db: testDb.db });
    expect(overview.totals.netWorth.amountMinor).toBe(investments.valueMinor);
    // Three accounts hold the full fixture (2 144,58 € each) and one only
    // the two AAA1 lots of 7.4. (20 × 15,00).
    expect(investments.valueMinor).toBe(3 * 214_458 + 30_000);
    const nordnet = overview.banks.find((b) => b.name === "Nordnet");
    const summary = nordnet?.accounts.find((a) => a.id === account.id);
    expect(summary).toMatchObject({ balance: null, holdingsMinor: 214_458 });
    // 30 days ago (24.9.) the same units were valued with the prices known
    // then: AAA1 at its 7.4. trade price 13,00, the fund at 136,023 and USX
    // unvalued (no USD rate before 23.10.): 80 × 13,00 + 440,03 = 1 480,03 €
    // per full account, 20 × 13,00 for the other.
    expect(overview.totals.netWorth.changeMinor).toBe(
      3 * (214_458 - 148_003) + (30_000 - 26_000),
    );
  });
});

describe("asset currency", () => {
  const HEADER =
    "Id;Kauppapäivä;Salkku;Tapahtumatyyppi;Arvopaperi;ISIN;Määrä;Kurssi;Kokonaiskulut;Valuutta;Summa;Valuutta";
  const TAX =
    "22;2026-05-15;99990006;LÄHDEVERO;USY;US0000000026;10;;;;-1,50;EUR";
  const BUY =
    "21;2026-02-10;99990006;OSTO;USY;US0000000026;10;20,00;1,00;USD;-190,00;EUR";
  const csv = (...lines: string[]) =>
    new TextEncoder().encode([HEADER, ...lines].join("\n"));
  const usy = async () => {
    const [asset] = await testDb.db
      .select({ currency: assets.currency })
      .from(assets)
      .where(eq(assets.isin, "US0000000026"));
    return asset?.currency;
  };

  it("takes the quote currency from the buy even when a tax row comes first", async () => {
    // Nordnet lists newest first: the EUR tax row precedes the USD buy.
    await importFile(csv(TAX, BUY));
    expect(await usy()).toBe("USD");
  });

  it("corrects a currency guessed from a tax row once the buy is imported", async () => {
    await testDb.db
      .update(assets)
      .set({ currency: "EUR" })
      .where(eq(assets.isin, "US0000000026"));
    // A newer export with only the tax row keeps the guess…
    await importFile(csv(TAX.replace("22;2026-05-15", "23;2026-08-15")));
    expect(await usy()).toBe("EUR");
    // …and an export with the buy corrects it.
    await importFile(csv(BUY));
    expect(await usy()).toBe("USD");
  });
});
