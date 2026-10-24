import type { IsoDate } from "@/server/providers/types";
import type { BalancePoint } from "@/server/reports/balance-series";
import { formatDecimal, parseDecimal } from "./decimal";
import type { TransactionInput } from "./holdings";
import {
  VALUATION_CURRENCY,
  positionValueMinor,
  type FxRateInput,
  type HoldingInput,
  type PriceInput,
} from "./valuation";

// Daily values of an investment account (F-022): its holdings valued with
// the prices and rates known on each day (D-016, swept over the days rather
// than looked up per day), the cash its transactions imply when no balance
// is synced (Nordnet), and the money and units moved in or out, which the
// performance counts as contributions. `queries/investment-history.ts`
// loads the rows.

const ZERO = BigInt(0);

export interface Movement {
  assetId: string;
  date: IsoDate;
  /** Signed change in units, a decimal string. */
  quantity: string;
}

export interface HoldingsDay {
  /**
   * EUR value of the holdings at the end of the day, unpriced ones left out;
   * null before the account's first holding snapshot.
   */
  valueMinor: number | null;
  /**
   * EUR value of the day's movements at the day's prices. Units that moved
   * while their asset had no price (or rate) count on the first day it has
   * one, at that day's price, so they are not left to the market gain.
   */
  movedMinor: number;
}

function byDate<T extends { date: IsoDate }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The holdings' value on each of `days` (consecutive, oldest first): each
 * asset's latest snapshot, price and rate on or before the day, as
 * `valueHoldings()` would give for every day, in one pass. Movements dated
 * on one of the days are valued at that day's price; earlier ones are in
 * the first day's value already, unless their asset is still unpriced then.
 * Unpriced movements wait until the asset is priced.
 */
export function holdingsSeries(
  input: {
    holdings: readonly HoldingInput[];
    prices: readonly PriceInput[];
    fxRates: readonly FxRateInput[];
    movements?: readonly Movement[];
  },
  days: readonly IsoDate[],
): HoldingsDay[] {
  const holdings = byDate(input.holdings);
  const prices = byDate(input.prices);
  const rates = byDate(input.fxRates);
  const movements = byDate(input.movements ?? []);
  const quantity = new Map<string, string>();
  const price = new Map<string, PriceInput>();
  const rate = new Map<string, string>();
  // Positions whose quantity, price and rate did not change keep their value.
  const cache = new Map<
    string,
    { quantity: string; price: PriceInput; rate: string | null; value: number }
  >();
  let h = 0;
  let p = 0;
  let r = 0;
  let m = 0;
  /** Units moved in (or out) while unpriced, by asset. */
  const pending = new Map<string, bigint>();

  /** EUR minor units of `units` of the asset today; null when unpriced. */
  const value = (assetId: string, units: string): number | null => {
    const quote = price.get(assetId);
    if (!quote) return null;
    const fx =
      quote.currency === VALUATION_CURRENCY
        ? null
        : (rate.get(quote.currency) ?? undefined);
    if (fx === undefined) return null;
    return positionValueMinor(units, quote.priceMinor, quote.currency, fx);
  };

  return days.map((day) => {
    for (; h < holdings.length && holdings[h].date <= day; h++) {
      quantity.set(holdings[h].assetId, holdings[h].quantity);
    }
    for (; p < prices.length && prices[p].date <= day; p++) {
      price.set(prices[p].assetId, prices[p]);
    }
    for (; r < rates.length && rates[r].date <= day; r++) {
      rate.set(rates[r].currency, rates[r].rate);
    }
    let movedMinor = 0;
    for (; m < movements.length && movements[m].date <= day; m++) {
      const move = movements[m];
      const moved = value(move.assetId, move.quantity);
      if (moved === null) {
        pending.set(
          move.assetId,
          (pending.get(move.assetId) ?? ZERO) + parseDecimal(move.quantity),
        );
      } else if (move.date === day) {
        movedMinor += moved;
      }
    }
    for (const [assetId, units] of pending) {
      const priced = value(assetId, formatDecimal(units));
      if (priced === null) continue;
      movedMinor += priced;
      pending.delete(assetId);
    }
    if (quantity.size === 0) return { valueMinor: null, movedMinor };

    let valueMinor = 0;
    for (const [assetId, units] of quantity) {
      if (parseDecimal(units) === ZERO) continue;
      const quote = price.get(assetId);
      if (!quote) continue;
      const fx =
        quote.currency === VALUATION_CURRENCY
          ? null
          : (rate.get(quote.currency) ?? null);
      const cached = cache.get(assetId);
      if (
        cached &&
        cached.quantity === units &&
        cached.price === quote &&
        cached.rate === fx
      ) {
        valueMinor += cached.value;
        continue;
      }
      const position = value(assetId, units);
      if (position === null) continue;
      cache.set(assetId, {
        quantity: units,
        price: quote,
        rate: fx,
        value: position,
      });
      valueMinor += position;
    }
    return { valueMinor, movedMinor };
  });
}

