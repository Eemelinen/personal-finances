import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { fxRates, holdings, prices } from "@/server/db/schema";
import {
  VALUATION_CURRENCY,
  valueHoldings,
  type Valuation,
} from "@/server/investments/valuation";
import type { IsoDate } from "@/server/providers/types";

// Loads what `valueHoldings()` needs for one account and day: the latest
// holding snapshot, price and exchange rate on or before the day.

/**
 * The account's EUR value on `date` (`APP_TIMEZONE` calendar day) as
 * Σ quantity × price × FX over its holdings (F-019, D-016). Cash balances
 * are not included; they live in `balance_snapshots`.
 */
export async function getAccountValuation(
  accountId: string,
  date: IsoDate,
  options: { db?: Db } = {},
): Promise<Valuation> {
  const db = options.db ?? getDb();

  const held = await db
    .selectDistinctOn([holdings.assetId], {
      assetId: holdings.assetId,
      date: holdings.date,
      quantity: holdings.quantity,
    })
    .from(holdings)
    .where(and(eq(holdings.accountId, accountId), lte(holdings.date, date)))
    .orderBy(asc(holdings.assetId), desc(holdings.date));

  const assetIds = held.map((h) => h.assetId);
  const latestPrices = assetIds.length
    ? await db
        .selectDistinctOn([prices.assetId], {
          assetId: prices.assetId,
          date: prices.date,
          priceMinor: prices.priceMinor,
          currency: prices.currency,
        })
        .from(prices)
        .where(and(inArray(prices.assetId, assetIds), lte(prices.date, date)))
        .orderBy(asc(prices.assetId), desc(prices.date))
    : [];

  const currencies = [...new Set(latestPrices.map((p) => p.currency))].filter(
    (c) => c !== VALUATION_CURRENCY,
  );
  const latestRates = currencies.length
    ? await db
        .selectDistinctOn([fxRates.currency], {
          date: fxRates.date,
          currency: fxRates.currency,
          rate: fxRates.rate,
        })
        .from(fxRates)
        .where(
          and(inArray(fxRates.currency, currencies), lte(fxRates.date, date)),
        )
        .orderBy(asc(fxRates.currency), desc(fxRates.date))
    : [];

  return valueHoldings({
    date,
    holdings: held,
    prices: latestPrices,
    fxRates: latestRates,
  });
}
