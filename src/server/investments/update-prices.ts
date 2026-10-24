import { asc, desc, inArray, sql } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { assets, fxRates, holdings, prices } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import type { IsoDate } from "@/server/providers/types";
import {
  currencyExponent,
  formatDecimal,
  parseDecimal,
  pow10,
} from "./decimal";
import {
  COINGECKO_SOURCE,
  createCoinGeckoClient,
  type CryptoPriceClient,
} from "./coingecko";
import { fetchEcbRates, type EcbRates } from "./ecb";
import {
  createTwelveDataClient,
  PriceApiError,
  TWELVE_DATA_SOURCE,
  type PriceClient,
} from "./price-client";

// The daily price update (F-020, D-017; the worker's `price-update` job):
// the ECB reference rates, then CoinGecko prices for the coins held today
// (F-021, D-018; one request per currency), then one closing price per
// security held today. One request per security through the rate-limited
// client; an unknown symbol is reported and the rest continue, an API that
// refuses (limit, key, outage) stops its part of the run until tomorrow.

export interface PriceUpdateResult {
  fxDate: IsoDate | null;
  fxRates: number;
  /** Prices written. */
  prices: number;
  /**
   * Symbols the price APIs do not know (or quote in another currency), and
   * coins without a CoinGecko id.
   */
  unknown: string[];
  /** Why part of the update did not run; empty when everything ran. */
  problems: string[];
}

export interface PriceUpdateOptions {
  db?: Db;
  /** Null skips stock prices; defaults to Twelve Data with `PRICE_API_KEY`. */
  client?: PriceClient | null;
  /** Null skips crypto prices; defaults to CoinGecko. */
  cryptoClient?: CryptoPriceClient | null;
  fetchRates?: () => Promise<EcbRates>;
}

function defaultClient(): PriceClient | null {
  const apiKey = getEnv().PRICE_API_KEY;
  return apiKey ? createTwelveDataClient({ apiKey }) : null;
}

function defaultCryptoClient(): CryptoPriceClient {
  const env = getEnv();
  return createCoinGeckoClient({
    apiKey: env.COINGECKO_API_KEY,
    timeZone: env.APP_TIMEZONE,
  });
}

/** Assets some account holds a positive quantity of today. */
async function heldAssets(db: Db) {
  const latest = db
    .selectDistinctOn([holdings.accountId, holdings.assetId], {
      assetId: holdings.assetId,
      quantity: holdings.quantity,
    })
    .from(holdings)
    .orderBy(holdings.accountId, holdings.assetId, desc(holdings.date))
    .as("latest");
  const held = await db
    .selectDistinct({ assetId: latest.assetId })
    .from(latest)
    .where(sql`${latest.quantity} > 0`);
  if (held.length === 0) return [];
  return db
    .select({
      id: assets.id,
      symbol: assets.symbol,
      isin: assets.isin,
      coingeckoId: assets.coingeckoId,
      assetClass: assets.assetClass,
      currency: assets.currency,
    })
    .from(assets)
    .where(
      inArray(
        assets.id,
        held.map((h) => h.assetId),
      ),
    )
    .orderBy(asc(assets.symbol), asc(assets.id));
}

async function storePrice(
  db: Db,
  assetId: string,
  close: { date: IsoDate; price: string; currency: string },
  source: string,
) {
  const priceMinor = formatDecimal(
    parseDecimal(close.price) * pow10(currencyExponent(close.currency)),
  );
  await db
    .insert(prices)
    .values({
      assetId,
      date: close.date,
      priceMinor,
      currency: close.currency,
      source,
    })
    .onConflictDoUpdate({
      target: [prices.assetId, prices.date],
      set: {
        priceMinor,
        currency: close.currency,
        source,
        updatedAt: sql`now()`,
      },
    });
}

type HeldAsset = Awaited<ReturnType<typeof heldAssets>>[number];

/** One CoinGecko request per quote currency (D-018). */
async function updateCryptoPrices(
  db: Db,
  client: CryptoPriceClient,
  coins: HeldAsset[],
  result: PriceUpdateResult,
) {
  const byCurrency = new Map<string, HeldAsset[]>();
  for (const coin of coins) {
    if (coin.coingeckoId === null) {
      result.unknown.push(coin.symbol);
      continue;
    }
    const list = byCurrency.get(coin.currency);
    if (list) list.push(coin);
    else byCurrency.set(coin.currency, [coin]);
  }
  for (const [currency, list] of byCurrency) {
    let quotes;
    try {
      quotes = await client.getPrices(
        list.map((coin) => coin.coingeckoId!),
        currency,
      );
    } catch (error) {
      if (!(error instanceof PriceApiError)) throw error;
      result.problems.push(`Crypto prices (${currency}): ${error.message}`);
      continue;
    }
    for (const coin of list) {
      const quote = quotes.get(coin.coingeckoId!);
      if (!quote) {
        result.unknown.push(coin.symbol);
        continue;
      }
      await storePrice(db, coin.id, quote, COINGECKO_SOURCE);
      result.prices++;
    }
  }
}

export async function updatePrices(
  options: PriceUpdateOptions = {},
): Promise<PriceUpdateResult> {
  const db = options.db ?? getDb();
  const client =
    options.client === undefined ? defaultClient() : options.client;
  const result: PriceUpdateResult = {
    fxDate: null,
    fxRates: 0,
    prices: 0,
    unknown: [],
    problems: [],
  };

  try {
    const ecb = await (options.fetchRates ?? fetchEcbRates)();
    await db
      .insert(fxRates)
      .values(ecb.rates.map((r) => ({ date: ecb.date, ...r })))
      .onConflictDoUpdate({
        target: [fxRates.date, fxRates.currency],
        set: { rate: sql`excluded.rate`, updatedAt: sql`now()` },
      });
    result.fxDate = ecb.date;
    result.fxRates = ecb.rates.length;
  } catch (error) {
    if (!(error instanceof PriceApiError)) throw error;
    result.problems.push(`FX rates: ${error.message}`);
  }

  const held = await heldAssets(db);
  const coins = held.filter((asset) => asset.assetClass === "crypto");
  const cryptoClient =
    coins.length === 0
      ? null
      : options.cryptoClient === undefined
        ? defaultCryptoClient()
        : options.cryptoClient;
  if (cryptoClient !== null) {
    await updateCryptoPrices(db, cryptoClient, coins, result);
  }

  const securities = held.filter((asset) => asset.assetClass !== "crypto");
  if (client === null) {
    result.problems.push("Stock prices: PRICE_API_KEY is not set");
    return result;
  }
  for (const asset of securities) {
    let close;
    try {
      close = await client.getClosingPrice({
        symbol: asset.symbol,
        isin: asset.isin,
        currency: asset.currency,
      });
    } catch (error) {
      if (!(error instanceof PriceApiError)) throw error;
      result.problems.push(
        `Stock prices stopped at ${asset.symbol}: ${error.message}`,
      );
      break;
    }
    if (close === null) {
      result.unknown.push(asset.symbol);
      continue;
    }
    await storePrice(
      db,
      asset.id,
      { date: close.date, price: close.close, currency: close.currency },
      TWELVE_DATA_SOURCE,
    );
    result.prices++;
  }
  return result;
}
