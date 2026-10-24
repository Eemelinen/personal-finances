import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accounts,
  balanceSnapshots,
  institutions,
  transactions,
} from "@/server/db/schema";
import { addDays } from "@/server/dates";
import { dedupeHash } from "@/server/dedupe-hash";
import { getBalanceHistory } from "@/server/queries/balance-history";
import type { BalanceRangeId } from "@/server/reports/balance-series";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// getBalanceHistory() against a real Postgres 18: daily balances carried
// over from snapshots, reconstructed (estimated) before the first snapshot
// from transactions, summed into net worth, over the selectable ranges.
// Each test starts from empty tables; the clock is pinned.

const TIME_ZONE = "Europe/Helsinki";
// 23:30 UTC is already the 24th in Helsinki.
const NOW = new Date("2026-10-23T23:30:00Z");
const TODAY = "2026-10-24";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.db.execute(
    sql`TRUNCATE ${institutions}, ${accounts}, ${balanceSnapshots}, ${transactions} CASCADE`,
  );
});

const history = (range: BalanceRangeId) =>
  getBalanceHistory({ db: testDb.db, now: NOW, timeZone: TIME_ZONE, range });

async function institution(name: string) {
  const [row] = await testDb.db
    .insert(institutions)
    .values({
      name,
      country: "FI",
      provider: "enable_banking",
      providerRef: randomUUID(),
    })
    .returning();
  return row;
}

async function account(
  institutionId: string,
  values: Partial<typeof accounts.$inferInsert> & { name: string },
) {
  const [row] = await testDb.db
    .insert(accounts)
    .values({ institutionId, type: "checking", currency: "EUR", ...values })
    .returning();
  return row;
}

/** Snapshots as `[days before today, amount]`. */
async function snapshots(
  accountId: string,
  rows: [daysAgo: number, amountMinor: number][],
  currency = "EUR",
) {
  await testDb.db.insert(balanceSnapshots).values(
    rows.map(([daysAgo, amountMinor]) => ({
      accountId,
      date: addDays(TODAY, -daysAgo),
      amountMinor,
      currency,
      balanceType: "CLBD",
    })),
  );
}

/** Transactions as `[days before today, amount, status?, currency?]`. */
async function bookings(
  accountId: string,
  rows: [
    daysAgo: number,
    amountMinor: number,
    status?: "booked" | "pending",
    currency?: string,
  ][],
) {
  await testDb.db.insert(transactions).values(
    rows.map(([daysAgo, amountMinor, status, currency], index) => ({
      accountId,
      dedupeHash: dedupeHash({
        bookingDate: addDays(TODAY, -daysAgo),
        amountMinor,
        counterparty: `Row ${index}`,
        description: null,
      }),
      bookingDate: addDays(TODAY, -daysAgo),
      amountMinor,
      currency: currency ?? "EUR",
      counterparty: `Row ${index}`,
      status: status ?? "booked",
    })),
  );
}

/** The point `daysAgo` before today of a series over `days`. */
const at = <T>(days: string[], points: T[], daysAgo: number) =>
  points[days.indexOf(addDays(TODAY, -daysAgo))];

