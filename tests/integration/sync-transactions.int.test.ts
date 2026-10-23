import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import {
  accounts,
  categories,
  connections,
  institutions,
  syncRuns,
  transactions,
} from "@/server/db/schema";
import {
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "@/server/providers/errors";
import { createFakeProvider, FAKE_SESSION_REFS } from "@/server/providers/fake";
import { fetchAllTransactions } from "@/server/providers/paging";
import { createProviderRegistry } from "@/server/providers/registry";
import type {
  FinancialProvider,
  ProviderTransaction,
  TransactionRange,
} from "@/server/providers/types";
import { syncBalances } from "@/server/sync/sync-balances";
import {
  ConnectionNotFoundError,
  syncTransactions,
  type CategorizeHook,
  type SyncTransactionsOptions,
} from "@/server/sync/sync-transactions";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// syncTransactions() against the fake provider (paging 50 per page) and a
// real Postgres 18. The fake's clock and the sync's clock are pinned, so
// "today" (the fake's pending day) is fixed per test.

const KEY = randomBytes(32);
const TIME_ZONE = "Europe/Helsinki";
const PAGE_SIZE = 50;
const DAY_1 = new Date("2026-03-10T09:00:00Z");
const DAY_1_LATER = new Date("2026-03-10T15:00:00Z");
const DAY_2 = new Date("2026-03-11T09:00:00Z");
const DAY_20 = new Date("2026-03-20T09:00:00Z");

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

interface Call {
  account: string;
  range: TransactionRange;
  continuationKey: string | undefined;
}

/**
 * The paging fake, with knobs: the ranges it was asked for, a rewrite of
 * every listing, and a failure for one account's transactions.
 */
function controllableFake() {
  const state = {
    now: DAY_1,
    calls: [] as Call[],
    rewrite: undefined as
      | ((
          account: string,
          txns: ProviderTransaction[],
        ) => ProviderTransaction[])
      | undefined,
    failTransactionsOf: undefined as string | undefined,
    failWith: (): Error => new ProviderRateLimitError("fake", "slow down"),
    categorized: [] as string[][],
  };
  const fake = createFakeProvider({
    now: () => state.now,
    transactionPageSize: PAGE_SIZE,
  });
  const provider: FinancialProvider = {
    id: "fake",
    listAccounts: (connection) => fake.listAccounts(connection),
    getBalances: (connection, account) => fake.getBalances(connection, account),
    async getTransactions(connection, account, range, continuationKey) {
      state.calls.push({ account, range, continuationKey });
      if (state.failTransactionsOf === account) throw state.failWith();
      if (!state.rewrite) {
        return fake.getTransactions(
          connection,
          account,
          range,
          continuationKey,
        );
      }
      // One page: the rewritten whole listing.
      const all = await fetchAllTransactions(fake, connection, account, range);
      return {
        transactions: state.rewrite(account, all),
        continuationKey: null,
      };
    },
  };
  const categorize: CategorizeHook = async (tx, ids) => {
    // Runs inside the sync's transaction: the rows are visible.
    const rows = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(inArray(transactions.id, ids));
    expect(rows).toHaveLength(ids.length);
    state.categorized.push(ids);
  };
  const options = (): SyncTransactionsOptions => ({
    db: testDb.db,
    providers: createProviderRegistry([provider]),
    decrypt: (value) => decryptSecret(value, KEY),
    now: () => state.now,
    timeZone: TIME_ZONE,
    categorize,
  });
  const expected = (account: string, range: TransactionRange = {}) =>
    fetchAllTransactions(
      fake,
      { sessionRef: FAKE_SESSION_REFS.valid },
      account,
      range,
    );
  return { state, options, expected };
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

/** A connection whose accounts `syncBalances()` has already created. */
async function connectionWithAccounts(
  fake: ReturnType<typeof controllableFake>,
) {
  const connection = await createConnection();
  const balances = await syncBalances(connection.id, fake.options());
  expect(balances.status).toBe("succeeded");
  return connection;
}

async function accountOf(connectionId: string, ref: string) {
  const [row] = await testDb.db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.connectionId, connectionId),
        eq(accounts.providerAccountRef, ref),
      ),
    );
  return row;
}

