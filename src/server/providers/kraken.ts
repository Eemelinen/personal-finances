import { createHash, createHmac } from "node:crypto";
import { localDate } from "@/server/dates";
import {
  currencyExponent,
  divideRounded,
  formatDecimal,
  parseDecimal,
  pow10,
  SCALE_FACTOR,
} from "@/server/investments/decimal";
import { KNOWN_COINS } from "@/server/investments/coins";
import { createRateLimiter } from "@/server/investments/price-client";
import {
  ProviderAuthError,
  providerErrorFromStatus,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "./errors";
import type {
  CurrencyCode,
  FinancialProvider,
  IsoDate,
  ProviderAccount,
  ProviderAsset,
  ProviderBalance,
  ProviderConnection,
  ProviderHolding,
  ProviderInvestmentHistory,
  ProviderInvestmentTransaction,
  ProviderSkippedEntry,
  TransactionRange,
} from "./types";

// Kraken (F-021, D-018): holdings from `BalanceEx` and investment
// transactions from `Ledgers` over Kraken's private REST API, with a
// read-only key. Only the read-only methods in `PRIVATE_METHODS` can be
// called, so even a key with more permissions never trades or withdraws.
// One connection is one Kraken account; its `sessionRef` holds the key and
// secret (`krakenCredentials()`), stored encrypted like bank sessions.

const PROVIDER_ID = "kraken";
const API_URL = "https://api.kraken.com";

/** The account's ref: Kraken has one spot wallet per key. */
export const KRAKEN_ACCOUNT_REF = "spot";
/** Crypto is valued in the account's currency. */
export const KRAKEN_QUOTE_CURRENCY = "EUR";
/** `balance_snapshots.balance_type` of the EUR cash: booked, intraday. */
export const KRAKEN_BALANCE_TYPE = "ITBD";

/**
 * Query Funds (`BalanceEx`) and Query Ledger Entries (`Ledgers`); never an
 * order, deposit or withdrawal method.
 */
export const PRIVATE_METHODS = ["BalanceEx", "Ledgers"] as const;
type PrivateMethod = (typeof PRIVATE_METHODS)[number];

/** Kraken returns at most 50 ledger entries per call. */
const LEDGER_PAGE_SIZE = 50;
/**
 * A ledger call costs 2 of the starter tier's 15 points, which decay by
 * 0.33 a second (20 a minute): 6 calls a minute stay below the limit, also
 * as a burst next to the two `BalanceEx` calls of a sync.
 */
const LEDGER_CALLS_PER_MINUTE = 6;

// --- Signing ----------------------------------------------------------------

/**
 * `API-Sign`: HMAC-SHA512 over the URI path and SHA-256(nonce + POST
 * data), keyed with the base64-decoded secret, as base64.
 */
export function signKrakenRequest(
  path: string,
  nonce: string,
  postData: string,
  secret: string,
): string {
  const key = Buffer.from(secret, "base64");
  if (key.length === 0) throw new TypeError("The Kraken secret is empty");
  const digest = createHash("sha256")
    .update(nonce + postData)
    .digest();
  return createHmac("sha512", key)
    .update(Buffer.concat([Buffer.from(path), digest]))
    .digest("base64");
}

export interface KrakenCredentials {
  key: string;
  secret: string;
}

/** The `sessionRef` plaintext of a Kraken connection. */
export function krakenCredentials(credentials: KrakenCredentials): string {
  return JSON.stringify({ key: credentials.key, secret: credentials.secret });
}

function parseCredentials(sessionRef: string): KrakenCredentials {
  try {
    const parsed = JSON.parse(sessionRef) as Partial<KrakenCredentials>;
    if (typeof parsed.key === "string" && typeof parsed.secret === "string") {
      return { key: parsed.key, secret: parsed.secret };
    }
  } catch {
    // Reported below.
  }
  throw new ProviderAuthError(
    PROVIDER_ID,
    "The Kraken connection holds no API key and secret",
  );
}

// --- Assets -----------------------------------------------------------------

/** Kraken's legacy four-letter codes (X… crypto, Z… fiat). */
const LEGACY_CODES: Record<string, string> = {
  XXBT: "BTC",
  XBT: "BTC",
  XETH: "ETH",
  XXDG: "DOGE",
  XDG: "DOGE",
  XLTC: "LTC",
  XXRP: "XRP",
  XXLM: "XLM",
  XXMR: "XMR",
  XETC: "ETC",
  XZEC: "ZEC",
  XREP: "REP",
  XMLN: "MLN",
  ETH2: "ETH",
  ZEUR: "EUR",
  ZUSD: "USD",
  ZGBP: "GBP",
  ZCAD: "CAD",
  ZJPY: "JPY",
  ZAUD: "AUD",
  ZCHF: "CHF",
};

/** Kraken's fee credits: not an asset the account owns. */
const FEE_CREDIT = "KFEE";

const FIAT = new Set(["EUR", "USD", "GBP", "CAD", "JPY", "AUD", "CHF"]);

export type KrakenAsset =
  | { fiat: true; currency: CurrencyCode }
  | { fiat: false; asset: ProviderAsset };

/**
 * A Kraken asset code as a coin or a fiat currency. Staked, bonded, earn
 * and held balances (`DOT.S`, `ETH2.S`, `USDC.M`, `SOL.F`, `EUR.HOLD`) are
 * the same asset as the spot balance.
 */
export function krakenAsset(code: string): KrakenAsset {
  const base = code.toUpperCase().replace(/\.(S|M|B|F|P|T|HOLD)$/, "");
  const symbol = LEGACY_CODES[base] ?? base;
  if (FIAT.has(symbol)) return { fiat: true, currency: symbol };
  const known = KNOWN_COINS[symbol];
  return {
    fiat: false,
    asset: {
      symbol,
      name: known?.name ?? null,
      isin: null,
      coingeckoId: known?.coingeckoId ?? null,
      assetClass: "crypto",
      currency: KRAKEN_QUOTE_CURRENCY,
    },
  };
}

/** A Kraken amount in integer minor units of `currency`, rounded. */
function toMinor(units: bigint, currency: CurrencyCode): number {
  return Number(
    divideRounded(units * pow10(currencyExponent(currency)), SCALE_FACTOR),
  );
}

function decimal(value: unknown, field: string): bigint {
  if (typeof value !== "string") {
    throw new Error(`Kraken returned no ${field}: ${JSON.stringify(value)}`);
  }
  return parseDecimal(value);
}

// --- BalanceEx --------------------------------------------------------------

export interface KrakenBalanceEx {
  [asset: string]: { balance?: string; hold_trade?: string; credit?: string };
}

export interface MappedBalances {
  /** Coins with a positive balance, staked balances folded in. */
  holdings: ProviderHolding[];
  /** Fiat balances per currency, in units of 10^-18. */
  cash: Map<CurrencyCode, bigint>;
}

/**
 * Holdings and cash from `BalanceEx`. `balance` is what the account owns,
 * including what open orders hold (`hold_trade`).
 */
export function mapBalanceEx(
  result: KrakenBalanceEx,
  date: IsoDate,
): MappedBalances {
  const coins = new Map<string, { asset: ProviderAsset; units: bigint }>();
  const cash = new Map<CurrencyCode, bigint>();
  for (const [code, entry] of Object.entries(result)) {
    if (code.toUpperCase() === FEE_CREDIT) continue;
    const units = decimal(entry.balance, `balance for ${code}`);
    const mapped = krakenAsset(code);
    if (mapped.fiat) {
      cash.set(
        mapped.currency,
        (cash.get(mapped.currency) ?? BigInt(0)) + units,
      );
      continue;
    }
    const known = coins.get(mapped.asset.symbol);
    coins.set(mapped.asset.symbol, {
      asset: mapped.asset,
      units: (known?.units ?? BigInt(0)) + units,
    });
  }
  const holdings = [...coins.values()]
    .filter(({ units }) => units > BigInt(0))
    .map(({ asset, units }) => ({
      ...asset,
      quantity: formatDecimal(units),
      date,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { holdings, cash };
}

// --- Ledgers ----------------------------------------------------------------

export interface KrakenLedgerEntry {
  refid: string;
  /** Unix time in seconds, with a fraction. */
  time: number;
  type: string;
  subtype?: string;
  aclass?: string;
  asset: string;
  amount: string;
  fee: string;
  balance?: string;
}

/** Trades, and the spend / receive pair of Kraken's "Buy Crypto". */
const TRADE_TYPES = new Set(["trade", "spend", "receive"]);
const REWARD_TYPES = new Set(["staking", "reward", "dividend"]);
/** Moves between Kraken's own wallets; the balances net out. */
const INTERNAL_SUBTYPES = new Set([
  "spottostaking",
  "stakingfromspot",
  "stakingtospot",
  "spotfromstaking",
  "spottofutures",
  "spotfromfutures",
  "allocation",
  "deallocation",
  "autoallocation",
  "migration",
]);

interface Leg {
  id: string;
  entry: KrakenLedgerEntry;
  mapped: KrakenAsset;
  /** amount − fee: the change in the balance, units of 10^-18. */
  net: bigint;
  tradeDate: IsoDate;
}

function describe(entry: KrakenLedgerEntry): string {
  const kind = entry.subtype ? `${entry.type}/${entry.subtype}` : entry.type;
  return `Kraken ${kind} ${entry.refid}`;
}

/** A coin row without a cash effect, or a cash-only row for fiat. */
function singleRow(
  leg: Leg,
  type: ProviderInvestmentTransaction["type"],
): ProviderInvestmentTransaction {
  const base = {
    ref: leg.id,
    type,
    tradeDate: leg.tradeDate,
    description: describe(leg.entry),
  };
  return leg.mapped.fiat
    ? {
        ...base,
        asset: null,
        quantity: null,
        amountMinor: toMinor(leg.net, leg.mapped.currency),
        currency: leg.mapped.currency,
      }
    : {
        ...base,
        asset: leg.mapped.asset,
        quantity: formatDecimal(leg.net),
        amountMinor: 0,
        currency: KRAKEN_QUOTE_CURRENCY,
      };
}

/**
 * Investment transactions from ledger entries keyed by ledger id (D-018):
 *
 * - a trade (or spend + receive) of a coin against one fiat currency is one
 *   buy or sell of the coin with the fiat amount, fees included, as its
 *   cash effect; a coin-to-coin trade is a sell and a buy without cash; a
 *   fiat-to-fiat conversion is not recorded;
 * - deposits, withdrawals and transfers in from outside (airdrops) are
 *   transfers; staking and earn rewards are dividends;
 * - moves between Kraken's own wallets (spot ↔ staking, earn allocations)
 *   and other types are skipped with a reason.
 *
 * Quantities are amount − fee, the change in the balance.
 */
export function mapLedger(
  ledger: Record<string, KrakenLedgerEntry>,
  timeZone: string,
): ProviderInvestmentHistory {
  const legs: Leg[] = Object.entries(ledger)
    .map(([id, entry]) => ({
      id,
      entry,
      mapped: krakenAsset(entry.asset),
      net:
        decimal(entry.amount, `amount of ${id}`) -
        decimal(entry.fee, `fee of ${id}`),
      tradeDate: localDate(new Date(entry.time * 1000), timeZone),
    }))
    .sort((a, b) => a.entry.time - b.entry.time || a.id.localeCompare(b.id));

  const transactions: ProviderInvestmentTransaction[] = [];
  const skipped: ProviderSkippedEntry[] = [];
  const trades = new Map<string, Leg[]>();

  for (const leg of legs) {
    const { type, subtype = "" } = leg.entry;
    if (leg.entry.asset.toUpperCase() === FEE_CREDIT) {
      skipped.push({
        ref: leg.id,
        reason: "Kraken fee credits (KFEE) are not recorded",
      });
    } else if (TRADE_TYPES.has(type)) {
      const group = trades.get(leg.entry.refid);
      if (group) group.push(leg);
      else trades.set(leg.entry.refid, [leg]);
    } else if (type === "deposit" || type === "withdrawal") {
      transactions.push(singleRow(leg, "transfer"));
    } else if (type === "transfer" || type === "earn") {
      if (type === "earn" && subtype === "reward") {
        transactions.push(singleRow(leg, "dividend"));
      } else if (INTERNAL_SUBTYPES.has(subtype) || type === "earn") {
        skipped.push({
          ref: leg.id,
          reason: `A move between Kraken wallets (${type}/${subtype || "none"})`,
        });
      } else {
        transactions.push(singleRow(leg, "transfer"));
      }
    } else if (REWARD_TYPES.has(type)) {
      transactions.push(singleRow(leg, "dividend"));
    } else {
      skipped.push({
        ref: leg.id,
        reason: `Kraken ledger type "${type}" is not recorded`,
      });
    }
  }

  for (const [refid, group] of trades) {
    const coins = group.filter((leg) => !leg.mapped.fiat);
    const fiat = group.filter((leg) => leg.mapped.fiat);
    const tradeType = (leg: Leg) =>
      leg.net < BigInt(0) ? ("sell" as const) : ("buy" as const);
    if (coins.length === 0) {
      for (const leg of fiat) {
        skipped.push({
          ref: leg.id,
          reason: `A currency conversion (${refid})`,
        });
      }
    } else if (coins.length === 1 && fiat.length === 1) {
      const [coin] = coins;
      const [cash] = fiat;
      const currency = (cash.mapped as { currency: CurrencyCode }).currency;
      transactions.push({
        ...singleRow(coin, tradeType(coin)),
        amountMinor: toMinor(cash.net, currency),
        currency,
      });
    } else {
      for (const leg of coins)
        transactions.push(singleRow(leg, tradeType(leg)));
      for (const leg of fiat) {
        skipped.push({
          ref: leg.id,
          reason: `The cash leg of a trade with several coins (${refid})`,
        });
      }
    }
  }

  transactions.sort(
    (a, b) =>
      a.tradeDate.localeCompare(b.tradeDate) || a.ref.localeCompare(b.ref),
  );
  return { transactions, skipped };
}

// --- Client -----------------------------------------------------------------

interface KrakenResponse<T> {
  error?: string[];
  result?: T;
}

/** Kraken reports errors in the body (`EAPI:Invalid key`), often with 200. */
function errorFor(messages: string[]): Error {
  const message = `Kraken: ${messages.join(", ")}`;
  const text = messages.join(" ");
  if (/Invalid key|Invalid signature|Permission denied/i.test(text)) {
    return new ProviderAuthError(PROVIDER_ID, message);
  }
  if (/Rate limit|Too many requests|Throttled|Temporary lockout/i.test(text)) {
    return new ProviderRateLimitError(PROVIDER_ID, message);
  }
  if (/EService|Invalid nonce/i.test(text)) {
    return new ProviderUnavailableError(PROVIDER_ID, message);
  }
  return new Error(message);
}

export interface KrakenProviderOptions {
  /** `APP_TIMEZONE`: the calendar day of balances and ledger entries. */
  timeZone: string;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; the nonce and today's date. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

export function createKrakenProvider(
  options: KrakenProviderOptions,
): FinancialProvider {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const baseUrl = options.baseUrl ?? API_URL;
  const limitLedger = createRateLimiter({
    perMinute: LEDGER_CALLS_PER_MINUTE,
    perDay: Number.MAX_SAFE_INTEGER,
    now,
    sleep:
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  });
  // Kraken rejects a nonce that is not larger than the key's last one.
  let lastNonce = 0;
  const nextNonce = () => {
    lastNonce = Math.max(now(), lastNonce + 1);
    return String(lastNonce);
  };
  const today = () => localDate(new Date(now()), options.timeZone);

  async function call<T>(
    connection: ProviderConnection,
    method: PrivateMethod,
    params: Record<string, string> = {},
  ): Promise<T> {
    if (!PRIVATE_METHODS.includes(method)) {
      throw new Error(`Kraken method ${method} is not allowed`);
    }
    const { key, secret } = parseCredentials(connection.sessionRef);
    const path = `/0/private/${method}`;
    const nonce = nextNonce();
    const body = new URLSearchParams({ nonce, ...params }).toString();
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "API-Key": key,
          "API-Sign": signKrakenRequest(path, nonce, body, secret),
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          Accept: "application/json",
        },
        body,
      });
    } catch (error) {
      throw new ProviderUnavailableError(
        PROVIDER_ID,
        `Kraken is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw (
        providerErrorFromStatus(PROVIDER_ID, response.status, {
          retryAfter: response.headers.get("retry-after"),
          now: new Date(now()),
        }) ?? new Error(`Kraken responded with HTTP ${response.status}`)
      );
    }
    const json = (await response.json()) as KrakenResponse<T>;
    if (json.error && json.error.length > 0) throw errorFor(json.error);
    if (json.result === undefined) {
      throw new Error(`Kraken returned no result for ${method}`);
    }
    return json.result;
  }

  async function balances(connection: ProviderConnection) {
    return mapBalanceEx(
      await call<KrakenBalanceEx>(connection, "BalanceEx"),
      today(),
    );
  }

  function assertAccount(account: string) {
    if (account !== KRAKEN_ACCOUNT_REF) {
      throw new Error(`Unknown Kraken account ${JSON.stringify(account)}`);
    }
  }

  return {
    id: PROVIDER_ID,

    async listAccounts(): Promise<ProviderAccount[]> {
      return [
        {
          ref: KRAKEN_ACCOUNT_REF,
          name: "Kraken",
          type: "crypto",
          currency: KRAKEN_QUOTE_CURRENCY,
          iban: null,
        },
      ];
    },

    /** The EUR cash; other fiat currencies are not tracked (D-018). */
    async getBalances(connection, account): Promise<ProviderBalance[]> {
      assertAccount(account);
      const { cash } = await balances(connection);
      return [
        {
          amountMinor: toMinor(
            cash.get(KRAKEN_QUOTE_CURRENCY) ?? BigInt(0),
            KRAKEN_QUOTE_CURRENCY,
          ),
          currency: KRAKEN_QUOTE_CURRENCY,
          balanceType: KRAKEN_BALANCE_TYPE,
          date: today(),
        },
      ];
    },

    /** Ledger entries are investment transactions, not bank transactions. */
    async getTransactions(_connection, account) {
      assertAccount(account);
      return { transactions: [], continuationKey: null };
    },

    async getHoldings(connection, account) {
      assertAccount(account);
      return (await balances(connection)).holdings;
    },

    async getInvestmentTransactions(
      connection,
      account,
      range: TransactionRange,
    ) {
      assertAccount(account);
      // Kraken lists newest first; a fixed `end` keeps the offsets stable
      // while entries arrive.
      const end = range.to
        ? Math.floor(Date.parse(`${range.to}T00:00:00Z`) / 1000) + 2 * 86_400
        : Math.floor(now() / 1000);
      const start = range.from
        ? Math.floor(Date.parse(`${range.from}T00:00:00Z`) / 1000) - 86_400
        : undefined;
      const ledger: Record<string, KrakenLedgerEntry> = {};
      for (let ofs = 0; ;) {
        await limitLedger();
        const page = await call<{
          ledger?: Record<string, KrakenLedgerEntry>;
          count?: number;
        }>(connection, "Ledgers", {
          ...(start !== undefined ? { start: String(start) } : {}),
          end: String(end),
          ofs: String(ofs),
        });
        const entries = Object.entries(page.ledger ?? {});
        for (const [id, entry] of entries) ledger[id] = entry;
        ofs += entries.length;
        if (
          entries.length < LEDGER_PAGE_SIZE ||
          ofs >= (page.count ?? Number.POSITIVE_INFINITY)
        ) {
          break;
        }
      }
      const history = mapLedger(ledger, options.timeZone);
      if (!range.from && !range.to) return history;
      // `start` and `end` reach a day further for time zones; trim to the
      // range in local days.
      const inRange = (date: IsoDate) =>
        (!range.from || date >= range.from) && (!range.to || date <= range.to);
      return {
        transactions: history.transactions.filter((t) => inRange(t.tradeDate)),
        skipped: history.skipped.filter(({ ref }) =>
          inRange(
            localDate(new Date(ledger[ref].time * 1000), options.timeZone),
          ),
        ),
      };
    },
  };
}
