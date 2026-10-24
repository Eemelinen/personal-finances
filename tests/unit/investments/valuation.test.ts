import { describe, expect, it } from "vitest";
import { assetClass } from "@/server/db/schema";
import {
  currencyExponent,
  divideRounded,
  formatDecimal,
  parseDecimal,
} from "@/server/investments/decimal";
import {
  positionValueMinor,
  valueHoldings,
  type FxRateInput,
  type HoldingInput,
  type PriceInput,
} from "@/server/investments/valuation";
import type { ProviderAssetClass } from "@/server/providers/types";

const NOKIA = "asset-nokia";
const APPLE = "asset-apple";
const BTC = "asset-btc";

function holding(
  assetId: string,
  date: string,
  quantity: string,
): HoldingInput {
  return { assetId, date, quantity };
}

function price(
  assetId: string,
  date: string,
  priceMinor: string,
  currency = "EUR",
): PriceInput {
  return { assetId, date, priceMinor, currency };
}

function rate(date: string, currency: string, value: string): FxRateInput {
  return { date, currency, rate: value };
}

describe("parseDecimal() / formatDecimal()", () => {
  it("round-trips 18 decimals exactly", () => {
    const value = "12345678901234567890.123456789012345678";
    expect(formatDecimal(parseDecimal(value))).toBe(value);
    expect(parseDecimal("0.000000000000000001")).toBe(BigInt(1));
  });

  it("accepts signs, padding zeros and a bare fraction", () => {
    expect(formatDecimal(parseDecimal("-0.5"))).toBe("-0.5");
    expect(formatDecimal(parseDecimal("+3"))).toBe("3");
    expect(formatDecimal(parseDecimal(".25"))).toBe("0.25");
    expect(formatDecimal(parseDecimal("7."))).toBe("7");
    expect(formatDecimal(parseDecimal("1.234500000000000000000"))).toBe(
      "1.2345",
    );
    expect(formatDecimal(parseDecimal("0"))).toBe("0");
  });

  it("rejects floats in exponent form, junk and more than 18 decimals", () => {
    for (const bad of ["1e-7", "abc", "", "1,5", "0.0000000000000000001"]) {
      expect(() => parseDecimal(bad), bad).toThrow(RangeError);
    }
  });
});

describe("divideRounded()", () => {
  it("rounds half away from zero", () => {
    expect(divideRounded(BigInt(5), BigInt(2))).toBe(BigInt(3));
    expect(divideRounded(-BigInt(5), BigInt(2))).toBe(-BigInt(3));
    expect(divideRounded(BigInt(149), BigInt(100))).toBe(BigInt(1));
    expect(divideRounded(BigInt(150), BigInt(100))).toBe(BigInt(2));
    expect(() => divideRounded(BigInt(1), BigInt(0))).toThrow(RangeError);
  });
});

describe("currencyExponent()", () => {
  it("knows the minor-unit digits", () => {
    expect(currencyExponent("EUR")).toBe(2);
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
  });
});

describe("positionValueMinor()", () => {
  it("is quantity × price for EUR", () => {
    // 120 shares at 4.2350 € = 508.20 €
    expect(positionValueMinor("120", "423.5", "EUR", null)).toBe(50_820);
  });

  it("converts with the ECB rate (currency per EUR)", () => {
    // 10 shares at 189.99 USD, 1.0850 USD per EUR = 1751.06 €
    expect(positionValueMinor("10", "18999", "USD", "1.085")).toBe(175_106);
  });

  it("scales currencies with other minor units", () => {
    // 100 shares at 2500 JPY (minor = yen), 160 JPY per EUR = 1562.50 €
    expect(positionValueMinor("100", "2500", "JPY", "160")).toBe(156_250);
  });

  it("keeps fractional quantities and sub-cent prices exact until the final rounding", () => {
    // 0.123456789012345678 BTC at 61 234.56 € = 7559.82… €
    expect(
      positionValueMinor("0.123456789012345678", "6123456", "EUR", null),
    ).toBe(755_982);
    // 1 000 000 coins at 0.0012345 € (0.12345 cents) = 1234.50 €
    expect(positionValueMinor("1000000", "0.12345", "EUR", null)).toBe(123_450);
    // Half a cent rounds up.
    expect(positionValueMinor("1", "0.5", "EUR", null)).toBe(1);
    expect(positionValueMinor("1", "0.499999999999999999", "EUR", null)).toBe(
      0,
    );
  });

  it("needs a rate for a non-EUR price", () => {
    expect(() => positionValueMinor("1", "100", "USD", null)).toThrow(
      RangeError,
    );
  });
});

