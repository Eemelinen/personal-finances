import { describe, expect, it } from "vitest";
import {
  ManualHoldingError,
  normaliseManualHolding,
} from "@/server/investments/manual-holdings";

// Input checks of manual crypto holdings (F-021); storing them is covered by
// tests/integration/crypto-holdings.int.test.ts.

const BASE = {
  wallet: " Ledger ",
  symbol: "btc",
  coingeckoId: null,
  quantity: "0,25",
  date: "2026-10-24",
};

describe("normaliseManualHolding", () => {
  it("trims, upper-cases the symbol and fills a known CoinGecko id", () => {
    expect(normaliseManualHolding(BASE)).toEqual({
      wallet: "Ledger",
      symbol: "BTC",
      coingeckoId: "bitcoin",
      quantity: "0.25",
      date: "2026-10-24",
    });
  });

  it("keeps a given CoinGecko id and leaves an unknown coin without one", () => {
    expect(
      normaliseManualHolding({
        ...BASE,
        symbol: "abc",
        coingeckoId: " Abc-Coin ",
      }).coingeckoId,
    ).toBe("abc-coin");
    expect(normaliseManualHolding({ ...BASE, symbol: "abc" }).coingeckoId).toBe(
      null,
    );
  });

  it("accepts 0 to record that the coins are gone", () => {
    expect(normaliseManualHolding({ ...BASE, quantity: "0" }).quantity).toBe(
      "0",
    );
  });

  it.each([
    [{ wallet: "  " }, /Name the wallet/],
    [{ symbol: "B T C" }, /coin symbol/],
    [{ coingeckoId: "bit coin" }, /CoinGecko id/],
    [{ quantity: "abc" }, /quantity must be a number/],
    [{ quantity: "1e-3" }, /quantity must be a number/],
    [{ quantity: "-1" }, /cannot be negative/],
    [{ quantity: "0.0000000000000000001" }, /at most 18 decimals/],
  ])("rejects %j", (change, message) => {
    expect(() => normaliseManualHolding({ ...BASE, ...change })).toThrow(
      ManualHoldingError,
    );
    expect(() => normaliseManualHolding({ ...BASE, ...change })).toThrow(
      message,
    );
  });
});
