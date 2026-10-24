import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  assets,
  fxRates,
  holdings,
  institutions,
  investmentTransactions,
  prices,
} from "@/server/db/schema";
import { getAccountValuation } from "@/server/queries/investments";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

/** The Postgres error behind a failed Drizzle query (Drizzle wraps it in `cause`). */
async function pgError(query: Promise<unknown>) {
  const error: unknown = await query.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected the query to fail").toBeInstanceOf(Error);
  const cause = (error as Error).cause ?? error;
  return cause as { code?: string; constraint_name?: string };
}

let counter = 0;

async function createAccount(type: "brokerage" | "crypto" = "brokerage") {
  counter += 1;
  const [institution] = await testDb.db
    .insert(institutions)
    .values({
      name: `Broker ${counter}`,
      country: "FI",
      provider: "csv",
      providerRef: `broker-${counter}`,
    })
    .returning();
  const [account] = await testDb.db
    .insert(accounts)
    .values({
      institutionId: institution!.id,
      type,
      name: `Account ${counter}`,
      currency: "EUR",
    })
    .returning();
  return account!;
}

async function createAsset(
  overrides: Partial<typeof assets.$inferInsert> = {},
) {
  counter += 1;
  const [asset] = await testDb.db
    .insert(assets)
    .values({
      symbol: `SYM${counter}`,
      assetClass: "stock",
      currency: "EUR",
      ...overrides,
    })
    .returning();
  return asset!;
}

const INVESTMENT_TABLES = [
  "assets",
  "fx_rates",
  "holdings",
  "investment_transactions",
  "prices",
];