async function transactionsOf(accountId: string) {
  return testDb.db
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .orderBy(asc(transactions.bookingDate), asc(transactions.providerTxnRef));
}

async function runsOf(connectionId: string) {
  return testDb.db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.connectionId, connectionId))
    .orderBy(asc(syncRuns.startedAt), asc(syncRuns.createdAt));
}

async function getConnection(id: string) {
  const [row] = await testDb.db
    .select()
    .from(connections)
    .where(eq(connections.id, id));
  return row;
}

/** The provider's view of a stored row, for comparing with a listing. */
function asListed(row: typeof transactions.$inferSelect) {
  return {
    ref: row.providerTxnRef,
    bookingDate: row.bookingDate,
    valueDate: row.valueDate,
    amountMinor: row.amountMinor,
    currency: row.currency,
    counterparty: row.counterparty,
    description: row.description,
    status: row.status,
  };
}

describe("syncTransactions: backfill", () => {
  it("backfills every account from the oldest available day, following every page", async () => {
    const fake = controllableFake();
    const connection = await connectionWithAccounts(fake);
    const checking = await accountOf(connection.id, "fake-checking");
    const savings = await accountOf(connection.id, "fake-savings");
    const expectedChecking = await fake.expected("fake-checking");
    const expectedSavings = await fake.expected("fake-savings");

    const result = await syncTransactions(connection.id, fake.options());

    const total = expectedChecking.length + expectedSavings.length;
    expect(expectedChecking.length).toBeGreaterThan(5 * PAGE_SIZE);
    expect(result).toMatchObject({
      status: "succeeded",
      connectionStatus: "active",
      error: null,
      errorKind: null,
      counts: {
        accounts: 2,
        fetched: total,
        inserted: total,
        updated: 0,
        removed: 0,
      },
    });

    // Backfill: no `from`, then the pages in order.
    const checkingCalls = fake.state.calls.filter(
      (c) => c.account === "fake-checking",
    );
    expect(checkingCalls[0]).toEqual({
      account: "fake-checking",
      range: {},
      continuationKey: undefined,
    });
    expect(checkingCalls).toHaveLength(
      Math.ceil(expectedChecking.length / PAGE_SIZE),
    );
    expect(checkingCalls.map((c) => c.continuationKey).slice(1)).toEqual(
      checkingCalls.slice(1).map((_, i) => String((i + 1) * PAGE_SIZE)),
    );

    const storedChecking = await transactionsOf(checking.id);
    expect(storedChecking.map(asListed)).toEqual(
      [...expectedChecking].sort(
        (a, b) =>
          a.bookingDate.localeCompare(b.bookingDate) ||
          a.ref!.localeCompare(b.ref!),
      ),
    );
    expect(storedChecking[0].bookingDate).toBe("2025-01-01");
    expect(storedChecking.every((row) => row.categorySource === "none")).toBe(
      true,
    );
    const pending = storedChecking.filter((row) => row.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((row) => row.bookingDate === "2026-03-10")).toBe(true);
    expect(await transactionsOf(savings.id)).toHaveLength(
      expectedSavings.length,
    );

    const [, run] = await runsOf(connection.id);
    expect(run).toMatchObject({
      status: "succeeded",
      error: null,
      accountsCount: 2,
      fetchedCount: total,
      insertedCount: total,
      updatedCount: 0,
      startedAt: DAY_1,
      finishedAt: DAY_1,
    });
    expect(
      (await accountOf(connection.id, "fake-checking")).transactionsSyncedAt,
    ).toEqual(DAY_1);
    expect((await getConnection(connection.id)).lastSyncedAt).toEqual(DAY_1);
  });

  it("calls the categorisation hook with the inserted ids, inside the write", async () => {
    const fake = controllableFake();
    const connection = await connectionWithAccounts(fake);

    const result = await syncTransactions(connection.id, fake.options());

    const ids = fake.state.categorized.flat();
    expect(fake.state.categorized).toHaveLength(2);
    expect(ids).toHaveLength(result.counts.inserted);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("syncTransactions: idempotent re-run", () => {
  it("changes nothing when run twice", async () => {
    const fake = controllableFake();
    const connection = await connectionWithAccounts(fake);
    const checking = await accountOf(connection.id, "fake-checking");
    await syncTransactions(connection.id, fake.options());
    const before = await transactionsOf(checking.id);
    fake.state.categorized = [];

    fake.state.now = DAY_1_LATER;
    const second = await syncTransactions(connection.id, fake.options());

    expect(second.status).toBe("succeeded");
    expect(second.counts).toMatchObject({
      inserted: 0,
      updated: 0,
      removed: 0,
    });
    expect(second.counts.fetched).toBeGreaterThan(0);
    // Rows, ids and `updated_at` exactly as before.
    expect(await transactionsOf(checking.id)).toEqual(before);
    expect(fake.state.categorized).toEqual([]);
    const runs = await runsOf(connection.id);
    expect(runs.at(-1)).toMatchObject({ insertedCount: 0, updatedCount: 0 });
  });

  it("asks from 7 days before the last sync and books yesterday's pending ones in place", async () => {
    const fake = controllableFake();
    const connection = await connectionWithAccounts(fake);
    const checking = await accountOf(connection.id, "fake-checking");
    await syncTransactions(connection.id, fake.options());
    const dayOnePending = (await transactionsOf(checking.id)).filter(
      (row) => row.status === "pending",
    );
    fake.state.calls = [];

    fake.state.now = DAY_2;
    const result = await syncTransactions(connection.id, fake.options());

    expect(fake.state.calls[0].range).toEqual({ from: "2026-03-03" });
    const newToday = await fake.expected("fake-checking", {
      from: "2026-03-11",
      to: "2026-03-11",
    });
    expect(result.counts).toMatchObject({
      inserted: newToday.length,
      updated: dayOnePending.length,
      removed: 0,
    });
    const after = await transactionsOf(checking.id);
    for (const row of dayOnePending) {
      expect(after.find((stored) => stored.id === row.id)).toMatchObject({
        status: "booked",
        providerTxnRef: row.providerTxnRef,
      });
    }
    expect(
      after
        .filter((row) => row.status === "pending")
        .map((row) => row.bookingDate),
    ).toEqual(newToday.map(() => "2026-03-11"));

    // And again the same day: nothing.
    const again = await syncTransactions(connection.id, fake.options());
    expect(again.counts).toMatchObject({ inserted: 0, updated: 0, removed: 0 });
  });
});

describe("syncTransactions: manual edits preserved", () => {
  it("never overwrites a manual category, a note or a transfer link", async () => {
    const fake = controllableFake();
    const connection = await connectionWithAccounts(fake);
    const checking = await accountOf(connection.id, "fake-checking");
    await syncTransactions(connection.id, fake.options());
    const [category] = await testDb.db
      .insert(categories)
      .values({ name: `Coffee ${randomUUID()}`, kind: "expense" })
      .returning();
    const rows = await transactionsOf(checking.id);
    const pending = rows.find((row) => row.status === "pending")!;
    const booked = rows.find(
      (row) => row.status === "booked" && row.bookingDate >= "2026-03-05",
    )!;
    const transferGroupId = randomUUID();
    const edits = {
      categoryId: category.id,
      categorySource: "manual" as const,
      note: "Shared with a friend",
      transferGroupId,
    };
    await testDb.db
      .update(transactions)
      .set(edits)
      .where(inArray(transactions.id, [pending.id, booked.id]));
    // The bank rewrites the texts of everything it lists again.
    fake.state.rewrite = (_, txns) =>
      txns.map((txn) => ({ ...txn, description: `${txn.description} (rev)` }));

    fake.state.now = DAY_2;
    const result = await syncTransactions(connection.id, fake.options());

    expect(result.status).toBe("succeeded");
    const after = await transactionsOf(checking.id);
    expect(after.find((row) => row.id === pending.id)).toMatchObject({
      ...edits,
      status: "booked",
      description: `${pending.description} (rev)`,
    });
    expect(after.find((row) => row.id === booked.id)).toMatchObject({
      ...edits,
      description: `${booked.description} (rev)`,
    });
  });
});

describe("syncTransactions: pending transactions", () => {
  it("replaces a pending transaction by its booked version with a new id, day and text, and removes stale ones", async () => {
    const fake = controllableFake();
    const connection = await connectionWithAccounts(fake);
    const checking = await accountOf(connection.id, "fake-checking");
    const card = (
      overrides: Partial<ProviderTransaction>,
    ): ProviderTransaction => ({
      ref: null,
      bookingDate: "2026-03-10",
      valueDate: null,
      amountMinor: -4_321,
      currency: "EUR",
      counterparty: "Example Bookshop",
      description: "Reserved",
      status: "pending",
      ...overrides,
    });
    // Day 1: two pending card payments without ids.
    fake.state.rewrite = (account, txns) =>
      account === "fake-checking"
        ? [
            ...txns,
            card({}),
            card({ amountMinor: -999, counterparty: "Example Cafe" }),
          ]
        : txns;
    await syncTransactions(connection.id, fake.options());
    const before = await transactionsOf(checking.id);
    const reserved = before.find((row) => row.amountMinor === -4_321)!;
    const cancelled = before.find((row) => row.amountMinor === -999)!;
    await testDb.db
      .update(transactions)
      .set({ note: "Birthday present" })
      .where(eq(transactions.id, reserved.id));

    // Day 2: the first is booked a day later with an id and other text; the
    // second was cancelled and is gone.
    fake.state.rewrite = (account, txns) =>
      account === "fake-checking"
        ? [
            ...txns,
            card({
              ref: "booked-4321",
              bookingDate: "2026-03-11",
              valueDate: "2026-03-10",
              description: "EXAMPLE BOOKSHOP 1234",
              status: "booked",
            }),
          ]
        : txns;
    fake.state.now = DAY_2;
    const result = await syncTransactions(connection.id, fake.options());

    expect(result.counts.removed).toBe(1);
    const after = await transactionsOf(checking.id);
    expect(after.filter((row) => row.amountMinor === -4_321)).toEqual([
      expect.objectContaining({
        id: reserved.id,
        providerTxnRef: "booked-4321",
        bookingDate: "2026-03-11",
        valueDate: "2026-03-10",
        description: "EXAMPLE BOOKSHOP 1234",
        status: "booked",
        note: "Birthday present",
      }),
    ]);
    expect(after.find((row) => row.id === cancelled.id)).toBeUndefined();
  });

  it("reaches back past the overlap to a pending transaction still open, and removes it once gone", async () => {
    const fake = controllableFake();
    const connection = await connectionWithAccounts(fake);
    const savings = await accountOf(connection.id, "fake-savings");
    const deposit: ProviderTransaction = {
      ref: "deposit",
      bookingDate: "2026-03-10",
      valueDate: null,
      amountMinor: -20_000,
      currency: "EUR",
      counterparty: "Example Hotel",
      description: "Deposit",
      status: "pending",
    };
    fake.state.rewrite = (account, txns) =>
      account === "fake-savings" ? [...txns, deposit] : txns;
    await syncTransactions(connection.id, fake.options());
    fake.state.now = DAY_20;
    await syncTransactions(connection.id, fake.options());
    fake.state.calls = [];

    // 7 days before 20 March is 13 March, but the deposit is from the 10th.
    fake.state.rewrite = undefined;
    fake.state.now = new Date("2026-03-21T09:00:00Z");
    const result = await syncTransactions(connection.id, fake.options());

    expect(
      fake.state.calls.find((call) => call.account === "fake-savings")!.range,
    ).toEqual({ from: "2026-03-10" });
    expect(
      fake.state.calls.find((call) => call.account === "fake-checking")!.range,
    ).toEqual({ from: "2026-03-13" });
    expect(result.counts.removed).toBeGreaterThanOrEqual(1);
    expect(
      (await transactionsOf(savings.id)).find(
        (row) => row.providerTxnRef === "deposit",
      ),
    ).toBeUndefined();
  });

  it("stores two identical transactions without ids once each, also on a re-sync", async () => {
    const fake = controllableFake();
    const connection = await connectionWithAccounts(fake);
    const savings = await accountOf(connection.id, "fake-savings");
    const coffee: ProviderTransaction = {
      ref: null,
      bookingDate: "2026-03-05",
      valueDate: null,
      amountMinor: -350,
      currency: "EUR",
      counterparty: "Example Cafe",
      description: "Coffee",
      status: "booked",
    };
    fake.state.rewrite = (account, txns) =>
      account === "fake-savings" ? [...txns, coffee, { ...coffee }] : txns;

    await syncTransactions(connection.id, fake.options());
    fake.state.now = DAY_1_LATER;
    const again = await syncTransactions(connection.id, fake.options());

    expect(again.counts).toMatchObject({ inserted: 0, updated: 0, removed: 0 });
    const coffees = (await transactionsOf(savings.id)).filter(
      (row) => row.description === "Coffee",
    );
    expect(coffees).toHaveLength(2);
    expect(new Set(coffees.map((row) => row.dedupeHash)).size).toBe(2);
  });
});

describe("syncTransactions: failures", () => {
  it("stops cleanly at a rate limit, keeps the accounts done and continues next time", async () => {
    const fake = controllableFake();
    const connection = await connectionWithAccounts(fake);
    const checking = await accountOf(connection.id, "fake-checking");
    const savings = await accountOf(connection.id, "fake-savings");
    fake.state.failTransactionsOf = "fake-savings";
    fake.state.failWith = () =>
      new ProviderRateLimitError("fake", "slow down", { retryAfterMs: 30_000 });

    const result = await syncTransactions(connection.id, fake.options());

    const checkingCount = (await fake.expected("fake-checking")).length;
    expect(result).toMatchObject({
      status: "failed",
      connectionStatus: "active",
      error: "slow down",
      errorKind: "rate_limited",
      retryAfterMs: 30_000,
      counts: { accounts: 1, fetched: checkingCount, inserted: checkingCount },
    });
    expect(await transactionsOf(checking.id)).toHaveLength(checkingCount);
    expect(await transactionsOf(savings.id)).toEqual([]);
    expect((await runsOf(connection.id)).at(-1)).toMatchObject({
      status: "failed",
      error: "slow down",
      accountsCount: 1,
      insertedCount: checkingCount,
      finishedAt: DAY_1,
    });
    expect(await getConnection(connection.id)).toMatchObject({
      status: "active",
      lastSyncedAt: DAY_1, // from syncBalances, not this run
    });
    expect(
      (await accountOf(connection.id, "fake-savings")).transactionsSyncedAt,
    ).toBeNull();

    // Next time: checking is incremental, savings is backfilled.
    fake.state.failTransactionsOf = undefined;
    fake.state.calls = [];
    fake.state.now = DAY_2;
    const next = await syncTransactions(connection.id, fake.options());
    expect(next.status).toBe("succeeded");
    expect(
      fake.state.calls.find((c) => c.account === "fake-checking")!.range,
    ).toEqual({
      from: "2026-03-03",
    });
    expect(
      fake.state.calls.find((c) => c.account === "fake-savings")!.range,
    ).toEqual({});
    expect(await transactionsOf(savings.id)).toHaveLength(
      (await fake.expected("fake-savings")).length,
    );
  });

  it("writes nothing of an account whose listing fails on a later page", async () => {
    const fake = controllableFake();
    const connection = await connectionWithAccounts(fake);
    const checking = await accountOf(connection.id, "fake-checking");
    const options = fake.options();
    const registry = options.providers!;
    const inner = registry.get("fake");
    let pages = 0;
    const flaky: FinancialProvider = {
      ...inner,
      async getTransactions(...args) {
        if (++pages === 3)
          throw new ProviderUnavailableError("fake", "bank went away");
        return inner.getTransactions(...args);
      },
    };

    const result = await syncTransactions(connection.id, {
      ...options,
      providers: createProviderRegistry([flaky]),
    });

    expect(result).toMatchObject({
      status: "failed",
      errorKind: "unavailable",
    });
    expect(await transactionsOf(checking.id)).toEqual([]);
    expect(
      (await accountOf(connection.id, "fake-checking")).transactionsSyncedAt,
    ).toBeNull();
  });

  it("marks the connection expired on an auth error", async () => {
    const fake = controllableFake();
    const connection = await connectionWithAccounts(fake);
    await testDb.db
      .update(connections)
      .set({ sessionRef: encryptSecret(FAKE_SESSION_REFS.expired, KEY) })
      .where(eq(connections.id, connection.id));

    const result = await syncTransactions(connection.id, fake.options());

    expect(result).toMatchObject({
      status: "failed",
      connectionStatus: "expired",
      errorKind: "auth_expired",
      counts: { accounts: 0, fetched: 0, inserted: 0, updated: 0, removed: 0 },
    });
    expect((await getConnection(connection.id)).status).toBe("expired");
    expect((await runsOf(connection.id)).at(-1)).toMatchObject({
      status: "failed",
    });
  });

  it("does not call the provider for a connection that is not active", async () => {
    const fake = controllableFake();
    const connection = await createConnection({ status: "revoked" });

    const result = await syncTransactions(connection.id, fake.options());

    expect(result).toMatchObject({
      status: "failed",
      connectionStatus: "revoked",
      errorKind: "not_active",
    });
    expect(fake.state.calls).toEqual([]);
    expect(await runsOf(connection.id)).toMatchObject([{ status: "failed" }]);
  });

  it("records and rethrows an unexpected error", async () => {
    const fake = controllableFake();
    const connection = await connectionWithAccounts(fake);
    fake.state.failTransactionsOf = "fake-checking";
    fake.state.failWith = () => new TypeError("bug in the mapping");

    await expect(
      syncTransactions(connection.id, fake.options()),
    ).rejects.toThrow("bug in the mapping");
    expect((await runsOf(connection.id)).at(-1)).toMatchObject({
      status: "failed",
      error: "bug in the mapping",
    });
  });

  it("rejects an unknown connection", async () => {
    const fake = controllableFake();

    await expect(
      syncTransactions(randomUUID(), fake.options()),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });
});

describe("syncTransactions: accounts", () => {
  it("skips archived accounts and leaves other connections alone", async () => {
    const fake = controllableFake();
    const connection = await connectionWithAccounts(fake);
    const other = await connectionWithAccounts(fake);
    const savings = await accountOf(connection.id, "fake-savings");
    await testDb.db
      .update(accounts)
      .set({ archived: true })
      .where(eq(accounts.id, savings.id));

    const result = await syncTransactions(connection.id, fake.options());

    expect(result.counts.accounts).toBe(1);
    expect(await transactionsOf(savings.id)).toEqual([]);
    const otherChecking = await accountOf(other.id, "fake-checking");
    expect(await transactionsOf(otherChecking.id)).toEqual([]);
  });
});
