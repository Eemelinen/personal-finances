import { randomBytes, randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import {
  accounts,
  balanceSnapshots,
  connections,
  institutions,
  syncRuns,
} from "@/server/db/schema";
import {
  createFakeProvider,
  FAKE_RETRY_AFTER_MS,
  FAKE_SESSION_REFS,
} from "@/server/providers/fake";
import { ProviderUnavailableError } from "@/server/providers/errors";
import { createProviderRegistry } from "@/server/providers/registry";
import type { FinancialProvider } from "@/server/providers/types";
import {
  ConnectionNotFoundError,
  syncBalances,
  type SyncBalancesOptions,
} from "@/server/sync/sync-balances";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// syncBalances() against the fake provider and a real Postgres 18. The fake's
// clock and the sync's clock are pinned, so "today" is fixed per test.

const KEY = randomBytes(32);
const DAY_1 = new Date("2026-03-10T09:00:00Z");
const DAY_1_LATER = new Date("2026-03-10T15:00:00Z");
const DAY_2 = new Date("2026-03-11T09:00:00Z");

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

/**
 * The fake provider, with knobs: which of its accounts it lists, an amount
 * added to every balance, and a hook that can fail a `getBalances` call.
 */
function controllableFake() {
  const state = {
    now: DAY_1,
    hiddenRefs: new Set<string>(),
    balanceOffset: 0,
    calls: 0,
    failBalancesOf: undefined as string | undefined,
  };
  const fake = createFakeProvider({ now: () => state.now });
  const provider: FinancialProvider = {
    id: "fake",
    async listAccounts(connection) {
      state.calls++;
      const listed = await fake.listAccounts(connection);
      return listed.filter((account) => !state.hiddenRefs.has(account.ref));
    },
    async getBalances(connection, account) {
      state.calls++;
      if (state.failBalancesOf === account) {
        throw new ProviderUnavailableError("fake", "bank went away");
      }
      const balances = await fake.getBalances(connection, account);
      return balances.map((balance) => ({
        ...balance,
        amountMinor: balance.amountMinor + state.balanceOffset,
      }));
    },
    getTransactions: (connection, account, range) =>
      fake.getTransactions(connection, account, range),
  };
  const options = (): SyncBalancesOptions => ({
    db: testDb.db,
    providers: createProviderRegistry([provider]),
    decrypt: (value) => decryptSecret(value, KEY),
    now: () => state.now,
  });
  return { state, options };
}

async function createConnection(
  values: {
    sessionRef?: string | null;
    status?: (typeof connections.$inferInsert)["status"];
  } = {},
) {
  const db = testDb.db;
  const [institution] = await db
    .insert(institutions)
    .values({
      name: "Fake Bank",
      country: "FI",
      provider: "fake",
      providerRef: `fake-${randomUUID()}`,
    })
    .returning();
  const sessionRef =
    values.sessionRef === undefined
      ? FAKE_SESSION_REFS.valid
      : values.sessionRef;
  const [connection] = await db
    .insert(connections)
    .values({
      institutionId: institution.id,
      provider: "fake",
      sessionRef: sessionRef === null ? null : encryptSecret(sessionRef, KEY),
      status: values.status ?? "active",
    })
    .returning();
  return connection;
}

async function getConnection(id: string) {
  const [row] = await testDb.db
    .select()
    .from(connections)
    .where(eq(connections.id, id));
  return row;
}

async function accountsOf(connectionId: string) {
  return testDb.db
    .select()
    .from(accounts)
    .where(eq(accounts.connectionId, connectionId))
    .orderBy(asc(accounts.providerAccountRef));
}

async function snapshotsOf(accountId: string) {
  return testDb.db
    .select({
      date: balanceSnapshots.date,
      balanceType: balanceSnapshots.balanceType,
      amountMinor: balanceSnapshots.amountMinor,
      currency: balanceSnapshots.currency,
    })
    .from(balanceSnapshots)
    .where(eq(balanceSnapshots.accountId, accountId))
    .orderBy(asc(balanceSnapshots.date), asc(balanceSnapshots.balanceType));
}

async function runsOf(connectionId: string) {
  return testDb.db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.connectionId, connectionId))
    .orderBy(asc(syncRuns.startedAt));
}

