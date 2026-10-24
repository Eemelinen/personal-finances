import { describe, expect, it } from "vitest";
import { balanceOn, dailyBalances, dayRange } from "@/server/queries/balances";
import { connectionHealth, sumTotals } from "@/server/queries/dashboard";

const snap = (date: string, amountMinor: number, balanceType = "CLBD") => ({
  date,
  amountMinor,
  currency: "EUR",
  balanceType,
});

describe("balanceOn", () => {
  const snapshots = [
    snap("2026-10-01", 100),
    snap("2026-10-05", 300),
    snap("2026-10-05", 250, "ITAV"),
    snap("2026-10-10", 400),
  ];

  it("is undefined before the first snapshot", () => {
    expect(balanceOn(snapshots, "2026-09-30")).toBeUndefined();
    expect(balanceOn([], "2026-10-01")).toBeUndefined();
  });

  it("carries the last known balance over days without one", () => {
    expect(balanceOn(snapshots, "2026-10-03")?.amountMinor).toBe(100);
  });

  it("prefers the display balance type, as pickDisplayBalance() does", () => {
    // ITAV ranks above CLBD, even when a later CLBD exists.
    expect(balanceOn(snapshots, "2026-10-05")?.amountMinor).toBe(250);
    expect(balanceOn(snapshots, "2026-10-12")?.amountMinor).toBe(250);
    expect(
      balanceOn(snapshots, "2026-10-12", ["CLBD", "ITAV"])?.amountMinor,
    ).toBe(400);
  });

  it("ignores snapshots after the day", () => {
    expect(balanceOn([snap("2026-10-02", 5)], "2026-10-01")).toBeUndefined();
  });
});

describe("dayRange and dailyBalances", () => {
  it("lists the days ending with the last one, across a month end", () => {
    expect(dayRange("2026-03-02", 4)).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
    expect(dayRange("2026-10-24", 90)).toHaveLength(90);
    expect(dayRange("2026-10-24", 90)[0]).toBe("2026-07-27");
  });

  it("gives null before the first snapshot and carries balances forward", () => {
    const days = dayRange("2026-10-04", 5);
    expect(
      dailyBalances([snap("2026-10-01", 100), snap("2026-10-03", 80)], days),
    ).toEqual([
      { date: "2026-09-30", amountMinor: null },
      { date: "2026-10-01", amountMinor: 100 },
      { date: "2026-10-02", amountMinor: 100 },
      { date: "2026-10-03", amountMinor: 80 },
      { date: "2026-10-04", amountMinor: 80 },
    ]);
  });
});

describe("connectionHealth", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000);

  it("is ok without an expiry or with more than 14 days left", () => {
    expect(
      connectionHealth({ status: "active", consentExpiresAt: null }, now),
    ).toBe("ok");
    expect(
      connectionHealth({ status: "active", consentExpiresAt: inDays(15) }, now),
    ).toBe("ok");
  });

  it("is expiring within 14 days", () => {
    expect(
      connectionHealth({ status: "active", consentExpiresAt: inDays(14) }, now),
    ).toBe("expiring");
    expect(
      connectionHealth(
        { status: "active", consentExpiresAt: inDays(0.01) },
        now,
      ),
    ).toBe("expiring");
  });

  it("is expired once the consent ended or the connection is not active", () => {
    expect(
      connectionHealth({ status: "active", consentExpiresAt: now }, now),
    ).toBe("expired");
    expect(
      connectionHealth(
        { status: "expired", consentExpiresAt: inDays(60) },
        now,
      ),
    ).toBe("expired");
    expect(
      connectionHealth({ status: "revoked", consentExpiresAt: null }, now),
    ).toBe("expired");
  });
});

describe("sumTotals", () => {
  it("sums EUR balances per type and the change over accounts that had one", () => {
    const totals = sumTotals([
      { type: "checking", currency: "EUR", today: 1_000, before: 1_500 },
      { type: "checking", currency: "EUR", today: 200, before: undefined },
      { type: "savings", currency: "EUR", today: 5_000, before: 4_000 },
      { type: "brokerage", currency: "EUR", today: 700, before: 700 },
      { type: "savings", currency: "SEK", today: 9_999, before: 1 },
      {
        type: "checking",
        currency: "EUR",
        today: undefined,
        before: undefined,
      },
    ]);
    expect(totals).toEqual({
      currency: "EUR",
      netWorth: { amountMinor: 6_900, changeMinor: 500 },
      checking: { amountMinor: 1_200, changeMinor: -500 },
      savings: { amountMinor: 5_000, changeMinor: 1_000 },
    });
  });

  it("has no change when no account had a balance back then", () => {
    expect(
      sumTotals([
        { type: "checking", currency: "EUR", today: 100, before: undefined },
      ]).netWorth,
    ).toEqual({ amountMinor: 100, changeMinor: null });
    expect(sumTotals([]).savings).toEqual({
      amountMinor: 0,
      changeMinor: null,
    });
  });
});