/**
 * The quantity changes between an account's holding snapshots, for
 * accounts without transactions (manual wallets, F-021): the first
 * snapshot of an asset brings its units in, each later one the difference.
 */
export function snapshotMovements(
  holdings: readonly HoldingInput[],
): Movement[] {
  const last = new Map<string, bigint>();
  const movements: Movement[] = [];
  for (const holding of byDate(holdings)) {
    const units = parseDecimal(holding.quantity);
    const change = units - (last.get(holding.assetId) ?? ZERO);
    last.set(holding.assetId, units);
    if (change === ZERO) continue;
    movements.push({
      assetId: holding.assetId,
      date: holding.date,
      quantity: formatDecimal(change),
    });
  }
  return movements;
}

/**
 * The cash an account's transactions imply on each day: the running sum of
 * every EUR cash effect up to and including the day (deposits, trades,
 * dividends, fees), null before the first one. For accounts whose cash
 * balance is not synced (a Nordnet import, D-017); it is right when the
 * transactions go back to the account's opening.
 */
export function derivedCashSeries(
  transactions: readonly Pick<
    TransactionInput,
    "tradeDate" | "amountMinor" | "currency"
  >[],
  days: readonly IsoDate[],
): (number | null)[] {
  const flows = transactions
    .filter((tx) => tx.currency === VALUATION_CURRENCY)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  let index = 0;
  let cash: number | null = null;
  return days.map((day) => {
    for (; index < flows.length && flows[index].tradeDate <= day; index++) {
      cash = (cash ?? 0) + flows[index].amountMinor;
    }
    return cash;
  });
}

export interface InvestmentAccountSeries {
  /** The holdings' EUR value and the day's moved value, per day. */
  holdings: HoldingsDay[];
  /**
   * Cash implied by the transactions per day, for an account without a
   * synced cash balance; null when the account has one or no transactions.
   */
  derivedCash: (number | null)[] | null;
  /**
   * Money and units moved into (+) or out of (−) the account per day, in
   * EUR minor units at the day's prices: transfers, or for an account
   * without transactions or synced cash the changes between its holding
   * snapshots.
   */
  flows: number[];
}

/**
 * An investment account's daily series: holdings, derived cash (when
 * `syncedCash` is false) and external flows.
 */
export function investmentAccountSeries(
  input: {
    holdings: readonly HoldingInput[];
    prices: readonly PriceInput[];
    fxRates: readonly FxRateInput[];
    transactions: readonly TransactionInput[];
    /** The account has balance snapshots, so its cash is known. */
    syncedCash: boolean;
  },
  days: readonly IsoDate[],
): InvestmentAccountSeries {
  const hasTransactions = input.transactions.length > 0;
  const transfers = input.transactions.filter((tx) => tx.type === "transfer");
  // Snapshot changes are flows only for a wallet with nothing else: with a
  // synced cash balance they may be trades against that cash.
  const movements =
    hasTransactions || input.syncedCash
      ? transfers.flatMap((tx) =>
          tx.assetId !== null && tx.quantity !== null
            ? [
                {
                  assetId: tx.assetId,
                  date: tx.tradeDate,
                  quantity: tx.quantity,
                },
              ]
            : [],
        )
      : snapshotMovements(input.holdings);
  const holdings = holdingsSeries(
    {
      holdings: input.holdings,
      prices: input.prices,
      fxRates: input.fxRates,
      movements,
    },
    days,
  );
  const cashFlows = new Map<IsoDate, number>();
  for (const tx of transfers) {
    if (tx.currency !== VALUATION_CURRENCY) continue;
    cashFlows.set(
      tx.tradeDate,
      (cashFlows.get(tx.tradeDate) ?? 0) + tx.amountMinor,
    );
  }
  return {
    holdings,
    derivedCash:
      hasTransactions && !input.syncedCash
        ? derivedCashSeries(input.transactions, days)
        : null,
    flows: days.map(
      (day, index) => holdings[index].movedMinor + (cashFlows.get(day) ?? 0),
    ),
  };
}

/**
 * An investment account's balance per day: its cash (the synced balance,
 * else the derived one) plus its holdings, known when either is; estimated
 * when the synced cash is.
 */
export function withHoldings(
  cash: readonly BalancePoint[],
  series: InvestmentAccountSeries,
): BalancePoint[] {
  return series.holdings.map((day, index) => {
    const synced = cash[index];
    const cashMinor =
      synced?.amountMinor ?? series.derivedCash?.[index] ?? null;
    if (cashMinor === null && day.valueMinor === null) {
      return { amountMinor: null, estimated: false };
    }
    return {
      amountMinor: (cashMinor ?? 0) + (day.valueMinor ?? 0),
      estimated: synced?.estimated ?? false,
    };
  });
}
