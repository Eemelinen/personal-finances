import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { costBasis } from "@/server/investments/holdings";
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "@/server/providers/errors";
import {
  createKrakenProvider,
  KRAKEN_ACCOUNT_REF,
  krakenAsset,
  krakenCredentials,
  mapBalanceEx,
  mapLedger,
  PRIVATE_METHODS,
  signKrakenRequest,
  type KrakenBalanceEx,
  type KrakenLedgerEntry,
} from "@/server/providers/kraken";

// The Kraken provider (F-021) against Kraken's documented signature example
// and synthetic BalanceEx / Ledgers fixtures, with a mocked `fetch`: nothing
// reaches the network.

const TIME_ZONE = "Europe/Helsinki";
const NOW = Date.parse("2026-10-24T09:00:00Z");
// A synthetic key pair; the secret is 64 bytes in base64 like Kraken's.
const SECRET = Buffer.alloc(64, 7).toString("base64");
const CONNECTION = {
  sessionRef: krakenCredentials({ key: "test-key", secret: SECRET }),
};

const balanceEx = JSON.parse(
  readFileSync("tests/fixtures/kraken/balance-ex.json", "utf8"),
) as { error: string[]; result: KrakenBalanceEx };
const ledgers = JSON.parse(
  readFileSync("tests/fixtures/kraken/ledgers.json", "utf8"),
) as {
  error: string[];
  result: { ledger: Record<string, KrakenLedgerEntry>; count: number };
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
  rawBody: string;
}

function provider(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let now = NOW;
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const rawBody = String(init?.body ?? "");
    const call = {
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: new URLSearchParams(rawBody),
      rawBody,
    };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return {
    calls,
    sleeps,
    kraken: createKrakenProvider({
      timeZone: TIME_ZONE,
      fetch,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    }),
  };
}

describe("signKrakenRequest", () => {
  it("matches Kraken's documented example", () => {
    // docs.kraken.com → Spot REST → Authentication.
    expect(
      signKrakenRequest(
        "/0/private/AddOrder",
        "1616492376594",
        "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25",
        "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==",
      ),
    ).toBe(
      "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==",
    );
  });

  it("rejects an empty secret", () => {
    expect(() =>
      signKrakenRequest("/0/private/BalanceEx", "1", "", ""),
    ).toThrow(TypeError);
  });
});

describe("krakenAsset", () => {
  it.each([
    ["XXBT", "BTC", "bitcoin"],
    ["XBT.M", "BTC", "bitcoin"],
    ["XETH", "ETH", "ethereum"],
    ["ETH2.S", "ETH", "ethereum"],
    ["ETH2", "ETH", "ethereum"],
    ["DOT.S", "DOT", "polkadot"],
    ["SOL.F", "SOL", "solana"],
    ["XXDG", "DOGE", "dogecoin"],
    ["USDC.M", "USDC", "usd-coin"],
  ])("maps %s to the coin %s", (code, symbol, coingeckoId) => {
    expect(krakenAsset(code)).toEqual({
      fiat: false,
      asset: expect.objectContaining({
        symbol,
        coingeckoId,
        isin: null,
        assetClass: "crypto",
        currency: "EUR",
      }),
    });
  });

  it.each([
    ["ZEUR", "EUR"],
    ["EUR.HOLD", "EUR"],
    ["EUR.M", "EUR"],
    ["ZUSD", "USD"],
    ["CHF", "CHF"],
  ])("maps %s to the fiat currency %s", (code, currency) => {
    expect(krakenAsset(code)).toEqual({ fiat: true, currency });
  });

  it("keeps an unknown coin without a CoinGecko id", () => {
    expect(krakenAsset("XYZQ")).toEqual({
      fiat: false,
      asset: {
        symbol: "XYZQ",
        name: null,
        isin: null,
        coingeckoId: null,
        assetClass: "crypto",
        currency: "EUR",
      },
    });
  });
});

