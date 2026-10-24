import type { CurrencyCode, IsoDate } from "@/server/providers/types";
import {
  SCALE_FACTOR,
  currencyExponent,
  divideRounded,
  parseDecimal,
  pow10,
} from "./decimal";

// The pure part of investment valuation (F-019, D-016): an account's EUR
// value on a day as Σ quantity × price × FX. `src/server/queries/
// investments.ts` loads the rows; this decides which ones apply.

export const VALUATION_CURRENCY = "EUR";

export interface HoldingInput {
  assetId: string;
  date: IsoDate;
  /** Decimal string, as read from `holdings.quantity`. */
  quantity: string;
}

export interface PriceInput {
  assetId: string;
  date: IsoDate;
  /** Unit price in minor units of `currency`, a decimal string. */
  priceMinor: string;
  currency: CurrencyCode;
}

export interface FxRateInput {
  date: IsoDate;
  currency: CurrencyCode;
  /** Units of `currency` per 1 EUR (ECB convention), a decimal string. */
  rate: string;
}

export interface PositionValue {
  assetId: string;
  quantity: string;
  /** Day of the holding snapshot the quantity comes from. */
  holdingDate: IsoDate;
  /** The latest price on or before the valuation day; null if none. */
  price: PriceInput | null;
  /** The latest rate on or before the valuation day; null for EUR or if none. */
  fxRate: FxRateInput | null;
  /** EUR minor units, rounded half away from zero; null when unpriced. */
  valueMinor: number | null;
  /** Why `valueMinor` is null. */
  missing: "price" | "fx_rate" | null;
}

export interface Valuation {
  date: IsoDate;
  currency: typeof VALUATION_CURRENCY;
  /** Σ of the positions' rounded `valueMinor`, unpriced ones left out. */
  valueMinor: number;
  /** Every asset held on the day (quantity > 0), by asset id. */
  positions: PositionValue[];
  /** False when any position lacks a price or an exchange rate. */
  complete: boolean;
}

/** Of `rows`, the latest one per key dated on or before `day`. */
function latestOnOrBefore<T extends { date: IsoDate }>(
  rows: readonly T[],
  day: IsoDate,
  key: (row: T) => string,
): Map<string, T> {
  const latest = new Map<string, T>();
  for (const row of rows) {
    if (row.date > day) continue;
    const current = latest.get(key(row));
    if (!current || row.date > current.date) latest.set(key(row), row);
  }
  return latest;
}

/**
 * EUR minor units of `quantity` units at `priceMinor` (minor units of
 * `currency`) and `rate` units of `currency` per EUR (null for EUR):
 * q × p × 10^e(EUR) / (10^e(currency) × rate), exact until one final
 * rounding.
 */
export function positionValueMinor(
  quantity: string,
  priceMinor: string,
  currency: CurrencyCode,
  rate: string | null,
): number {
  const scale = SCALE_FACTOR;
  let numerator = parseDecimal(quantity) * parseDecimal(priceMinor);
  let denominator = scale * scale;
  if (currency !== VALUATION_CURRENCY) {
    if (rate === null) throw new RangeError(`No rate for ${currency}`);
    numerator *= pow10(currencyExponent(VALUATION_CURRENCY)) * scale;
    denominator *= pow10(currencyExponent(currency)) * parseDecimal(rate);
  }
  const value = divideRounded(numerator, denominator);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`Value out of range: ${value}`);
  }
  return result;
}

/**
 * Values an account's holdings on `date`. Each asset's quantity is its
 * latest snapshot on or before the day (the quantity holds until the next
 * one; 0 = sold out). A day without a price or an exchange rate (weekend,
 * holiday, a failed fetch) falls back to the last known one before it; an
 * asset with no price at all, or a currency with no rate, is listed with
 * `valueMinor: null` and left out of the total.
 */
export function valueHoldings(input: {
  date: IsoDate;
  holdings: readonly HoldingInput[];
  prices: readonly PriceInput[];
  fxRates: readonly FxRateInput[];
}): Valuation {
  const { date } = input;
  const held = latestOnOrBefore(input.holdings, date, (h) => h.assetId);
  const prices = latestOnOrBefore(input.prices, date, (p) => p.assetId);
  const rates = latestOnOrBefore(input.fxRates, date, (r) => r.currency);

  const positions: PositionValue[] = [];
  for (const holding of [...held.values()].sort((a, b) =>
    a.assetId.localeCompare(b.assetId),
  )) {
    if (parseDecimal(holding.quantity) === BigInt(0)) continue;
    const price = prices.get(holding.assetId) ?? null;
    const isEur = price?.currency === VALUATION_CURRENCY;
    const fxRate = price && !isEur ? (rates.get(price.currency) ?? null) : null;
    const missing = !price ? "price" : !isEur && !fxRate ? "fx_rate" : null;
    positions.push({
      assetId: holding.assetId,
      quantity: holding.quantity,
      holdingDate: holding.date,
      price,
      fxRate,
      valueMinor:
        price && !missing
          ? positionValueMinor(
              holding.quantity,
              price.priceMinor,
              price.currency,
              fxRate?.rate ?? null,
            )
          : null,
      missing,
    });
  }

  return {
    date,
    currency: VALUATION_CURRENCY,
    valueMinor: positions.reduce((sum, p) => sum + (p.valueMinor ?? 0), 0),
    positions,
    complete: positions.every((p) => p.missing === null),
  };
}