describe("investment migration", () => {
  it("creates the investment tables and enums", async () => {
    const tables = await testDb.db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name in ${INVESTMENT_TABLES}
      order by table_name
    `);
    expect(tables.map((t) => t.table_name)).toEqual(INVESTMENT_TABLES);

    const enums = await testDb.db.execute<{ name: string; values: string }>(
      sql`
        select t.typname as name,
               string_agg(e.enumlabel, ',' order by e.enumsortorder) as values
        from pg_type t join pg_enum e on e.enumtypid = t.oid
        where t.typname in ('asset_class', 'investment_transaction_type')
        group by t.typname order by t.typname
      `,
    );
    expect(enums).toEqual([
      { name: "asset_class", values: "stock,etf,fund,crypto,other" },
      {
        name: "investment_transaction_type",
        values: "buy,sell,dividend,fee,transfer",
      },
    ]);
  });

  it("stores quantities, unit prices and rates as numeric(38, 18) and money as bigint minor units", async () => {
    const columns = await testDb.db.execute<{
      key: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(sql`
      select table_name || '.' || column_name as key, data_type,
             numeric_precision, numeric_scale
      from information_schema.columns
      where table_schema = 'public' and table_name in ${INVESTMENT_TABLES}
        and column_name in ('quantity', 'price_minor', 'rate', 'amount_minor')
      order by key
    `);
    expect(
      Object.fromEntries(
        columns.map((c) => [
          c.key,
          c.data_type === "numeric"
            ? `numeric(${c.numeric_precision}, ${c.numeric_scale})`
            : c.data_type,
        ]),
      ),
    ).toEqual({
      "fx_rates.rate": "numeric(38, 18)",
      "holdings.quantity": "numeric(38, 18)",
      "investment_transactions.amount_minor": "bigint",
      "investment_transactions.quantity": "numeric(38, 18)",
      "prices.price_minor": "numeric(38, 18)",
    });
  });

  it("reuses accounts for brokerage and crypto accounts", async () => {
    const brokerage = await createAccount("brokerage");
    const crypto = await createAccount("crypto");
    const asset = await createAsset({
      symbol: "BTC",
      coingeckoId: "bitcoin",
      assetClass: "crypto",
    });
    await testDb.db.insert(holdings).values([
      {
        accountId: brokerage.id,
        assetId: asset.id,
        date: "2026-10-01",
        quantity: "1",
      },
      {
        accountId: crypto.id,
        assetId: asset.id,
        date: "2026-10-01",
        quantity: "2",
      },
    ]);
    const rows = await testDb.db
      .select({ type: accounts.type, quantity: holdings.quantity })
      .from(holdings)
      .innerJoin(accounts, eq(accounts.id, holdings.accountId))
      .where(eq(holdings.assetId, asset.id))
      .orderBy(accounts.type);
    expect(rows).toEqual([
      { type: "brokerage", quantity: "1.000000000000000000" },
      { type: "crypto", quantity: "2.000000000000000000" },
    ]);
  });
});

describe("numeric quantities", () => {
  const EXACT = [
    "0.000000000000000001",
    "0.123456789012345678",
    "12345678901234567890.123456789012345678",
  ];

  it("keep 18 decimals in holdings", async () => {
    const account = await createAccount();
    const inserted = [];
    for (const [index, quantity] of EXACT.entries()) {
      const asset = await createAsset();
      inserted.push(asset.id);
      await testDb.db.insert(holdings).values({
        accountId: account.id,
        assetId: asset.id,
        date: `2026-10-0${index + 1}`,
        quantity,
      });
    }
    const rows = await testDb.db
      .select({ quantity: holdings.quantity })
      .from(holdings)
      .where(eq(holdings.accountId, account.id))
      .orderBy(holdings.date);
    expect(rows.map((r) => r.quantity)).toEqual([
      "0.000000000000000001",
      "0.123456789012345678",
      "12345678901234567890.123456789012345678",
    ]);
    // Exact in SQL too: no float on the way.
    const [sum] = await testDb.db.execute<{ total: string }>(sql`
      select sum(quantity)::text as total from holdings
      where account_id = ${account.id}
    `);
    expect(sum!.total).toBe("12345678901234567890.246913578024691357");
  });

  it("keep 18 decimals in investment transactions, prices and FX rates", async () => {
    const account = await createAccount("crypto");
    const asset = await createAsset({ symbol: "ETH", assetClass: "crypto" });
    const [txn] = await testDb.db
      .insert(investmentTransactions)
      .values({
        accountId: account.id,
        assetId: asset.id,
        type: "sell",
        dedupeHash: "sell-1",
        tradeDate: "2026-10-01",
        quantity: "-0.123456789012345678",
        amountMinor: -1_234_567_890_123,
        currency: "EUR",
      })
      .returning();
    expect(txn!.quantity).toBe("-0.123456789012345678");
    expect(txn!.amountMinor).toBe(-1_234_567_890_123);

    const [priceRow] = await testDb.db
      .insert(prices)
      .values({
        assetId: asset.id,
        date: "2026-10-01",
        priceMinor: "0.000000123456789012",
        currency: "EUR",
        source: "manual",
      })
      .returning();
    expect(priceRow!.priceMinor).toBe("0.000000123456789012");

    const [rateRow] = await testDb.db
      .insert(fxRates)
      .values({
        date: "2026-10-01",
        currency: "JPY",
        rate: "161.123456789012345678",
      })
      .returning();
    expect(rateRow!.rate).toBe("161.123456789012345678");
  });

  it("reject a negative holding quantity", async () => {
    const account = await createAccount();
    const asset = await createAsset();
    const error = await pgError(
      testDb.db.insert(holdings).values({
        accountId: account.id,
        assetId: asset.id,
        date: "2026-10-01",
        quantity: "-1",
      }),
    );
    expect(error.code).toBe("23514");
    expect(error.constraint_name).toBe("holdings_quantity_not_negative");
  });
});

describe("investment constraints", () => {
  it("allow one holding snapshot per account, asset and day", async () => {
    const account = await createAccount();
    const asset = await createAsset();
    const row = {
      accountId: account.id,
      assetId: asset.id,
      date: "2026-10-01",
      quantity: "1",
    };
    await testDb.db.insert(holdings).values(row);
    await testDb.db
      .insert(holdings)
      .values({ ...row, date: "2026-10-02", quantity: "2" });

    const error = await pgError(
      testDb.db.insert(holdings).values({ ...row, quantity: "3" }),
    );
    expect(error.code).toBe("23505");
    expect(error.constraint_name).toBe(
      "holdings_account_id_asset_id_date_unique",
    );
  });

  it("allow one price per asset and day and one rate per currency and day", async () => {
    const asset = await createAsset();
    const priceRow = {
      assetId: asset.id,
      date: "2026-10-01",
      priceMinor: "100",
      currency: "EUR",
      source: "manual",
    };
    await testDb.db.insert(prices).values(priceRow);
    expect(
      (await pgError(testDb.db.insert(prices).values(priceRow)))
        .constraint_name,
    ).toBe("prices_asset_id_date_unique");

    const rateRow = { date: "2026-09-30", currency: "SEK", rate: "11.5" };
    await testDb.db.insert(fxRates).values(rateRow);
    expect(
      (await pgError(testDb.db.insert(fxRates).values(rateRow)))
        .constraint_name,
    ).toBe("fx_rates_date_currency_unique");
    expect(
      (
        await pgError(
          testDb.db
            .insert(fxRates)
            .values({ date: "2026-09-30", currency: "NOK", rate: "0" }),
        )
      ).constraint_name,
    ).toBe("fx_rates_rate_positive");
  });

  it("identify assets by ISIN or CoinGecko id, many without either", async () => {
    await createAsset({ symbol: "NOKIA", isin: "FI0009000681" });
    await createAsset({ symbol: "SOL", coingeckoId: "solana" });
    await createAsset({ symbol: "MANUAL1" });
    await createAsset({ symbol: "MANUAL2" });

    expect(
      (await pgError(createAsset({ symbol: "NOKIA2", isin: "FI0009000681" })))
        .constraint_name,
    ).toBe("assets_isin_unique");
    expect(
      (await pgError(createAsset({ symbol: "SOL2", coingeckoId: "solana" })))
        .constraint_name,
    ).toBe("assets_coingecko_id_unique");
  });

  it("dedupe investment transactions per account", async () => {
    const account = await createAccount();
    const other = await createAccount();
    const row = {
      accountId: account.id,
      type: "dividend" as const,
      providerTxnRef: "L-1",
      dedupeHash: "dividend-1",
      tradeDate: "2026-10-01",
      amountMinor: 1_250,
      currency: "EUR",
    };
    await testDb.db.insert(investmentTransactions).values(row);

    expect(
      (
        await pgError(
          testDb.db
            .insert(investmentTransactions)
            .values({ ...row, dedupeHash: "dividend-2" }),
        )
      ).constraint_name,
    ).toBe("investment_transactions_account_id_provider_txn_ref_unique");
    expect(
      (
        await pgError(
          testDb.db
            .insert(investmentTransactions)
            .values({ ...row, providerTxnRef: null }),
        )
      ).constraint_name,
    ).toBe("investment_transactions_account_id_dedupe_hash_unique");
    await expect(
      testDb.db
        .insert(investmentTransactions)
        .values({ ...row, accountId: other.id }),
    ).resolves.toBeDefined();
  });

  it("delete an account's holdings and transactions with it, but never an asset in use", async () => {
    const account = await createAccount();
    const asset = await createAsset();
    await testDb.db.insert(holdings).values({
      accountId: account.id,
      assetId: asset.id,
      date: "2026-10-01",
      quantity: "1",
    });
    await testDb.db.insert(investmentTransactions).values({
      accountId: account.id,
      assetId: asset.id,
      type: "buy",
      dedupeHash: "buy-1",
      tradeDate: "2026-10-01",
      quantity: "1",
      amountMinor: -10_000,
      currency: "EUR",
    });

    expect(
      (await pgError(testDb.db.delete(assets).where(eq(assets.id, asset.id))))
        .code,
    ).toBe("23001"); // restrict_violation

    await testDb.db.delete(accounts).where(eq(accounts.id, account.id));
    const [left] = await testDb.db.execute<{ h: number; t: number }>(sql`
      select (select count(*)::int from holdings where account_id = ${account.id}) as h,
             (select count(*)::int from investment_transactions where account_id = ${account.id}) as t
    `);
    expect(left).toEqual({ h: 0, t: 0 });
  });
});

describe("getAccountValuation()", () => {
  it("values an account's holdings in EUR from stored quantities, prices and ECB rates", async () => {
    const account = await createAccount();
    const other = await createAccount();
    const nokia = await createAsset({ symbol: "NOKIA", currency: "EUR" });
    const apple = await createAsset({ symbol: "AAPL", currency: "USD" });
    const sold = await createAsset({ symbol: "SOLD" });

    await testDb.db.insert(holdings).values([
      {
        accountId: account.id,
        assetId: nokia.id,
        date: "2026-09-01",
        quantity: "100",
      },
      {
        accountId: account.id,
        assetId: nokia.id,
        date: "2026-10-05",
        quantity: "120",
      },
      {
        accountId: account.id,
        assetId: nokia.id,
        date: "2026-10-20",
        quantity: "999",
      },
      {
        accountId: account.id,
        assetId: apple.id,
        date: "2026-09-01",
        quantity: "10.5",
      },
      {
        accountId: account.id,
        assetId: sold.id,
        date: "2026-09-01",
        quantity: "5",
      },
      {
        accountId: account.id,
        assetId: sold.id,
        date: "2026-10-01",
        quantity: "0",
      },
      {
        accountId: other.id,
        assetId: nokia.id,
        date: "2026-09-01",
        quantity: "1000",
      },
    ]);
    await testDb.db.insert(prices).values([
      {
        assetId: nokia.id,
        date: "2026-10-15",
        priceMinor: "400",
        currency: "EUR",
        source: "manual",
      },
      // Friday's close; the valuation day is a Sunday.
      {
        assetId: nokia.id,
        date: "2026-10-16",
        priceMinor: "423.5",
        currency: "EUR",
        source: "manual",
      },
      {
        assetId: nokia.id,
        date: "2026-10-19",
        priceMinor: "1",
        currency: "EUR",
        source: "manual",
      },
      {
        assetId: apple.id,
        date: "2026-10-16",
        priceMinor: "18999",
        currency: "USD",
        source: "manual",
      },
      {
        assetId: sold.id,
        date: "2026-10-16",
        priceMinor: "100",
        currency: "EUR",
        source: "manual",
      },
    ]);
    await testDb.db.insert(fxRates).values([
      { date: "2026-10-15", currency: "USD", rate: "1.2" },
      { date: "2026-10-16", currency: "USD", rate: "1.085" },
      { date: "2026-10-19", currency: "USD", rate: "2" },
    ]);

    const valuation = await getAccountValuation(account.id, "2026-10-18", {
      db: testDb.db,
    });

    // 120 × 4.235 € = 508.20 €; 10.5 × 189.99 USD / 1.085 = 1838.61 €
    expect(
      valuation.positions.map((p) => ({
        assetId: p.assetId,
        quantity: p.quantity,
        priceDate: p.price?.date,
        rate: p.fxRate?.rate ?? null,
        valueMinor: p.valueMinor,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          assetId: nokia.id,
          quantity: "120.000000000000000000",
          priceDate: "2026-10-16",
          rate: null,
          valueMinor: 50_820,
        },
        {
          assetId: apple.id,
          quantity: "10.500000000000000000",
          priceDate: "2026-10-16",
          rate: "1.085000000000000000",
          valueMinor: 183_861,
        },
      ]),
    );
    expect(valuation.positions).toHaveLength(2);
    expect(valuation.valueMinor).toBe(50_820 + 183_861);
    expect(valuation.complete).toBe(true);
  });

  it("reports an asset without a price as missing and an account without holdings as zero", async () => {
    const account = await createAccount("crypto");
    const coin = await createAsset({ symbol: "NEW", assetClass: "crypto" });
    await testDb.db.insert(holdings).values({
      accountId: account.id,
      assetId: coin.id,
      date: "2026-10-01",
      quantity: "3",
    });

    const valuation = await getAccountValuation(account.id, "2026-10-18", {
      db: testDb.db,
    });
    expect(valuation.valueMinor).toBe(0);
    expect(valuation.complete).toBe(false);
    expect(valuation.positions[0]).toMatchObject({
      assetId: coin.id,
      missing: "price",
      valueMinor: null,
    });

    const empty = await createAccount();
    expect(
      await getAccountValuation(empty.id, "2026-10-18", { db: testDb.db }),
    ).toEqual({
      date: "2026-10-18",
      currency: "EUR",
      valueMinor: 0,
      positions: [],
      complete: true,
    });
  });
});