describe("mapBalanceEx", () => {
  it("folds staked balances into the coin and keeps fiat as cash", () => {
    const { holdings, cash } = mapBalanceEx(balanceEx.result, "2026-10-24");

    expect(
      holdings.map(({ symbol, coingeckoId, quantity, date }) => ({
        symbol,
        coingeckoId,
        quantity,
        date,
      })),
    ).toEqual([
      {
        symbol: "BTC",
        coingeckoId: "bitcoin",
        quantity: "0.00800001",
        date: "2026-10-24",
      },
      {
        symbol: "DOT",
        coingeckoId: "polkadot",
        quantity: "12.94",
        date: "2026-10-24",
      },
      {
        symbol: "ETH",
        coingeckoId: "ethereum",
        quantity: "0.020049",
        date: "2026-10-24",
      },
      {
        symbol: "XYZQ",
        coingeckoId: null,
        quantity: "3.5",
        date: "2026-10-24",
      },
    ]);
    expect(holdings[0]).toMatchObject({
      name: "Bitcoin",
      isin: null,
      assetClass: "crypto",
      currency: "EUR",
    });
    expect(cash).toEqual(
      new Map([
        ["EUR", BigInt("77460000000000000000")],
        ["USD", BigInt("108500000000000000000")],
      ]),
    );
  });

  it("leaves out coins with a zero balance", () => {
    const { holdings } = mapBalanceEx(
      { XETH: { balance: "0.0000000000" }, XXBT: { balance: "1" } },
      "2026-10-24",
    );
    expect(holdings.map((h) => h.symbol)).toEqual(["BTC"]);
  });

  it("rejects a balance that is not a decimal string", () => {
    expect(() =>
      mapBalanceEx({ XXBT: { balance: 1 as unknown as string } }, "2026-10-24"),
    ).toThrow(/balance for XXBT/);
  });
});

describe("mapLedger", () => {
  const { transactions, skipped } = mapLedger(ledgers.result.ledger, TIME_ZONE);
  const byRef = new Map(transactions.map((t) => [t.ref, t]));
  const summary = transactions.map((t) => [
    t.ref,
    t.type,
    t.tradeDate,
    t.asset?.symbol ?? null,
    t.quantity,
    t.amountMinor,
    t.currency,
  ]);

  it("maps deposits, withdrawals, trades and staking", () => {
    expect(summary).toEqual([
      [
        "LDEP01-AAAAA-AAAAAA",
        "transfer",
        "2026-09-01",
        null,
        null,
        100000,
        "EUR",
      ],
      [
        "LBUY02-AAAAA-AAAAAA",
        "buy",
        "2026-09-02",
        "BTC",
        "0.015",
        -90234,
        "EUR",
      ],
      ["LRCV01-AAAAA-AAAAAA", "buy", "2026-09-03", "ETH", "0.02", -5075, "EUR"],
      [
        "LRWD01-AAAAA-AAAAAA",
        "dividend",
        "2026-09-10",
        "ETH",
        "0.000049",
        0,
        "EUR",
      ],
      // 22:30 UTC is the next day in Helsinki.
      ["LDEP02-AAAAA-AAAAAA", "transfer", "2026-09-12", "DOT", "10", 0, "EUR"],
      [
        "LWDR01-AAAAA-AAAAAA",
        "transfer",
        "2026-09-12",
        "DOT",
        "-2.05",
        0,
        "EUR",
      ],
      ["LSWP01-AAAAA-AAAAAA", "sell", "2026-09-13", "BTC", "-0.005", 0, "EUR"],
      ["LSWP02-AAAAA-AAAAAA", "buy", "2026-09-13", "DOT", "4.99", 0, "EUR"],
      [
        "LSEL01-AAAAA-AAAAAA",
        "sell",
        "2026-09-14",
        "BTC",
        "-0.002",
        12966,
        "EUR",
      ],
      ["LERN01-AAAAA-AAAAAA", "dividend", "2026-09-20", null, null, 12, "EUR"],
    ]);
  });

  it("describes each row with Kraken's type and reference", () => {
    expect(byRef.get("LBUY02-AAAAA-AAAAAA")?.description).toBe(
      "Kraken trade TBUY01-AAAAA-AAAAAA",
    );
    expect(byRef.get("LERN01-AAAAA-AAAAAA")?.description).toBe(
      "Kraken earn/reward RERN01-AAAAA-AAAAAA",
    );
  });

  it("skips wallet moves, currency conversions and unknown types with a reason", () => {
    expect([...skipped].sort((a, b) => a.ref.localeCompare(b.ref))).toEqual([
      {
        ref: "LADJ01-AAAAA-AAAAAA",
        reason: 'Kraken ledger type "adjustment" is not recorded',
      },
      {
        ref: "LERN02-AAAAA-AAAAAA",
        reason: "A move between Kraken wallets (earn/allocation)",
      },
      {
        ref: "LFXC01-AAAAA-AAAAAA",
        reason: "A currency conversion (TFXC01-AAAAA-AAAAAA)",
      },
      {
        ref: "LFXC02-AAAAA-AAAAAA",
        reason: "A currency conversion (TFXC01-AAAAA-AAAAAA)",
      },
      {
        ref: "LSTK01-AAAAA-AAAAAA",
        reason: "A move between Kraken wallets (transfer/spottostaking)",
      },
      {
        ref: "LSTK02-AAAAA-AAAAAA",
        reason: "A move between Kraken wallets (transfer/stakingfromspot)",
      },
    ]);
    expect(transactions.length + skipped.length).toBe(
      ledgers.result.count - 3, // the three fiat legs folded into trades
    );
  });

  it("gives an average cost to bought coins, none to coins moved in", () => {
    const rows = transactions.map((t) => ({
      assetId: t.asset?.symbol ?? null,
      type: t.type,
      tradeDate: t.tradeDate,
      quantity: t.quantity,
      amountMinor: t.amountMinor,
      currency: t.currency,
    }));
    const bases = costBasis(rows, "2026-10-24");
    // 902,34 for 0.015; selling 0.005 and 0.002 removes 300,78 and 120,31.
    expect(bases.get("BTC")).toEqual({
      quantity: "0.008",
      costMinor: 48_125,
      currency: "EUR",
    });
    // The staking reward came for nothing.
    expect(bases.get("ETH")).toEqual({
      quantity: "0.020049",
      costMinor: 5075,
      currency: "EUR",
    });
    // Deposited from elsewhere and bought coin-to-coin: cost unknown.
    expect(bases.get("DOT")).toBeNull();
  });

  it("records an airdrop credited as a transfer in", () => {
    const { transactions: rows } = mapLedger(
      {
        LAIR01: {
          refid: "RAIR01",
          time: Date.parse("2026-09-01T12:00:00Z") / 1000,
          type: "transfer",
          subtype: "",
          asset: "FLR",
          amount: "15.0000",
          fee: "0.0000",
        },
      },
      TIME_ZONE,
    );
    expect(rows).toMatchObject([
      { ref: "LAIR01", type: "transfer", quantity: "15" },
    ]);
  });
});

