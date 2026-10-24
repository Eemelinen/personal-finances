import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import {
  accounts,
  assets,
  balanceSnapshots,
  connections,
  holdings,
  investmentTransactions,
  prices,
  syncRuns,
} from "@/server/db/schema";
import {
  COINGECKO_SOURCE,
  createCoinGeckoClient,
} from "@/server/investments/coingecko";
import {
  ManualHoldingError,
  setManualHolding,
} from "@/server/investments/manual-holdings";
import {
  ensureKrakenConnection,
  syncKraken,
} from "@/server/investments/sync-kraken";
import { updatePrices } from "@/server/investments/update-prices";
import {
  createKrakenProvider,
  krakenCredentials,
} from "@/server/providers/kraken";
import { createProviderRegistry } from "@/server/providers/registry";
import { getDashboardOverview } from "@/server/queries/dashboard";
import {
  getAccountValuation,
  getInvestmentsOverview,
} from "@/server/queries/investments";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// Crypto holdings against a real Postgres 18 (F-021): the Kraken key stored
// encrypted as a connection, a sync from the BalanceEx and Ledgers fixtures
// through a mocked `fetch` (account, EUR cash, holding snapshots, ledger
// transactions, a 0 snapshot when a coin is gone, an invalid key), CoinGecko
// prices from the price update, and manual holdings valued with them on
// /investments and in net worth. The tests build on each other in order.

const TIME_ZONE = "Europe/Helsinki";
const TODAY = "2026-10-24";
const TOMORROW = "2026-10-25";
const NOW = new Date(`${TODAY}T09:00:00Z`);
const KEY = randomBytes(32);
const SECRET = Buffer.alloc(64, 7).toString("base64");
const ENV = { KRAKEN_API_KEY: "test-key", KRAKEN_API_SECRET: SECRET };

const balanceEx = JSON.parse(
  readFileSync("tests/fixtures/kraken/balance-ex.json", "utf8"),
) as { result: Record<string, { balance: string }> };
const ledgers = JSON.parse(
  readFileSync("tests/fixtures/kraken/ledgers.json", "utf8"),
) as unknown;

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

/** Kraken behind a mocked `fetch`; `balances` replaces the fixture's. */
function krakenAt(
  now: Date,
  options: {
    balances?: Record<string, { balance: string }>;
    error?: string;
  } = {},
) {
  const methods: string[] = [];
  const fetch = (async (input: string | URL) => {
    const method = String(input).split("/").pop()!;
    methods.push(method);
    if (options.error) return json({ error: [options.error] });
    if (method === "BalanceEx") {
      return json({ error: [], result: options.balances ?? balanceEx.result });
    }
    return json(ledgers);
  }) as typeof globalThis.fetch;
  const provider = createKrakenProvider({
    timeZone: TIME_ZONE,
    fetch,
    now: () => now.getTime(),
    sleep: async () => {},
  });
  return {
    methods,
    options: {
      db: testDb.db,
      providers: createProviderRegistry([provider]),
      env: ENV,
      encrypt: (value: string) => encryptSecret(value, KEY),
      decrypt: (value: string) => decryptSecret(value, KEY),
      now: () => now,
      timeZone: TIME_ZONE,
    },
  };
}

async function krakenAccount() {
  const [account] = await testDb.db
    .select()
    .from(accounts)
    .where(eq(accounts.name, "Kraken"));
  return account;
}

