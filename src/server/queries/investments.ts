import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import {
  accounts,
  assets,
  fxRates,
  holdings,
  investmentTransactions,
  prices,
} from "@/server/db/schema";
import { parseDecimal } from "@/server/investments/decimal";
import { costBasis } from "@/server/investments/holdings";
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

export interface HoldingRow {
  accountId: string;
  accountName: string;
  assetId: string;
  symbol: string;
  name: string | null;
  isin: string | null;
  assetClass: AssetClass;
  /** Units held, a decimal string. */
  quantity: string;
  /** The price used: the latest on or before the day; null when none. */
  price: {
    priceMinor: string;
    currency: string;
    date: IsoDate;
    source: string;
  } | null;
  /** EUR minor units; null when there is no price or exchange rate. */
  valueMinor: number | null;
  missing: "price" | "fx_rate" | null;
  /** Average cost of the units held in EUR minor units; null if unknown. */
  costMinor: number | null;
  /** Value minus cost; null without both. */
  gainMinor: number | null;
  /** Gain over cost; null without a positive cost. */
  gainShare: number | null;
  /** Share of the portfolio's valued total; null when unvalued. */
  weight: number | null;
}

export interface InvestmentsOverview {
  date: IsoDate;
  /** Non-archived brokerage and crypto accounts. */
  accountCount: number;
  holdings: HoldingRow[];
  /** Σ of the valued holdings, EUR minor units. */
  valueMinor: number;
  /** Σ cost and gain over the holdings that have both. */
  costMinor: number;
  gainMinor: number;
  /** False when a holding lacks a price or an exchange rate. */
  complete: boolean;
}

type AssetClass = (typeof assets.$inferSelect)["assetClass"];

/**
 * Every holding of the non-archived brokerage and crypto accounts on
 * `date` (F-020): quantity, price, EUR value, gain over the average cost
 * and weight in the portfolio, largest value first.
 */
export async function getInvestmentsOverview(
  date: IsoDate,
  options: { db?: Db } = {},
): Promise<InvestmentsOverview> {
  const db = options.db ?? getDb();
  const investmentAccounts = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(
      and(
        eq(accounts.archived, false),
        inArray(accounts.type, ["brokerage", "crypto"]),
      ),
    )
    .orderBy(asc(accounts.name), asc(accounts.id));

  const rows: Omit<HoldingRow, "weight">[] = [];
  for (const account of investmentAccounts) {
    const valuation = await getAccountValuation(account.id, date, { db });
    if (valuation.positions.length === 0) continue;
    const transactions = await db
      .select({
        assetId: investmentTransactions.assetId,
        type: investmentTransactions.type,
        tradeDate: investmentTransactions.tradeDate,
        quantity: investmentTransactions.quantity,
        amountMinor: investmentTransactions.amountMinor,
        currency: investmentTransactions.currency,
      })
      .from(investmentTransactions)
      .where(eq(investmentTransactions.accountId, account.id));
    const bases = costBasis(transactions, date);
    const assetRows = await db
      .select()
      .from(assets)
      .where(
        inArray(
          assets.id,
          valuation.positions.map((p) => p.assetId),
        ),
      );
    const byId = new Map(assetRows.map((a) => [a.id, a]));
    const priceRows = await db
      .select({
        assetId: prices.assetId,
        date: prices.date,
        source: prices.source,
      })
      .from(prices)
      .where(
        inArray(
          prices.assetId,
          valuation.positions.map((p) => p.assetId),
        ),
      );
    const sources = new Map(
      priceRows.map((p) => [`${p.assetId}|${p.date}`, p.source]),
    );
    for (const position of valuation.positions) {
      const asset = byId.get(position.assetId)!;
      const basis = bases.get(position.assetId);
      // A basis that matches the quantity held (holdings and transactions
      // agree) in EUR; otherwise the gain is unknown.
      const costMinor =
        basis &&
        basis.currency === VALUATION_CURRENCY &&
        parseDecimal(basis.quantity) === parseDecimal(position.quantity)
          ? basis.costMinor
          : null;
      const gainMinor =
        costMinor !== null && position.valueMinor !== null
          ? position.valueMinor - costMinor
          : null;
      rows.push({
        accountId: account.id,
        accountName: account.name,
        assetId: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        isin: asset.isin,
        assetClass: asset.assetClass,
        quantity: position.quantity,
        price: position.price
          ? {
              priceMinor: position.price.priceMinor,
              currency: position.price.currency,
              date: position.price.date,
              source:
                sources.get(`${position.assetId}|${position.price.date}`) ?? "",
            }
          : null,
        valueMinor: position.valueMinor,
        missing: position.missing,
        costMinor,
        gainMinor,
        gainShare:
          gainMinor !== null && costMinor !== null && costMinor > 0
            ? gainMinor / costMinor
            : null,
      });
    }
  }

  return summariseHoldings(date, investmentAccounts.length, rows);
}

/** Weights, totals and order of the holdings (pure). */
export function summariseHoldings(
  date: IsoDate,
  accountCount: number,
  rows: readonly Omit<HoldingRow, "weight">[],
): InvestmentsOverview {
  const valueMinor = rows.reduce((sum, r) => sum + (r.valueMinor ?? 0), 0);
  let costMinor = 0;
  let gainMinor = 0;
  for (const row of rows) {
    if (row.costMinor === null || row.gainMinor === null) continue;
    costMinor += row.costMinor;
    gainMinor += row.gainMinor;
  }
  const holdings = rows
    .map((row) => ({
      ...row,
      weight:
        row.valueMinor !== null && valueMinor > 0
          ? row.valueMinor / valueMinor
          : null,
    }))
    .sort(
      (a, b) =>
        (b.valueMinor ?? -Infinity) - (a.valueMinor ?? -Infinity) ||
        a.symbol.localeCompare(b.symbol) ||
        a.accountName.localeCompare(b.accountName),
    );
  return {
    date,
    accountCount,
    holdings,
    valueMinor,
    costMinor,
    gainMinor,
    complete: rows.every((r) => r.missing === null),
  };
}
