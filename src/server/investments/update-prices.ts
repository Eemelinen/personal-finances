import { asc, desc, inArray, ne, sql } from "drizzle-orm";
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
import { fetchEcbRates, type EcbRates } from "./ecb";
import {
  createTwelveDataClient,
  PriceApiError,
  TWELVE_DATA_SOURCE,
  type PriceClient,
} from "./price-client";

// The daily price update (F-020, D-017; the worker's `price-update` job):
// the ECB reference rates, then one closing price per security held today
// (crypto is F-021's). One request per asset through the rate-limited
// client; an unknown symbol is reported and the rest continue, an API that
// refuses (limit, key, outage) stops the run until tomorrow.

export interface PriceUpdateResult {
  fxDate: IsoDate | null;
  fxRates: number;
  /** Prices written. */
  prices: number;
  /** Symbols the price API does not know (or quotes in another currency). */
  unknown: string[];
  /** Why part of the update did not run; empty when everything ran. */
  problems: string[];
}

export interface PriceUpdateOptions {
  db?: Db;
  /** Null skips stock prices; defaults to Twelve Data with `PRICE_API_KEY`. */
  client?: PriceClient | null;
  fetchRates?: () => Promise<EcbRates>;
}

function defaultClient(): PriceClient | null {
  const apiKey = getEnv().PRICE_API_KEY;
  return apiKey ? createTwelveDataClient({ apiKey }) : null;
}

/** Securities some account holds a positive quantity of today. */
async function heldSecurities(db: Db) {
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
      currency: assets.currency,
    })
    .from(assets)
    .where(
      sql`${inArray(
        assets.id,
        held.map((h) => h.assetId),
      )} and ${ne(assets.assetClass, "crypto")}`,
    )
    .orderBy(asc(assets.symbol), asc(assets.id));
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

  if (client === null) {
    result.problems.push("Stock prices: PRICE_API_KEY is not set");
    return result;
  }
  for (const asset of await heldSecurities(db)) {
    let close;
    try {
      close = await client.getClosingPrice(asset);
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
    const priceMinor = formatDecimal(
      parseDecimal(close.close) * pow10(currencyExponent(close.currency)),
    );
    await db
      .insert(prices)
      .values({
        assetId: asset.id,
        date: close.date,
        priceMinor,
        currency: close.currency,
        source: TWELVE_DATA_SOURCE,
      })
      .onConflictDoUpdate({
        target: [prices.assetId, prices.date],
        set: {
          priceMinor,
          currency: close.currency,
          source: TWELVE_DATA_SOURCE,
          updatedAt: sql`now()`,
        },
      });
    result.prices++;
  }
  return result;
}