async function snapshots(accountId: string) {
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

describe("Kraken connection", () => {
  it("stores the key pair encrypted and replaces it when it changes", async () => {
    const encrypt = (value: string) => encryptSecret(value, KEY);
    const decrypt = (value: string) => decryptSecret(value, KEY);
    const id = await ensureKrakenConnection({
      db: testDb.db,
      env: ENV,
      encrypt,
      decrypt,
    });
    const [stored] = await testDb.db
      .select()
      .from(connections)
      .where(eq(connections.id, id!));
    expect(stored).toMatchObject({ provider: "kraken", status: "active" });
    expect(stored.sessionRef).toMatch(/^v1:/);
    expect(stored.sessionRef).not.toContain("test-key");
    expect(stored.sessionRef).not.toContain(SECRET);
    expect(decrypt(stored.sessionRef!)).toBe(
      krakenCredentials({ key: "test-key", secret: SECRET }),
    );

    // The same key: nothing changes.
    expect(
      await ensureKrakenConnection({
        db: testDb.db,
        env: ENV,
        encrypt,
        decrypt,
      }),
    ).toBe(id);
    const [again] = await testDb.db
      .select({ sessionRef: connections.sessionRef })
      .from(connections)
      .where(eq(connections.id, id!));
    expect(again.sessionRef).toBe(stored.sessionRef);

    // A new key replaces the old one and reactivates an expired connection.
    await testDb.db
      .update(connections)
      .set({ status: "expired" })
      .where(eq(connections.id, id!));
    const rotated = { ...ENV, KRAKEN_API_KEY: "new-key" };
    expect(
      await ensureKrakenConnection({
        db: testDb.db,
        env: rotated,
        encrypt,
        decrypt,
      }),
    ).toBe(id);
    const [replaced] = await testDb.db
      .select()
      .from(connections)
      .where(eq(connections.id, id!));
    expect(replaced.status).toBe("active");
    expect(JSON.parse(decrypt(replaced.sessionRef!))).toEqual({
      key: "new-key",
      secret: SECRET,
    });

    // Without a key nothing is stored.
    expect(await ensureKrakenConnection({ db: testDb.db, env: {} })).toBeNull();
    expect(await testDb.db.select().from(connections)).toHaveLength(1);
  });
});

describe("Kraken sync", () => {
  it("stores the account, its EUR cash, the holdings and the ledger", async () => {
    const kraken = krakenAt(NOW);
    const [result] = await syncKraken(kraken.options);

    expect(result.balances.status).toBe("succeeded");
    expect(result.holdings).toMatchObject({
      status: "succeeded",
      accounts: [{ holdings: 4, zeroed: 0, fetched: 10, inserted: 10 }],
    });
    expect(result.holdings?.accounts[0].skipped).toHaveLength(6);
    // Read-only calls only.
    expect(new Set(kraken.methods)).toEqual(new Set(["BalanceEx", "Ledgers"]));

    const account = await krakenAccount();
    expect(account).toMatchObject({
      type: "crypto",
      currency: "EUR",
      connectionId: result.connectionId,
      providerAccountRef: "spot",
    });
    expect(
      await testDb.db
        .select({
          date: balanceSnapshots.date,
          amountMinor: balanceSnapshots.amountMinor,
          balanceType: balanceSnapshots.balanceType,
        })
        .from(balanceSnapshots)
        .where(eq(balanceSnapshots.accountId, account.id)),
    ).toEqual([{ date: TODAY, amountMinor: 7746, balanceType: "ITBD" }]);

    expect(await snapshots(account.id)).toEqual([
      { symbol: "BTC", date: TODAY, quantity: "0.008000010000000000" },
      { symbol: "DOT", date: TODAY, quantity: "12.940000000000000000" },
      { symbol: "ETH", date: TODAY, quantity: "0.020049000000000000" },
      { symbol: "XYZQ", date: TODAY, quantity: "3.500000000000000000" },
    ]);
    const coins = await testDb.db
      .select({ symbol: assets.symbol, coingeckoId: assets.coingeckoId })
      .from(assets)
      .orderBy(asc(assets.symbol));
    expect(coins).toEqual([
      { symbol: "BTC", coingeckoId: "bitcoin" },
      { symbol: "DOT", coingeckoId: "polkadot" },
      { symbol: "ETH", coingeckoId: "ethereum" },
      { symbol: "XYZQ", coingeckoId: null },
    ]);

    const rows = await testDb.db
      .select({
        ref: investmentTransactions.providerTxnRef,
        type: investmentTransactions.type,
        tradeDate: investmentTransactions.tradeDate,
        quantity: investmentTransactions.quantity,
        amountMinor: investmentTransactions.amountMinor,
      })
      .from(investmentTransactions)
      .where(eq(investmentTransactions.accountId, account.id))
      .orderBy(
        asc(investmentTransactions.tradeDate),
        asc(investmentTransactions.providerTxnRef),
      );
    expect(rows).toHaveLength(10);
    expect(rows[1]).toEqual({
      ref: "LBUY02-AAAAA-AAAAAA",
      type: "buy",
      tradeDate: "2026-09-02",
      quantity: "0.015000000000000000",
      amountMinor: -90234,
    });

    const runs = await testDb.db
      .select({ status: syncRuns.status })
      .from(syncRuns)
      .where(eq(syncRuns.connectionId, result.connectionId));
    expect(runs).toEqual([{ status: "succeeded" }, { status: "succeeded" }]);
  });

  it("reads the ledger from a week before the newest entry and adds nothing twice", async () => {
    const kraken = krakenAt(NOW);
    const [result] = await syncKraken(kraken.options);
    // The newest stored entry is from 2026-09-20: entries from 09-13 on.
    expect(result.holdings).toMatchObject({
      status: "succeeded",
      accounts: [{ holdings: 4, fetched: 4, inserted: 0 }],
    });
    const account = await krakenAccount();
    expect(await snapshots(account.id)).toHaveLength(4);
  });

  it("marks the connection expired when Kraken refuses the key", async () => {
    const [result] = await syncKraken(
      krakenAt(NOW, { error: "EAPI:Invalid key" }).options,
    );
    expect(result.balances).toMatchObject({
      status: "failed",
      errorKind: "auth_expired",
      connectionStatus: "expired",
    });
    expect(result.holdings).toBeNull();
    // An expired connection is not synced until the key changes.
    expect(await syncKraken(krakenAt(NOW).options)).toEqual([]);
    await testDb.db
      .update(connections)
      .set({ status: "active" })
      .where(eq(connections.id, result.connectionId));
  });
});

describe("crypto prices and manual holdings", () => {
  const requests: URL[] = [];
  const cryptoClient = createCoinGeckoClient({
    timeZone: TIME_ZONE,
    now: () => NOW.getTime(),
    sleep: async () => {},
    fetch: (async (input: string | URL) => {
      const url = new URL(String(input));
      requests.push(url);
      const updated = NOW.getTime() / 1000 - 600;
      return json({
        bitcoin: { eur: 60000.5, last_updated_at: updated },
        ethereum: { eur: 2500, last_updated_at: updated },
        polkadot: { eur: 4.2, last_updated_at: updated },
        "abc-coin": { eur: 1.5e-7, last_updated_at: updated },
      });
    }) as typeof globalThis.fetch,
  });
  const ecb = async () => ({
    date: "2026-10-23",
    rates: [{ currency: "USD", rate: "1.1" }],
  });

  it("stores CoinGecko prices for the coins held and values them", async () => {
    const result = await updatePrices({
      db: testDb.db,
      fetchRates: ecb,
      client: null,
      cryptoClient,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get("ids")).toBe(
      "bitcoin,ethereum,polkadot",
    );
    expect(result.prices).toBe(3);
    expect(result.unknown).toEqual(["XYZQ"]);
    const stored = await testDb.db
      .select({
        symbol: assets.symbol,
        date: prices.date,
        priceMinor: prices.priceMinor,
        source: prices.source,
      })
      .from(prices)
      .innerJoin(assets, eq(prices.assetId, assets.id))
      .orderBy(asc(assets.symbol));
    expect(stored).toEqual([
      {
        symbol: "BTC",
        date: TODAY,
        priceMinor: "6000050.000000000000000000",
        source: COINGECKO_SOURCE,
      },
      {
        symbol: "DOT",
        date: TODAY,
        priceMinor: "420.000000000000000000",
        source: COINGECKO_SOURCE,
      },
      {
        symbol: "ETH",
        date: TODAY,
        priceMinor: "250000.000000000000000000",
        source: COINGECKO_SOURCE,
      },
    ]);

    const account = await krakenAccount();
    const valuation = await getAccountValuation(account.id, TODAY, {
      db: testDb.db,
    });
    // BTC 0.00800001 × 60 000,50 = 480,00; ETH 0.020049 × 2 500 = 50,12;
    // DOT 12.94 × 4,20 = 54,35; XYZQ has no price.
    expect(valuation.valueMinor).toBe(48_000 + 5012 + 5435);
    expect(valuation.complete).toBe(false);
  });

  it("values a manual holding with the same coin's price", async () => {
    const saved = await setManualHolding(
      {
        wallet: "Ledger",
        symbol: "btc",
        coingeckoId: null,
        quantity: "0.5",
        date: TODAY,
      },
      { db: testDb.db },
    );
    expect(saved.created).toBe(true);
    const [btc] = await testDb.db
      .select()
      .from(assets)
      .where(eq(assets.symbol, "BTC"));
    // The Kraken sync's asset, not a second BTC.
    expect(saved.assetId).toBe(btc.id);
    const [wallet] = await testDb.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, saved.accountId));
    expect(wallet).toMatchObject({
      type: "crypto",
      name: "Ledger",
      connectionId: null,
    });

    const valuation = await getAccountValuation(saved.accountId, TODAY, {
      db: testDb.db,
    });
    // 0.5 × 60 000,50 €.
    expect(valuation).toMatchObject({ valueMinor: 3_000_025, complete: true });

    const overview = await getInvestmentsOverview(TODAY, { db: testDb.db });
    const ledger = overview.holdings.find((h) => h.accountName === "Ledger");
    expect(ledger).toMatchObject({
      symbol: "BTC",
      assetClass: "crypto",
      quantity: "0.500000000000000000",
      valueMinor: 3_000_025,
      price: { source: COINGECKO_SOURCE, date: TODAY },
    });
    expect(
      overview.holdings.filter((h) => h.accountName === "Kraken"),
    ).toHaveLength(4);

    // Net worth: Kraken's cash and holdings plus the wallet.
    const dashboard = await getDashboardOverview({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
    });
    expect(dashboard.totals.netWorth.amountMinor).toBe(
      7746 + 58_447 + 3_000_025,
    );
    const manual = dashboard.banks.find((b) => b.name === "Manual");
    expect(manual?.accounts).toMatchObject([
      { name: "Ledger", type: "crypto", holdingsMinor: 3_000_025 },
    ]);
  });

  it("prices an unknown coin once it has a CoinGecko id, and removes it at 0", async () => {
    const input = {
      wallet: "Ledger",
      symbol: "ABC",
      coingeckoId: null,
      quantity: "1000000",
      date: TODAY,
    };
    const first = await setManualHolding(input, { db: testDb.db });
    expect(first).toMatchObject({ created: false, coingeckoId: null });
    const second = await setManualHolding(
      { ...input, coingeckoId: "abc-coin" },
      { db: testDb.db },
    );
    expect(second.assetId).toBe(first.assetId);
    const [abc] = await testDb.db
      .select({ coingeckoId: assets.coingeckoId })
      .from(assets)
      .where(eq(assets.id, first.assetId));
    expect(abc.coingeckoId).toBe("abc-coin");

    await updatePrices({
      db: testDb.db,
      fetchRates: ecb,
      client: null,
      cryptoClient,
    });
    const [price] = await testDb.db
      .select({ priceMinor: prices.priceMinor })
      .from(prices)
      .where(and(eq(prices.assetId, first.assetId), eq(prices.date, TODAY)));
    // 1.5e-7 € = 0.000015 cents.
    expect(price.priceMinor).toBe("0.000015000000000000");
    const valued = await getAccountValuation(first.accountId, TODAY, {
      db: testDb.db,
    });
    // 1 000 000 × 0,00000015 € = 0,15 € on top of the BTC.
    expect(valued.valueMinor).toBe(3_000_025 + 15);

    await setManualHolding({ ...input, quantity: "0" }, { db: testDb.db });
    const removed = await getAccountValuation(first.accountId, TODAY, {
      db: testDb.db,
    });
    expect(removed.valueMinor).toBe(3_000_025);
    expect(removed.positions).toHaveLength(1);
  });

  it("rejects an invalid quantity without writing", async () => {
    await expect(
      setManualHolding(
        {
          wallet: "Trezor",
          symbol: "ETH",
          coingeckoId: null,
          quantity: "-1",
          date: TODAY,
        },
        { db: testDb.db },
      ),
    ).rejects.toBeInstanceOf(ManualHoldingError);
    expect(
      await testDb.db
        .select()
        .from(accounts)
        .where(eq(accounts.name, "Trezor")),
    ).toEqual([]);
  });
});

describe("a coin sold out", () => {
  it("writes a 0 snapshot for a coin that is gone", async () => {
    const rest = Object.fromEntries(
      Object.entries(balanceEx.result).filter(
        ([code]) => !code.startsWith("DOT"),
      ),
    );
    const tomorrow = new Date(`${TOMORROW}T09:00:00Z`);
    const [result] = await syncKraken(
      krakenAt(tomorrow, { balances: rest }).options,
    );
    expect(result.holdings).toMatchObject({
      status: "succeeded",
      accounts: [{ holdings: 3, zeroed: 1 }],
    });
    const account = await krakenAccount();
    const dot = (await snapshots(account.id)).filter((s) => s.symbol === "DOT");
    expect(dot).toEqual([
      { symbol: "DOT", date: TODAY, quantity: "12.940000000000000000" },
      { symbol: "DOT", date: TOMORROW, quantity: "0.000000000000000000" },
    ]);
    const valuation = await getAccountValuation(account.id, TOMORROW, {
      db: testDb.db,
    });
    expect(valuation.positions.map((p) => p.assetId)).not.toContain(
      (await testDb.db.select().from(assets).where(eq(assets.symbol, "DOT")))[0]
        .id,
    );
  });
});
