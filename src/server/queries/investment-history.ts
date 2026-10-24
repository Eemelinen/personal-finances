import { and, asc, desc, gte, inArray, lt, lte, min } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import {
  balanceSnapshots,
  fxRates,
  holdings,
  investmentTransactions,
  prices,
} from "@/server/db/schema";
import {
  VALUATION_CURRENCY,
  valueHoldings,
  type FxRateInput,
  type HoldingInput,
  type PriceInput,
  type Valuation,
} from "@/server/investments/valuation";
import {
  investmentAccountSeries,
  type InvestmentAccountSeries,
} from "@/server/investments/valuation-series";
import type { IsoDate } from "@/server/providers/types";

// Loads the rows behind the daily values of brokerage and crypto accounts
// (F-022): every holding snapshot and investment transaction up to the last
// day, and the prices and exchange rates of the days plus the last ones
// before them, which carry over into the first day. One set of queries for
// all accounts, rather than a valuation query per account and day (D-016).

export interface InvestmentHistoryAccount {
  id: string;
  /** The account has balance snapshots, so its cash is synced. */
  syncedCash: boolean;
}

export interface LoadedInvestmentAccount extends InvestmentAccountSeries {
  /** The holdings valued on the last day, position by position. */
  last: Valuation;
}

/** The latest row per key before `day` plus every row from `day` to `to`. */
async function latestAndRange<T>(
  load: (where: "before" | "range") => Promise<T[]>,
): Promise<T[]> {
  const [before, range] = await Promise.all([load("before"), load("range")]);
  return [...before, ...range];
}

/**
 * Each account's daily series over `days` (consecutive, oldest first), by
 * account id.
 */
export async function loadInvestmentHistory(
  db: Db,
  accounts: readonly InvestmentHistoryAccount[],
  days: readonly IsoDate[],
): Promise<Map<string, LoadedInvestmentAccount>> {
  const result = new Map<string, LoadedInvestmentAccount>();
  const first = days[0];
  const last = days.at(-1);
  if (accounts.length === 0 || first === undefined || last === undefined) {
    return result;
  }
  const ids = accounts.map((account) => account.id);

  const [holdingRows, transactionRows] = await Promise.all([
    db
      .select({
        accountId: holdings.accountId,
        assetId: holdings.assetId,
        date: holdings.date,
        quantity: holdings.quantity,
      })
      .from(holdings)
      .where(and(inArray(holdings.accountId, ids), lte(holdings.date, last))),
    db
      .select({
        accountId: investmentTransactions.accountId,
        assetId: investmentTransactions.assetId,
        type: investmentTransactions.type,
        tradeDate: investmentTransactions.tradeDate,
        quantity: investmentTransactions.quantity,
        amountMinor: investmentTransactions.amountMinor,
        currency: investmentTransactions.currency,
      })
      .from(investmentTransactions)
      .where(
        and(
          inArray(investmentTransactions.accountId, ids),
          lte(investmentTransactions.tradeDate, last),
        ),
      ),
  ]);

  const assetIds = [...new Set(holdingRows.map((row) => row.assetId))];
  const priceColumns = {
    assetId: prices.assetId,
    date: prices.date,
    priceMinor: prices.priceMinor,
    currency: prices.currency,
  };
  const priceRows: PriceInput[] = assetIds.length
    ? await latestAndRange((where) =>
        where === "before"
          ? db
              .selectDistinctOn([prices.assetId], priceColumns)
              .from(prices)
              .where(
                and(inArray(prices.assetId, assetIds), lt(prices.date, first)),
              )
              .orderBy(asc(prices.assetId), desc(prices.date))
          : db
              .select(priceColumns)
              .from(prices)
              .where(
                and(
                  inArray(prices.assetId, assetIds),
                  gte(prices.date, first),
                  lte(prices.date, last),
                ),
              ),
      )
    : [];

  const currencies = [...new Set(priceRows.map((row) => row.currency))].filter(
    (currency) => currency !== VALUATION_CURRENCY,
  );
  const rateColumns = {
    date: fxRates.date,
    currency: fxRates.currency,
    rate: fxRates.rate,
  };
  const rateRows: FxRateInput[] = currencies.length
    ? await latestAndRange((where) =>
        where === "before"
          ? db
              .selectDistinctOn([fxRates.currency], rateColumns)
              .from(fxRates)
              .where(
                and(
                  inArray(fxRates.currency, currencies),
                  lt(fxRates.date, first),
                ),
              )
              .orderBy(asc(fxRates.currency), desc(fxRates.date))
          : db
              .select(rateColumns)
              .from(fxRates)
              .where(
                and(
                  inArray(fxRates.currency, currencies),
                  gte(fxRates.date, first),
                  lte(fxRates.date, last),
                ),
              ),
      )
    : [];

  const holdingsOf = groupBy(holdingRows);
  const transactionsOf = groupBy(transactionRows);
  for (const account of accounts) {
    const own: HoldingInput[] = holdingsOf.get(account.id) ?? [];
    const series = investmentAccountSeries(
      {
        holdings: own,
        prices: priceRows,
        fxRates: rateRows,
        transactions: transactionsOf.get(account.id) ?? [],
        syncedCash: account.syncedCash,
      },
      days,
    );
    result.set(account.id, {
      ...series,
      last: valueHoldings({
        date: last,
        holdings: own,
        prices: priceRows,
        fxRates: rateRows,
      }),
    });
  }
  return result;
}

function groupBy<T extends { accountId: string }>(
  rows: readonly T[],
): Map<string, Omit<T, "accountId">[]> {
  const groups = new Map<string, Omit<T, "accountId">[]>();
  for (const { accountId, ...row } of rows) {
    const list = groups.get(accountId);
    if (list) list.push(row);
    else groups.set(accountId, [row]);
  }
  return groups;
}

/**
 * The first day per account of its balance snapshots, holding snapshots or
 * investment transactions, by account id.
 */
export async function firstDates(
  db: Db,
  source: "snapshot" | "holding" | "trade",
  accountIds: readonly string[],
): Promise<Map<string, IsoDate>> {
  if (accountIds.length === 0) return new Map();
  const ids = [...accountIds];
  const rows =
    source === "snapshot"
      ? await db
          .select({
            accountId: balanceSnapshots.accountId,
            date: min(balanceSnapshots.date),
          })
          .from(balanceSnapshots)
          .where(inArray(balanceSnapshots.accountId, ids))
          .groupBy(balanceSnapshots.accountId)
      : source === "holding"
        ? await db
            .select({ accountId: holdings.accountId, date: min(holdings.date) })
            .from(holdings)
            .where(inArray(holdings.accountId, ids))
            .groupBy(holdings.accountId)
        : await db
            .select({
              accountId: investmentTransactions.accountId,
              date: min(investmentTransactions.tradeDate),
            })
            .from(investmentTransactions)
            .where(inArray(investmentTransactions.accountId, ids))
            .groupBy(investmentTransactions.accountId);
  return new Map(
    rows.flatMap((row) =>
      row.date === null ? [] : [[row.accountId, row.date] as const],
    ),
  );
}