describe("getBalanceHistory", () => {
  it("is empty without accounts with a balance", async () => {
    const bank = await institution("Nordea");
    const imported = await account(bank.id, { name: "CSV-tili" });
    await bookings(imported.id, [[3, -1_000]]);

    const result = await history("3m");
    expect(result.empty).toBe(true);
    expect(result.accounts).toEqual([]);
    expect(result.omitted).toEqual({ withoutBalance: 1, otherCurrency: 0 });
    expect(result.days.at(-1)).toBe(TODAY);
  });

  it("builds each account's series and net worth from snapshots and transactions", async () => {
    const nordea = await institution("Nordea");
    const spankki = await institution("S-Pankki");
    const checking = await account(nordea.id, { name: "Käyttötili" });
    const savings = await account(spankki.id, {
      name: "Säästötili",
      type: "savings",
    });
    // Checking: first synced 20 days ago at 1 000,00, then 800,00 on day -5.
    // Before day -20 it is rebuilt from transactions back to day -40.
    await snapshots(checking.id, [
      [20, 100_000],
      [5, 80_000],
    ]);
    await bookings(checking.id, [
      [40, 50_000],
      [30, -20_000],
      [25, -5_000, "pending"],
      [20, 10_000],
      // Other currency: not part of the EUR balance.
      [22, -99_999, "booked", "SEK"],
      // After the first snapshot: the snapshots say it all.
      [10, -30_000],
    ]);
    // Savings: synced since 60 days ago, no reconstruction in range.
    await snapshots(savings.id, [[60, 500_000]]);

    const {
      days,
      accounts: series,
      netWorth,
      netWorthChange,
      empty,
    } = await history("3m");
    expect(empty).toBe(false);
    expect(days[0]).toBe("2026-07-25");
    expect(days.at(-1)).toBe(TODAY);
    expect(series.map((item) => [item.name, item.institution])).toEqual([
      ["Käyttötili", "Nordea"],
      ["Säästötili", "S-Pankki"],
    ]);
    const [check, save] = series;

    // Synced days and the days carried over.
    expect(at(days, check.points, 0)).toEqual({
      amountMinor: 80_000,
      estimated: false,
    });
    expect(at(days, check.points, 12)).toEqual({
      amountMinor: 100_000,
      estimated: false,
    });
    expect(at(days, check.points, 20)).toEqual({
      amountMinor: 100_000,
      estimated: false,
    });
    // Day -21: 1 000,00 − 100,00 booked on day -20.
    expect(at(days, check.points, 21)).toEqual({
      amountMinor: 90_000,
      estimated: true,
    });
    // Day -26: also + 50,00 pending on day -25.
    expect(at(days, check.points, 26)).toEqual({
      amountMinor: 95_000,
      estimated: true,
    });
    // Day -31: also + 200,00 on day -30; day -40 is the first transaction.
    expect(at(days, check.points, 31)).toEqual({
      amountMinor: 115_000,
      estimated: true,
    });
    expect(at(days, check.points, 40)).toEqual({
      amountMinor: 115_000,
      estimated: true,
    });
    expect(at(days, check.points, 41)).toEqual({
      amountMinor: null,
      estimated: false,
    });

    expect(at(days, save.points, 60)).toEqual({
      amountMinor: 500_000,
      estimated: false,
    });
    expect(at(days, save.points, 61).amountMinor).toBeNull();

    expect(at(days, netWorth, 0)).toEqual({
      amountMinor: 580_000,
      estimated: false,
      partial: false,
    });
    expect(at(days, netWorth, 31)).toEqual({
      amountMinor: 615_000,
      estimated: true,
      partial: false,
    });
    // Checking has no balance yet on day -50: the sum is savings alone.
    expect(at(days, netWorth, 50)).toEqual({
      amountMinor: 500_000,
      estimated: false,
      partial: true,
    });
    expect(netWorth[0]).toEqual({
      amountMinor: null,
      estimated: false,
      partial: false,
    });
    // Nothing was known on the range's first day: no change to show.
    expect(netWorthChange).toBeNull();
  });

  it("selects the range: 3 months, 6 months, 1 year or all", async () => {
    const bank = await institution("Nordea");
    const checking = await account(bank.id, { name: "Käyttötili" });
    await snapshots(checking.id, [[100, 150_000]]);
    await bookings(checking.id, [
      [500, 100_000],
      [150, -20_000],
    ]);

    const start = async (range: BalanceRangeId) => {
      const { days, netWorth } = await history(range);
      return [days[0], days.length, netWorth[0]];
    };
    const complete = { estimated: false, partial: false };
    expect(await start("3m")).toEqual([
      "2026-07-25",
      92,
      { amountMinor: 150_000, ...complete },
    ]);
    expect(await start("6m")).toEqual([
      "2026-04-25",
      183,
      { amountMinor: 170_000, estimated: true, partial: false },
    ]);
    expect(await start("1y")).toEqual([
      "2025-10-25",
      365,
      { amountMinor: 170_000, estimated: true, partial: false },
    ]);
    // All: from the first transaction, 500 days ago.
    expect(await start("all")).toEqual([
      addDays(TODAY, -500),
      501,
      { amountMinor: 170_000, estimated: true, partial: false },
    ]);
  });

  it("leaves out archived accounts and counts the omitted ones", async () => {
    const bank = await institution("Nordea");
    const kept = await account(bank.id, { name: "Käyttötili" });
    const archived = await account(bank.id, {
      name: "Vanha tili",
      archived: true,
    });
    const sek = await account(bank.id, { name: "Kronor", currency: "SEK" });
    await account(bank.id, { name: "CSV-tili" });
    await snapshots(kept.id, [[1, 10_000]]);
    await snapshots(archived.id, [[1, 99_000]]);
    await snapshots(sek.id, [[1, 50_000]], "SEK");

    const result = await history("3m");
    expect(result.accounts.map((item) => item.name)).toEqual(["Käyttötili"]);
    expect(result.netWorth.at(-1)).toEqual({
      amountMinor: 10_000,
      estimated: false,
      partial: false,
    });
    expect(result.omitted).toEqual({ withoutBalance: 1, otherCurrency: 1 });
  });

  it("compares net worth like for like when an account starts within the range", async () => {
    const bank = await institution("Nordea");
    const old = await account(bank.id, { name: "Käyttötili" });
    const added = await account(bank.id, { name: "Uusi tili" });
    await snapshots(old.id, [
      [200, 100_000],
      [10, 130_000],
    ]);
    await snapshots(added.id, [[30, 900_000]]);

    const { days, netWorth, netWorthChange } = await history("3m");
    expect(netWorth[0]).toEqual({
      amountMinor: 100_000,
      estimated: false,
      partial: true,
    });
    expect(at(days, netWorth, 30)).toEqual({
      amountMinor: 1_000_000,
      estimated: false,
      partial: false,
    });
    // +300,00 on the old account; the new account's 9 000,00 is not a gain.
    expect(netWorthChange).toBe(30_000);
  });
});
