import { describe, expect, it } from "vitest";
import {
  balanceTypePreference,
  DEFAULT_BALANCE_TYPE_PREFERENCE,
  pickDisplayBalance,
} from "@/server/sync/balance-types";

const balance = (balanceType: string, date: string) => ({ balanceType, date });

describe("pickDisplayBalance", () => {
  it("prefers the available balance over the booked one", () => {
    expect(
      pickDisplayBalance([
        balance("CLBD", "2026-03-09"),
        balance("ITAV", "2026-03-10"),
      ]),
    ).toEqual(balance("ITAV", "2026-03-10"));
  });

  it("takes the latest day of the preferred type", () => {
    expect(
      pickDisplayBalance([
        balance("CLBD", "2026-03-08"),
        balance("CLBD", "2026-03-09"),
        balance("CLBD", "2026-03-07"),
      ]),
    ).toEqual(balance("CLBD", "2026-03-09"));
  });

  it("falls back to an unknown type, picking the same one every time", () => {
    const balances = [
      balance("ZZZZ", "2026-03-10"),
      balance("PRCD", "2026-03-09"),
    ];
    expect(pickDisplayBalance(balances)).toEqual(balances[1]);
    expect(pickDisplayBalance([...balances].reverse())).toEqual(balances[1]);
  });

  it("follows a custom preference", () => {
    expect(
      pickDisplayBalance(
        [balance("ITAV", "2026-03-10"), balance("CLBD", "2026-03-09")],
        ["CLBD"],
      ),
    ).toEqual(balance("CLBD", "2026-03-09"));
  });

  it("returns undefined without balances", () => {
    expect(pickDisplayBalance([])).toBeUndefined();
  });
});

describe("balanceTypePreference", () => {
  it("uses the default for banks without an override", () => {
    expect(balanceTypePreference("Mock ASPSP")).toBe(
      DEFAULT_BALANCE_TYPE_PREFERENCE,
    );
    expect(balanceTypePreference(null)).toBe(DEFAULT_BALANCE_TYPE_PREFERENCE);
  });

  it("prefers the booked balance for Nordea and S-Pankki", () => {
    // The S-Pankki card's ITAV includes its credit limit (FIN-001).
    const card = [balance("ITBD", "2026-10-24"), balance("ITAV", "2026-10-24")];
    for (const bank of ["Nordea", "S-Pankki"]) {
      expect(pickDisplayBalance(card, balanceTypePreference(bank))).toEqual(
        balance("ITBD", "2026-10-24"),
      );
    }
    expect(pickDisplayBalance(card)).toEqual(balance("ITAV", "2026-10-24"));
  });
});
