import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import {
  accounts,
  balanceSnapshots,
  connections,
  institutions,
} from "@/server/db/schema";
import { createFakeProvider, FAKE_SESSION_REFS } from "@/server/providers/fake";
import { createProviderRegistry } from "@/server/providers/registry";
import {
  getDashboardOverview,
  SPARKLINE_DAYS,
} from "@/server/queries/dashboard";
import { syncBalances } from "@/server/sync/sync-balances";
import { addDays } from "@/server/sync/transaction-merge";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// getDashboardOverview() against a real Postgres 18: totals, the 30-day
// change and sparklines from balance snapshots, accounts grouped by bank and
// connection health. Each test starts from empty tables; the clock is pinned.

const TIME_ZONE = "Europe/Helsinki";
// 23:30 UTC is already the 24th in Helsinki.
const NOW = new Date("2026-10-23T23:30:00Z");
const TODAY = "2026-10-24";
const DAY_MS = 86_400_000;

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.db.execute(
    sql`TRUNCATE ${institutions}, ${connections}, ${accounts}, ${balanceSnapshots} CASCADE`,
  );
});

const overview = () =>
  getDashboardOverview({ db: testDb.db, now: NOW, timeZone: TIME_ZONE });

async function institution(name: string, provider = "enable_banking") {
  const [row] = await testDb.db
    .insert(institutions)
    .values({ name, country: "FI", provider, providerRef: randomUUID() })
    .returning();
  return row;
}