describe("syncBalances", () => {
  it("adds the provider's accounts with a snapshot per day and balance type", async () => {
    const connection = await createConnection();
    const { options } = controllableFake();

    const result = await syncBalances(connection.id, options());

    expect(result).toMatchObject({
      status: "succeeded",
      connectionStatus: "active",
      error: null,
      counts: {
        accounts: 2,
        accountsAdded: 2,
        accountsArchived: 0,
        accountsRestored: 0,
        fetched: 4,
        inserted: 4,
        updated: 0,
      },
    });

    const stored = await accountsOf(connection.id);
    expect(stored).toMatchObject([
      {
        providerAccountRef: "fake-checking",
        institutionId: connection.institutionId,
        type: "checking",
        name: "Fake Checking",
        iban: "FI00 0000 0000 0000 01",
        currency: "EUR",
        archived: false,
      },
      {
        providerAccountRef: "fake-savings",
        institutionId: connection.institutionId,
        type: "savings",
        name: "Fake Savings",
        currency: "EUR",
        archived: false,
      },
    ]);
    const snapshots = await snapshotsOf(stored[0].id);
    expect(snapshots.map((s) => [s.date, s.balanceType, s.currency])).toEqual([
      ["2026-03-09", "CLBD", "EUR"],
      ["2026-03-10", "ITAV", "EUR"],
    ]);
    for (const snapshot of snapshots) {
      expect(Number.isSafeInteger(snapshot.amountMinor)).toBe(true);
    }

    const [run] = await runsOf(connection.id);
    expect(run).toMatchObject({
      id: result.runId,
      status: "succeeded",
      error: null,
      accountsCount: 2,
      fetchedCount: 4,
      insertedCount: 4,
      updatedCount: 0,
      startedAt: DAY_1,
      finishedAt: DAY_1,
    });
    expect(await getConnection(connection.id)).toMatchObject({
      status: "active",
      lastSyncedAt: DAY_1,
    });
  });

  it("upserts same-day snapshots instead of adding rows", async () => {
    const connection = await createConnection();
    const { state, options } = controllableFake();
    await syncBalances(connection.id, options());
    const [checking] = await accountsOf(connection.id);
    const before = await snapshotsOf(checking.id);

    // Same day, nothing changed: nothing is written.
    state.now = DAY_1_LATER;
    const unchanged = await syncBalances(connection.id, options());
    expect(unchanged.counts).toMatchObject({
      accountsAdded: 0,
      fetched: 4,
      inserted: 0,
      updated: 0,
    });
    expect(await snapshotsOf(checking.id)).toEqual(before);

    // Same day, new amounts: the day's rows are overwritten.
    state.balanceOffset = -1_234;
    const changed = await syncBalances(connection.id, options());
    expect(changed.counts).toMatchObject({
      fetched: 4,
      inserted: 0,
      updated: 4,
    });
    expect(await snapshotsOf(checking.id)).toEqual(
      before.map((s) => ({ ...s, amountMinor: s.amountMinor - 1_234 })),
    );
    expect(await accountsOf(connection.id)).toHaveLength(2);

    const runs = await runsOf(connection.id);
    expect(
      runs.map((r) => [r.status, r.insertedCount, r.updatedCount]),
    ).toEqual([
      ["succeeded", 4, 0],
      ["succeeded", 0, 0],
      ["succeeded", 0, 4],
    ]);
    expect((await getConnection(connection.id)).lastSyncedAt).toEqual(
      DAY_1_LATER,
    );
  });

  it("keeps earlier days and adds the next day's snapshots", async () => {
    const connection = await createConnection();
    const { state, options } = controllableFake();
    await syncBalances(connection.id, options());

    state.now = DAY_2;
    const result = await syncBalances(connection.id, options());

    // CLBD of 03-10 and ITAV of 03-11 are new; ITAV of 03-10 stays.
    expect(result.counts).toMatchObject({ inserted: 4, updated: 0 });
    const [checking] = await accountsOf(connection.id);
    expect(
      (await snapshotsOf(checking.id)).map((s) => [s.date, s.balanceType]),
    ).toEqual([
      ["2026-03-09", "CLBD"],
      ["2026-03-10", "CLBD"],
      ["2026-03-10", "ITAV"],
      ["2026-03-11", "ITAV"],
    ]);
  });

  it("archives accounts the provider no longer lists and restores them when they return", async () => {
    const connection = await createConnection();
    const { state, options } = controllableFake();
    await syncBalances(connection.id, options());
    const [checking, savings] = await accountsOf(connection.id);
    const savingsHistory = await snapshotsOf(savings.id);

    state.hiddenRefs.add("fake-savings");
    state.now = DAY_2;
    const archived = await syncBalances(connection.id, options());
    expect(archived.counts).toMatchObject({
      accounts: 1,
      accountsAdded: 0,
      accountsArchived: 1,
      fetched: 2,
    });
    expect(
      (await accountsOf(connection.id)).map((a) => [a.id, a.archived]),
    ).toEqual([
      [checking.id, false],
      [savings.id, true],
    ]);
    // The archived account keeps its history and gets no new balances.
    expect(await snapshotsOf(savings.id)).toEqual(savingsHistory);

    // Archived accounts stay archived on the next sync without counting again.
    const again = await syncBalances(connection.id, options());
    expect(again.counts.accountsArchived).toBe(0);

    state.hiddenRefs.clear();
    const restored = await syncBalances(connection.id, options());
    expect(restored.counts).toMatchObject({
      accounts: 2,
      accountsAdded: 0,
      accountsRestored: 1,
      accountsArchived: 0,
    });
    expect(
      (await accountsOf(connection.id)).map((a) => [a.id, a.archived]),
    ).toEqual([
      [checking.id, false],
      [savings.id, false],
    ]);
  });

  it("leaves accounts of other connections and manual accounts alone", async () => {
    const connection = await createConnection();
    const other = await createConnection();
    const { state, options } = controllableFake();
    await syncBalances(other.id, options());
    const [manual] = await testDb.db
      .insert(accounts)
      .values({
        institutionId: connection.institutionId,
        type: "checking",
        name: "Manual account",
        currency: "EUR",
      })
      .returning();

    state.hiddenRefs.add("fake-checking").add("fake-savings");
    const result = await syncBalances(connection.id, options());

    expect(result.counts).toMatchObject({ accounts: 0, accountsArchived: 0 });
    expect(
      (await accountsOf(other.id)).every((account) => !account.archived),
    ).toBe(true);
    const [manualAfter] = await testDb.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, manual.id));
    expect(manualAfter.archived).toBe(false);
  });

  it("marks the connection expired instead of failing on an auth error", async () => {
    const connection = await createConnection({
      sessionRef: FAKE_SESSION_REFS.expired,
    });
    const { options } = controllableFake();

    const result = await syncBalances(connection.id, options());

    expect(result).toMatchObject({
      status: "failed",
      connectionStatus: "expired",
      errorKind: "auth_expired",
      error: "fake session expired",
      counts: { accounts: 0, fetched: 0 },
    });
    expect(await getConnection(connection.id)).toMatchObject({
      status: "expired",
      lastSyncedAt: null,
    });
    expect(await accountsOf(connection.id)).toEqual([]);
    const runs = await runsOf(connection.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: result.runId,
      status: "failed",
      error: "fake session expired",
      finishedAt: DAY_1,
      accountsCount: 0,
    });
  });

  it("keeps stored data when the session expires after an earlier sync", async () => {
    const connection = await createConnection();
    const { options } = controllableFake();
    await syncBalances(connection.id, options());
    await testDb.db
      .update(connections)
      .set({ sessionRef: encryptSecret(FAKE_SESSION_REFS.expired, KEY) })
      .where(eq(connections.id, connection.id));

    const result = await syncBalances(connection.id, options());

    expect(result.connectionStatus).toBe("expired");
    const stored = await accountsOf(connection.id);
    expect(stored.map((a) => a.archived)).toEqual([false, false]);
    expect(await snapshotsOf(stored[0].id)).toHaveLength(2);
    expect((await getConnection(connection.id)).lastSyncedAt).toEqual(DAY_1);
  });

  it("treats a connection without a session as expired", async () => {
    const connection = await createConnection({ sessionRef: null });
    const { state, options } = controllableFake();

    const result = await syncBalances(connection.id, options());

    expect(result).toMatchObject({
      status: "failed",
      connectionStatus: "expired",
      errorKind: "auth_expired",
    });
    expect(state.calls).toBe(0);
    expect((await getConnection(connection.id)).status).toBe("expired");
  });

  it("records rate limits and outages and keeps the connection active", async () => {
    const limited = await createConnection({
      sessionRef: FAKE_SESSION_REFS.rateLimited,
    });
    const down = await createConnection({
      sessionRef: FAKE_SESSION_REFS.unavailable,
    });
    const { options } = controllableFake();

    const limitedResult = await syncBalances(limited.id, options());
    const downResult = await syncBalances(down.id, options());

    expect(limitedResult).toMatchObject({
      status: "failed",
      connectionStatus: "active",
      errorKind: "rate_limited",
      retryAfterMs: FAKE_RETRY_AFTER_MS,
    });
    expect(downResult).toMatchObject({
      status: "failed",
      connectionStatus: "active",
      errorKind: "unavailable",
      retryAfterMs: null,
    });
    for (const connection of [limited, down]) {
      expect(await getConnection(connection.id)).toMatchObject({
        status: "active",
        lastSyncedAt: null,
      });
      const [run] = await runsOf(connection.id);
      expect(run.status).toBe("failed");
      expect(run.error).toBeTruthy();
    }
  });

  it("writes nothing when the provider fails halfway", async () => {
    const connection = await createConnection();
    const { state, options } = controllableFake();
    state.failBalancesOf = "fake-savings";

    const result = await syncBalances(connection.id, options());

    expect(result).toMatchObject({
      status: "failed",
      errorKind: "unavailable",
    });
    expect(await accountsOf(connection.id)).toEqual([]);
  });

  it("keeps the previous sync's data when the provider fails halfway", async () => {
    const connection = await createConnection();
    const { state, options } = controllableFake();
    await syncBalances(connection.id, options());
    const [checking] = await accountsOf(connection.id);
    const before = await snapshotsOf(checking.id);

    // Next day, with the savings account gone and new amounts: the checking
    // account would get new snapshots and savings would be archived, but
    // fetching the checking balances fails after the account list arrived.
    state.now = DAY_2;
    state.balanceOffset = 500;
    state.hiddenRefs.add("fake-savings");
    state.failBalancesOf = "fake-checking";
    const result = await syncBalances(connection.id, options());

    expect(result).toMatchObject({
      status: "failed",
      errorKind: "unavailable",
    });
    expect((await accountsOf(connection.id)).map((a) => a.archived)).toEqual([
      false,
      false,
    ]);
    expect(await snapshotsOf(checking.id)).toEqual(before);
    expect(await getConnection(connection.id)).toMatchObject({
      status: "active",
      lastSyncedAt: DAY_1,
    });
    const runs = await runsOf(connection.id);
    expect(runs.map((r) => [r.status, r.insertedCount])).toEqual([
      ["succeeded", 4],
      ["failed", 0],
    ]);
    expect(runs[1].error).toBe("bank went away");
  });

  it("does not call the provider for a connection that is not active", async () => {
    const connection = await createConnection({ status: "revoked" });
    const { state, options } = controllableFake();

    const result = await syncBalances(connection.id, options());

    expect(result).toMatchObject({
      status: "failed",
      connectionStatus: "revoked",
      errorKind: "not_active",
    });
    expect(state.calls).toBe(0);
    const [run] = await runsOf(connection.id);
    expect(run).toMatchObject({ status: "failed", finishedAt: DAY_1 });
    expect((await getConnection(connection.id)).status).toBe("revoked");
  });

  it("records an unexpected error on the run and rethrows it", async () => {
    const connection = await createConnection();
    const { options } = controllableFake();
    const wrongKey = randomBytes(32);

    await expect(
      syncBalances(connection.id, {
        ...options(),
        decrypt: (value) => decryptSecret(value, wrongKey),
      }),
    ).rejects.toThrow(/tampered with or the key is wrong/);

    const [run] = await runsOf(connection.id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/key is wrong/);
    expect(run.finishedAt).toEqual(DAY_1);
    expect((await getConnection(connection.id)).status).toBe("active");
  });

  it("rejects an unknown connection without writing a run", async () => {
    const { options } = controllableFake();
    const id = randomUUID();

    await expect(syncBalances(id, options())).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
    expect(await runsOf(id)).toEqual([]);
  });
});