describe("valueHoldings()", () => {
  it("sums quantity × price × FX over the account's positions", () => {
    const valuation = valueHoldings({
      date: "2026-10-20",
      holdings: [
        holding(NOKIA, "2026-10-01", "120"),
        holding(APPLE, "2026-10-01", "10"),
        holding(BTC, "2026-10-01", "0.05"),
      ],
      prices: [
        price(NOKIA, "2026-10-20", "423.5"),
        price(APPLE, "2026-10-20", "18999", "USD"),
        price(BTC, "2026-10-20", "6000000"),
      ],
      fxRates: [rate("2026-10-20", "USD", "1.085")],
    });

    expect(valuation.currency).toBe("EUR");
    expect(valuation.complete).toBe(true);
    expect(
      Object.fromEntries(
        valuation.positions.map((p) => [p.assetId, p.valueMinor]),
      ),
    ).toEqual({ [NOKIA]: 50_820, [APPLE]: 175_106, [BTC]: 300_000 });
    expect(valuation.valueMinor).toBe(50_820 + 175_106 + 300_000);
  });

  it("falls back to the last known price when the day has none", () => {
    const valuation = valueHoldings({
      // A Sunday: the last close was on Friday.
      date: "2026-10-18",
      holdings: [holding(NOKIA, "2026-10-01", "100")],
      prices: [
        price(NOKIA, "2026-10-15", "400"),
        price(NOKIA, "2026-10-16", "410"),
        price(NOKIA, "2026-10-19", "999"),
      ],
      fxRates: [],
    });

    expect(valuation.positions[0]!.price?.date).toBe("2026-10-16");
    expect(valuation.valueMinor).toBe(41_000);
    expect(valuation.complete).toBe(true);
  });

  it("falls back to the last known exchange rate too", () => {
    const valuation = valueHoldings({
      date: "2026-10-18",
      holdings: [holding(APPLE, "2026-10-01", "10")],
      prices: [price(APPLE, "2026-10-18", "20000", "USD")],
      fxRates: [
        rate("2026-10-15", "USD", "1.2"),
        rate("2026-10-16", "USD", "1.25"),
        rate("2026-10-19", "USD", "2"),
        rate("2026-10-18", "SEK", "11"),
      ],
    });

    expect(valuation.positions[0]!.fxRate?.date).toBe("2026-10-16");
    // 10 × 200 USD / 1.25 = 1600 €
    expect(valuation.valueMinor).toBe(160_000);
  });

  it("uses the latest holding snapshot on or before the day and skips sold-out assets", () => {
    const valuation = valueHoldings({
      date: "2026-10-10",
      holdings: [
        holding(NOKIA, "2026-09-01", "100"),
        holding(NOKIA, "2026-10-05", "150"),
        holding(NOKIA, "2026-10-11", "1"),
        holding(BTC, "2026-09-01", "1"),
        holding(BTC, "2026-10-01", "0"),
        holding(APPLE, "2026-10-11", "5"),
      ],
      prices: [
        price(NOKIA, "2026-10-10", "400"),
        price(BTC, "2026-10-10", "1"),
      ],
      fxRates: [],
    });

    expect(valuation.positions.map((p) => [p.assetId, p.quantity])).toEqual([
      [NOKIA, "150"],
    ]);
    expect(valuation.positions[0]!.holdingDate).toBe("2026-10-05");
    expect(valuation.valueMinor).toBe(60_000);
  });

  it("lists an asset without any earlier price or rate as unvalued and leaves it out of the total", () => {
    const valuation = valueHoldings({
      date: "2026-10-10",
      holdings: [
        holding(NOKIA, "2026-10-01", "100"),
        holding(APPLE, "2026-10-01", "10"),
        holding(BTC, "2026-10-01", "1"),
      ],
      prices: [
        price(NOKIA, "2026-10-10", "400"),
        price(APPLE, "2026-10-10", "20000", "USD"),
        // Only a price after the day.
        price(BTC, "2026-10-11", "6000000"),
      ],
      // Only a rate after the day.
      fxRates: [rate("2026-10-11", "USD", "1.1")],
    });

    expect(
      valuation.positions.map((p) => [p.assetId, p.valueMinor, p.missing]),
    ).toEqual([
      [APPLE, null, "fx_rate"],
      [BTC, null, "price"],
      [NOKIA, 40_000, null],
    ]);
    expect(valuation.valueMinor).toBe(40_000);
    expect(valuation.complete).toBe(false);
  });

  it("is zero and complete for an account without holdings", () => {
    const valuation = valueHoldings({
      date: "2026-10-10",
      holdings: [holding(NOKIA, "2026-10-11", "100")],
      prices: [price(NOKIA, "2026-10-10", "400")],
      fxRates: [],
    });
    expect(valuation).toEqual({
      date: "2026-10-10",
      currency: "EUR",
      valueMinor: 0,
      positions: [],
      complete: true,
    });
  });
});

describe("ProviderHolding", () => {
  it("uses the asset_class enum's values", () => {
    const classes: ProviderAssetClass[] = [
      "stock",
      "etf",
      "fund",
      "crypto",
      "other",
    ];
    expect(assetClass.enumValues).toEqual(classes);
  });
});