async function connection(
  institutionId: string,
  values: Partial<typeof connections.$inferInsert> = {},
) {
  const [row] = await testDb.db
    .insert(connections)
    .values({ institutionId, provider: "enable_banking", ...values })
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

/** Snapshots as `[days before today, amount, balance type?]`. */
async function snapshots(
  accountId: string,
  rows: [daysAgo: number, amountMinor: number, balanceType?: string][],
  currency = "EUR",
) {
  await testDb.db.insert(balanceSnapshots).values(
    rows.map(([daysAgo, amountMinor, balanceType]) => ({
      accountId,
      date: addDays(TODAY, -daysAgo),
      amountMinor,
      currency,
      balanceType: balanceType ?? "CLBD",
    })),
  );
}

describe("getDashboardOverview", () => {
  it("is empty without accounts", async () => {
    const result = await overview();
    expect(result.empty).toBe(true);
    expect(result.today).toBe(TODAY);
    expect(result.banks).toEqual([]);
    expect(result.connections).toEqual([]);
    expect(result.totals).toEqual({
      currency: "EUR",
      netWorth: { amountMinor: 0, changeMinor: null },
      checking: { amountMinor: 0, changeMinor: null },
      savings: { amountMinor: 0, changeMinor: null },
    });
  });

  it("sums net worth and per-type totals with the change vs 30 days ago", async () => {
    const bank = await institution("Nordea");
    const checking = await account(bank.id, { name: "Käyttötili" });
    const savings = await account(bank.id, {
      name: "Säästötili",
      type: "savings",
    });
    const brokerage = await account(bank.id, {
      name: "Arvo-osuustili",
      type: "brokerage",
    });
    await snapshots(checking.id, [
      [40, 100_000],
      [30, 120_000],
      [10, 90_000],
      [0, 85_050],
    ]);
    await snapshots(savings.id, [
      [31, 500_000],
      [1, 510_000],
    ]);
    await snapshots(brokerage.id, [[30, 200_000]]);

    const { totals, empty } = await overview();
    expect(empty).toBe(false);
    // Checking: 850.50 now, 1 200.00 on day -30.
    expect(totals.checking).toEqual({
      amountMinor: 85_050,
      changeMinor: -34_950,
    });
    // Savings: day -1 carries over to today, day -31 over to day -30.
    expect(totals.savings).toEqual({
      amountMinor: 510_000,
      changeMinor: 10_000,
    });
    // Net worth counts every account type.
    expect(totals.netWorth).toEqual({
      amountMinor: 795_050,
      changeMinor: -24_950,
    });
  });

  it("leaves accounts without a balance 30 days ago out of the change", async () => {
    const bank = await institution("S-Pankki");
    const old = await account(bank.id, { name: "Old" });
    const fresh = await account(bank.id, { name: "Opened last week" });
    await snapshots(old.id, [
      [45, 10_000],
      [0, 12_000],
    ]);
    await snapshots(fresh.id, [[7, 50_000]]);

    const { totals } = await overview();
    expect(totals.checking).toEqual({
      amountMinor: 62_000,
      changeMinor: 2_000,
    });

    await testDb.db.delete(balanceSnapshots);
    await snapshots(fresh.id, [[7, 50_000]]);
    expect((await overview()).totals.netWorth).toEqual({
      amountMinor: 50_000,
      changeMinor: null,
    });
  });

  it("uses the display balance type and carries balances from before the window", async () => {
    const bank = await institution("Nordea");
    const checking = await account(bank.id, { name: "Käyttötili" });
    // ITAV (available) ranks above CLBD (closed booked); a CLBD from long
    // before the 90-day window still counts on every later day.
    await snapshots(checking.id, [
      [400, 30_000],
      [1, 40_000],
      [0, 41_000, "ITAV"],
      [0, 39_000, "CLBD"],
    ]);

    const { banks, totals } = await overview();
    const summary = banks[0].accounts[0];
    expect(summary.balance).toEqual({
      amountMinor: 41_000,
      date: TODAY,
      balanceType: "ITAV",
    });
    expect(totals.checking).toEqual({
      amountMinor: 41_000,
      changeMinor: 11_000,
    });
    expect(summary.sparkline).toHaveLength(SPARKLINE_DAYS);
    expect(summary.sparkline[0]).toEqual({
      date: addDays(TODAY, -(SPARKLINE_DAYS - 1)),
      amountMinor: 30_000,
    });
    expect(summary.sparkline.at(-2)).toEqual({
      date: addDays(TODAY, -1),
      amountMinor: 40_000,
    });
    expect(summary.sparkline.at(-1)).toEqual({
      date: TODAY,
      amountMinor: 41_000,
    });
  });

  it("gives the sparkline gaps before the first snapshot and ignores future ones", async () => {
    const bank = await institution("Nordea");
    const checking = await account(bank.id, { name: "Käyttötili" });
    await snapshots(checking.id, [
      [3, 1_000],
      [-1, 9_999],
    ]);

    const [summary] = (await overview()).banks[0].accounts;
    expect(summary.balance?.amountMinor).toBe(1_000);
    const known = summary.sparkline.filter((p) => p.amountMinor !== null);
    expect(known.map((p) => p.date)).toEqual(
      [3, 2, 1, 0].map((days) => addDays(TODAY, -days)),
    );
  });

  it("groups accounts by bank, synced and imported together, and skips archived ones", async () => {
    const nordeaApi = await institution("Nordea");
    const nordeaCsv = await institution("Nordea", "csv");
    const spankki = await institution("S-Pankki");
    const synced = await connection(nordeaApi.id, {
      lastSyncedAt: new Date("2026-10-23T05:00:00Z"),
    });
    await account(nordeaApi.id, {
      name: "Säästötili",
      type: "savings",
      connectionId: synced.id,
    });
    await account(nordeaApi.id, {
      name: "Käyttötili",
      connectionId: synced.id,
      iban: "FI00 1234 5600 0007 85",
    });
    await account(nordeaCsv.id, { name: "Imported" });
    await account(spankki.id, { name: "Archived", archived: true });
    await account(spankki.id, { name: "S-tili" });

    const { banks } = await overview();
    expect(
      banks.map((bank) => [bank.name, bank.accounts.map((a) => a.name)]),
    ).toEqual([
      ["Nordea", ["Imported", "Käyttötili", "Säästötili"]],
      ["S-Pankki", ["S-tili"]],
    ]);
    const nordea = banks[0].accounts;
    expect(nordea[0]).toMatchObject({
      manual: true,
      lastSyncedAt: null,
      balance: null,
    });
    expect(nordea[1]).toMatchObject({
      manual: false,
      iban: "FI00 1234 5600 0007 85",
      lastSyncedAt: new Date("2026-10-23T05:00:00Z"),
    });
    expect(nordea[0].sparkline.every((p) => p.amountMinor === null)).toBe(true);
  });

  it("sums only EUR accounts", async () => {
    const bank = await institution("Nordea");
    const eur = await account(bank.id, { name: "EUR" });
    const sek = await account(bank.id, { name: "SEK", currency: "SEK" });
    await snapshots(eur.id, [[0, 1_000]]);
    await snapshots(sek.id, [[0, 50_000]], "SEK");

    const { banks, totals } = await overview();
    expect(totals.netWorth.amountMinor).toBe(1_000);
    expect(banks[0].accounts.find((a) => a.name === "SEK")?.balance).toEqual({
      amountMinor: 50_000,
      date: TODAY,
      balanceType: "CLBD",
    });
  });

  it("reports connection health and leaves archived connections out", async () => {
    const at = (days: number) => new Date(NOW.getTime() + days * DAY_MS);
    const ok = await institution("OK Bank");
    const soon = await institution("Soon Bank");
    const gone = await institution("Gone Bank");
    const lapsed = await institution("Lapsed Bank");
    const old = await institution("Old Bank");
    await connection(ok.id, { consentExpiresAt: at(90) });
    await connection(soon.id, { consentExpiresAt: at(5) });
    await connection(gone.id, { status: "expired", consentExpiresAt: at(60) });
    await connection(lapsed.id, { consentExpiresAt: at(-1) });
    await connection(old.id, { status: "archived" });

    const result = await overview();
    // Connections without accounts still show, but the page is empty.
    expect(result.empty).toBe(true);
    expect(result.connections.map((c) => [c.institution, c.health])).toEqual([
      ["Gone Bank", "expired"],
      ["Lapsed Bank", "expired"],
      ["OK Bank", "ok"],
      ["Soon Bank", "expiring"],
    ]);
  });

  it("reads what syncBalances() stored from the fake bank", async () => {
    const key = randomBytes(32);
    const fake = await institution("Fake Bank", "fake");
    const conn = await connection(fake.id, {
      provider: "fake",
      sessionRef: encryptSecret(FAKE_SESSION_REFS.valid, key),
    });
    const provider = createFakeProvider({ now: () => NOW });
    const result = await syncBalances(conn.id, {
      db: testDb.db,
      providers: createProviderRegistry([provider]),
      decrypt: (value) => decryptSecret(value, key),
      now: () => NOW,
    });
    expect(result.status).toBe("succeeded");

    const { banks, totals } = await overview();
    const synced = banks[0].accounts;
    expect(synced.map((a) => a.type)).toEqual(["checking", "savings"]);
    expect(synced.every((a) => a.lastSyncedAt !== null)).toBe(true);
    // The fake reports ITAV for its (UTC) today, which is the display type.
    const session = { sessionRef: FAKE_SESSION_REFS.valid };
    const itav = await Promise.all(
      (await provider.listAccounts(session)).map(async ({ ref }) => {
        const balances = await provider.getBalances(session, ref);
        return balances.find((b) => b.balanceType === "ITAV")!.amountMinor;
      }),
    );
    expect(synced.map((a) => a.balance?.balanceType)).toEqual(["ITAV", "ITAV"]);
    expect(totals.netWorth.amountMinor).toBe(itav[0] + itav[1]);
    // One sync: nothing 30 days ago to compare with.
    expect(totals.netWorth.changeMinor).toBeNull();
  });
});