describe("createKrakenProvider", () => {
  it("lists one crypto account", async () => {
    const { kraken, calls } = provider(() => json(balanceEx));
    expect(await kraken.listAccounts(CONNECTION)).toEqual([
      {
        ref: KRAKEN_ACCOUNT_REF,
        name: "Kraken",
        type: "crypto",
        currency: "EUR",
        iban: null,
      },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("signs BalanceEx with the key, a nonce and HMAC-SHA512", async () => {
    const { kraken, calls } = provider(() => json(balanceEx));
    await kraken.getHoldings!(CONNECTION, KRAKEN_ACCOUNT_REF);
    await kraken.getHoldings!(CONNECTION, KRAKEN_ACCOUNT_REF);

    expect(calls).toHaveLength(2);
    const [first, second] = calls;
    expect(first.url).toBe("https://api.kraken.com/0/private/BalanceEx");
    expect(first.headers["API-Key"]).toBe("test-key");
    const nonce = first.body.get("nonce")!;
    expect(nonce).toBe(String(NOW));
    const expected = createHmac("sha512", Buffer.from(SECRET, "base64"))
      .update(
        Buffer.concat([
          Buffer.from("/0/private/BalanceEx"),
          createHash("sha256")
            .update(nonce + first.rawBody)
            .digest(),
        ]),
      )
      .digest("base64");
    expect(first.headers["API-Sign"]).toBe(expected);
    // The nonce always grows, also within one millisecond.
    expect(Number(second.body.get("nonce"))).toBeGreaterThan(Number(nonce));
  });

  it("returns the holdings and the EUR cash of today", async () => {
    const { kraken } = provider(() => json(balanceEx));
    const holdings = await kraken.getHoldings!(CONNECTION, KRAKEN_ACCOUNT_REF);
    expect(holdings.map((h) => [h.symbol, h.quantity, h.date])).toEqual([
      ["BTC", "0.00800001", "2026-10-24"],
      ["DOT", "12.94", "2026-10-24"],
      ["ETH", "0.020049", "2026-10-24"],
      ["XYZQ", "3.5", "2026-10-24"],
    ]);
    expect(await kraken.getBalances(CONNECTION, KRAKEN_ACCOUNT_REF)).toEqual([
      {
        amountMinor: 7746,
        currency: "EUR",
        balanceType: "ITBD",
        date: "2026-10-24",
      },
    ]);
    expect(
      await kraken.getTransactions(CONNECTION, KRAKEN_ACCOUNT_REF, {}),
    ).toEqual({ transactions: [], continuationKey: null });
  });

  it("reads the whole ledger page by page, keeping to the rate limit", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 420 }, (_, i) => [
        `L${String(i).padStart(5, "0")}`,
        {
          refid: `R${i}`,
          time: Date.parse("2026-09-01T12:00:00Z") / 1000 + i * 60,
          type: "staking",
          subtype: "",
          asset: "DOT.S",
          amount: "0.0100000000",
          fee: "0.0000000000",
        },
      ]),
    );
    const ids = Object.keys(entries).reverse();
    const { kraken, calls, sleeps } = provider((call) => {
      const ofs = Number(call.body.get("ofs"));
      return json({
        error: [],
        result: {
          ledger: Object.fromEntries(
            ids.slice(ofs, ofs + 50).map((id) => [id, entries[id]]),
          ),
          count: ids.length,
        },
      });
    });

    const history = await kraken.getInvestmentTransactions!(
      CONNECTION,
      KRAKEN_ACCOUNT_REF,
      { from: "2026-09-01" },
    );

    expect(history.transactions).toHaveLength(420);
    expect(calls.map((c) => c.body.get("ofs"))).toEqual([
      "0",
      "50",
      "100",
      "150",
      "200",
      "250",
      "300",
      "350",
      "400",
    ]);
    expect(calls.every((c) => c.url.endsWith("/0/private/Ledgers"))).toBe(true);
    expect(calls[0].body.get("start")).toBe(
      String(Date.parse("2026-08-31T00:00:00Z") / 1000),
    );
    expect(calls[0].body.get("end")).toBe(String(NOW / 1000));
    // 6 calls a minute: the seventh waits for the first to age out.
    expect(sleeps).toEqual([60_000]);
  });

  it("drops entries before the range's first day", async () => {
    const { kraken } = provider(() => json(ledgers));
    const history = await kraken.getInvestmentTransactions!(
      CONNECTION,
      KRAKEN_ACCOUNT_REF,
      { from: "2026-09-13" },
    );
    expect(history.transactions.map((t) => t.tradeDate)).toEqual([
      "2026-09-13",
      "2026-09-13",
      "2026-09-14",
      "2026-09-20",
    ]);
  });

  it("calls only the read-only methods", () => {
    expect(PRIVATE_METHODS).toEqual(["BalanceEx", "Ledgers"]);
  });

  it.each([
    [["EAPI:Invalid key"], ProviderAuthError],
    [["EAPI:Invalid signature"], ProviderAuthError],
    [["EGeneral:Permission denied"], ProviderAuthError],
    [["EAPI:Rate limit exceeded"], ProviderRateLimitError],
    [["EGeneral:Temporary lockout"], ProviderRateLimitError],
    [["EService:Unavailable"], ProviderUnavailableError],
    [["EAPI:Invalid nonce"], ProviderUnavailableError],
  ])("maps the Kraken error %j", async (error, type) => {
    const { kraken } = provider(() => json({ error }));
    await expect(
      kraken.getHoldings!(CONNECTION, KRAKEN_ACCOUNT_REF),
    ).rejects.toBeInstanceOf(type);
  });

  it("treats an unknown Kraken error as a bug", async () => {
    const { kraken } = provider(() =>
      json({ error: ["EGeneral:Invalid arguments"] }),
    );
    const error = await kraken.getHoldings!(
      CONNECTION,
      KRAKEN_ACCOUNT_REF,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProviderAuthError);
    expect((error as Error).message).toBe("Kraken: EGeneral:Invalid arguments");
  });

  it("maps HTTP failures and an unreachable API", async () => {
    const down = provider(() => new Response("", { status: 503 }));
    await expect(
      down.kraken.getHoldings!(CONNECTION, KRAKEN_ACCOUNT_REF),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    const limited = provider(
      () => new Response("", { status: 429, headers: { "retry-after": "30" } }),
    );
    await expect(
      limited.kraken.getHoldings!(CONNECTION, KRAKEN_ACCOUNT_REF),
    ).rejects.toMatchObject({ kind: "rate_limited", retryAfterMs: 30_000 });

    const offline = provider(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      offline.kraken.getHoldings!(CONNECTION, KRAKEN_ACCOUNT_REF),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("rejects a connection without a key pair as an auth failure", async () => {
    const { kraken, calls } = provider(() => json(balanceEx));
    await expect(
      kraken.getHoldings!({ sessionRef: "not json" }, KRAKEN_ACCOUNT_REF),
    ).rejects.toBeInstanceOf(ProviderAuthError);
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown account", async () => {
    const { kraken } = provider(() => json(balanceEx));
    await expect(kraken.getHoldings!(CONNECTION, "futures")).rejects.toThrow(
      /Unknown Kraken account/,
    );
  });
});
