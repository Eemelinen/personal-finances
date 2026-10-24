import type { CurrencyCode, IsoDate } from "@/server/providers/types";
import { divideRounded, formatDecimal, parseDecimal } from "./decimal";
import type { InvestmentTransactionType } from "./nordnet-csv";

// Holdings and cost basis derived from an account's investment transactions
// (F-020, D-017). Pure: `import-nordnet.ts` and `queries/investments.ts`
// load the rows.

export interface TransactionInput {
  assetId: string | null;
  type: InvestmentTransactionType;
  tradeDate: IsoDate;
  /** Signed change in units held, a decimal string; null for cash rows. */
  quantity: string | null;
  /** Signed cash effect in integer minor units. */
  amountMinor: number;
  currency: CurrencyCode;
}

export interface DerivedHolding {
  assetId: string;
  date: IsoDate;
  /** Units held at the end of `date`, a decimal string (≥ 0). */
  quantity: string;
}

const ZERO = BigInt(0);

/**
 * Same-day order: units come in before they go out, so a buy and a sell on
 * one day never dip below zero in between.
 */
function chronological(
  transactions: readonly TransactionInput[],
): TransactionInput[] {
  return [...transactions].sort(
    (a, b) =>
      a.tradeDate.localeCompare(b.tradeDate) ||
      Number(parseDecimal(a.quantity ?? "0") < ZERO) -
        Number(parseDecimal(b.quantity ?? "0") < ZERO),
  );
}

/**
 * One holding snapshot per asset and trade day: the units held at the end
 * of that day, summed from every transaction with a quantity. A sum below
 * zero (the export starts after the units were bought) is stored as 0 and
 * the asset is reported in `oversold`; importing the older transactions
 * corrects it.
 */
export function deriveHoldings(transactions: readonly TransactionInput[]): {
  holdings: DerivedHolding[];
  oversold: string[];
} {
  const running = new Map<string, bigint>();
  const byDay = new Map<string, DerivedHolding>();
  const oversold = new Set<string>();
  for (const tx of chronological(transactions)) {
    if (tx.assetId === null || tx.quantity === null) continue;
    let units = (running.get(tx.assetId) ?? ZERO) + parseDecimal(tx.quantity);
    if (units < ZERO) {
      oversold.add(tx.assetId);
      units = ZERO;
    }
    running.set(tx.assetId, units);
    byDay.set(`${tx.assetId}|${tx.tradeDate}`, {
      assetId: tx.assetId,
      date: tx.tradeDate,
      quantity: formatDecimal(units),
    });
  }
  return {
    holdings: [...byDay.values()].sort(
      (a, b) =>
        a.assetId.localeCompare(b.assetId) || a.date.localeCompare(b.date),
    ),
    oversold: [...oversold].sort(),
  };
}

export interface CostBasis {
  /** Units held after every transaction on or before the day. */
  quantity: string;
  /** What the units still held cost, in integer minor units of `currency`. */
  costMinor: number;
  currency: CurrencyCode;
}

/**
 * The average-cost basis per asset on `date`: a buy adds the cash it took
 * (price plus fees), a sell removes the average cost of the units sold;
 * dividends, taxes and fees do not change it. Units received for nothing
 * (staking rewards, F-021) cost 0. Null for an asset whose buys were paid
 * in more than one currency (there is no one basis to show) or that units
 * of unknown cost came into (a Kraken deposit, or a coin-to-coin trade,
 * which has no cash amount).
 */
export function costBasis(
  transactions: readonly TransactionInput[],
  date: IsoDate,
): Map<string, CostBasis | null> {
  const state = new Map<
    string,
    {
      units: bigint;
      cost: bigint;
      currency: CurrencyCode | null;
      /** Several currencies, or units of unknown cost. */
      mixed: boolean;
    }
  >();
  for (const tx of chronological(transactions)) {
    if (tx.tradeDate > date) break;
    if (tx.assetId === null || tx.quantity === null) continue;
    const quantity = parseDecimal(tx.quantity);
    const asset = state.get(tx.assetId) ?? {
      units: ZERO,
      cost: ZERO,
      currency: null,
      mixed: false,
    };
    if (quantity > ZERO) {
      if (
        (asset.currency !== null && asset.currency !== tx.currency) ||
        tx.type === "transfer" ||
        (tx.type === "buy" && tx.amountMinor === 0)
      ) {
        asset.mixed = true;
      }
      asset.currency ??= tx.currency;
      asset.units += quantity;
      asset.cost += BigInt(-tx.amountMinor);
    } else if (quantity < ZERO) {
      const sold = -quantity;
      if (sold >= asset.units) {
        asset.units = ZERO;
        asset.cost = ZERO;
      } else {
        asset.cost -= divideRounded(asset.cost * sold, asset.units);
        asset.units -= sold;
      }
    }
    state.set(tx.assetId, asset);
  }
  const result = new Map<string, CostBasis | null>();
  for (const [assetId, asset] of state) {
    result.set(
      assetId,
      asset.mixed || asset.currency === null
        ? null
        : {
            quantity: formatDecimal(asset.units),
            costMinor: Number(asset.cost),
            currency: asset.currency,
          },
    );
  }
  return result;
}
