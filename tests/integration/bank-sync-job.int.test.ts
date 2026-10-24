import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  removeConnection,
  archiveConnection,
} from "@/server/connections/manage";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import {
  accounts,
  balanceSnapshots,
  connections,
  institutions,
  syncRuns,
  transactions,
} from "@/server/db/schema";
import { createFakeProvider, FAKE_SESSION_REFS } from "@/server/providers/fake";
import { createProviderRegistry } from "@/server/providers/registry";
import type {
  BankConnectorProvider,
  ProviderConnection,
} from "@/server/providers/types";
import { getLastSuccessfulSync, getSyncLog } from "@/server/queries/sync-log";
import {
  syncBankConnection,
  syncBankConnections,
  type BankSyncOptions,
} from "@/server/sync/bank-sync";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// The bank sync behind the worker's `bank-sync` job, Sync now and the first
// sync after connecting (F-010), against the fake provider and a real
// Postgres 18: the per-connection advisory lock keeps a second sync of one
// connection out (and makes archive / remove wait for a running one), and
// one connection's failure, a bug included, never stops the others.

const KEY = randomBytes(32);
const NOW = new Date("2026-03-10T09:00:00Z");

/** Session refs the wrapper below understands on top of the fake's own. */
const SESSIONS = {
  ...FAKE_SESSION_REFS,
  /** Waits for `gate.open()` before listing the accounts. */
  gated: "test:gated",
  /** Throws a plain `Error`: a bug, not a provider failure. */
  bug: "test:bug",
  /** Unavailable until `state.recovered` is set. */
  flaky: "test:flaky",
} as const;

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

// A failed test must not leave a sync waiting at its gate (and its
// transaction open, which would hang the database shutdown).
const gates: (() => void)[] = [];
afterEach(() => {
  for (const open of gates.splice(0)) open();
});

/** Fails instead of hanging when `promise` waits on something that never comes. */
function within<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms),
    ),
  ]);
}

function createGate() {
  let open!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  gates.push(open);
  const reached = new Promise<void>((resolve) => (entered = resolve));
  return { open, entered, opened, reached };
}

/** The fake provider behind special session refs, counting its calls. */
function testProvider() {
  const state = {
    gate: createGate(),
    recovered: false,
    listCalls: [] as string[],
    revoked: [] as string[],
  };
  const fake = createFakeProvider({ now: () => NOW });
  const valid: ProviderConnection = { sessionRef: FAKE_SESSION_REFS.valid };
  const resolve = async (
    connection: ProviderConnection,
  ): Promise<ProviderConnection> => {
    switch (connection.sessionRef) {
      case SESSIONS.gated:
        state.gate.entered();
        await state.gate.opened;
        return valid;
      case SESSIONS.bug:
        throw new Error("a bug in the sync");
      case SESSIONS.flaky:
        return state.recovered
          ? valid
          : { sessionRef: FAKE_SESSION_REFS.unavailable };
      default:
        return connection;
    }
  };
  const provider: BankConnectorProvider = {
    ...fake,
    async listAccounts(connection) {
      state.listCalls.push(connection.sessionRef);
      return fake.listAccounts(await resolve(connection));
    },
    async getBalances(connection, account) {
      const session =
        connection.sessionRef === SESSIONS.gated ? valid : connection;
      return fake.getBalances(await resolve(session), account);
    },
    async getTransactions(connection, account, range, continuationKey) {
      const session =
        connection.sessionRef === SESSIONS.gated ? valid : connection;
      return fake.getTransactions(
        await resolve(session),
        account,
        range,
        continuationKey,
      );
    },
    async revokeSession(connection) {
      state.revoked.push(connection.sessionRef);
    },
  };
  const options: BankSyncOptions = {
    db: testDb.db,
    providers: createProviderRegistry([provider]),
    decrypt: (value) => decryptSecret(value, KEY),
    now: () => NOW,
    timeZone: "Europe/Helsinki",
  };
  return { state, options };
}

async function createConnection(
  sessionRef: string,
  values: Partial<typeof connections.$inferInsert> = {},
) {
  const [institution] = await testDb.db
    .insert(institutions)
    .values({
      name: `Bank ${sessionRef}`,
      country: "FI",
      provider: values.provider ?? "fake",
      providerRef: `test-${randomUUID()}`,
    })
    .returning();
  const [connection] = await testDb.db
    .insert(connections)
    .values({
      institutionId: institution.id,
      provider: "fake",
      sessionRef: encryptSecret(sessionRef, KEY),
      status: "active",
      ...values,
    })
    .returning();
  return connection;
}

async function runsOf(connectionId: string) {
  return testDb.db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.connectionId, connectionId))
    .orderBy(asc(syncRuns.createdAt));
}

async function accountIdsOf(connectionId: string) {
  const rows = await testDb.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.connectionId, connectionId));
  return rows.map((row) => row.id);
}

async function transactionCount(connectionId: string) {
  const ids = await accountIdsOf(connectionId);
  if (ids.length === 0) return 0;
  return testDb.db.$count(transactions, inArray(transactions.accountId, ids));
}

describe("syncBankConnection", () => {
  it("syncs the balances, then the transactions, as two logged runs", async () => {
    const { options } = testProvider();
    const connection = await createConnection(SESSIONS.valid);

    const result = await syncBankConnection(connection.id, options);

    expect(result.status).toBe("succeeded");
    expect(result.balances?.counts.accounts).toBe(2);
    expect(result.transactions?.counts.inserted).toBeGreaterThan(0);
    const runs = await runsOf(connection.id);
    expect(runs.map((run) => [run.kind, run.status])).toEqual([
      ["balances", "succeeded"],
      ["transactions", "succeeded"],
    ]);
    const ids = await accountIdsOf(connection.id);
    expect(
      await testDb.db.$count(
        balanceSnapshots,
        inArray(balanceSnapshots.accountId, ids),
      ),
    ).toBeGreaterThan(0);
    expect(await transactionCount(connection.id)).toBe(
      result.transactions?.counts.inserted,
    );
  });

  it("skips a second sync of a connection while one runs, not other connections", async () => {
    const { state, options } = testProvider();
    const slow = await createConnection(SESSIONS.gated);
    const other = await createConnection(SESSIONS.valid);

    const first = syncBankConnection(slow.id, options);
    await state.gate.reached;

    // The advisory lock is taken: the second sync of `slow` neither calls
    // the provider nor logs a run, while `other` syncs meanwhile.
    const second = await within(syncBankConnection(slow.id, options));
    expect(second).toMatchObject({
      status: "skipped",
      error: "A sync of this connection is running",
      balances: null,
    });
    expect(
      state.listCalls.filter((ref) => ref === SESSIONS.gated),
    ).toHaveLength(1);
    expect((await runsOf(slow.id)).map((run) => run.status)).toEqual([
      "running",
    ]);
    expect((await syncBankConnection(other.id, options)).status).toBe(
      "succeeded",
    );

    state.gate.open();
    expect((await first).status).toBe("succeeded");

    // Released with the sync: the next one runs.
    const third = await syncBankConnection(slow.id, options);
    expect(third.status).toBe("succeeded");
    expect(third.transactions?.counts.inserted).toBe(0);
    expect(await runsOf(slow.id)).toHaveLength(4);
  });

  it("makes archive wait for a running sync, so the sync cannot restore the accounts", async () => {
    const { state, options } = testProvider();
    const connection = await createConnection(SESSIONS.gated);
    const sync = syncBankConnection(connection.id, options);
    await state.gate.reached;

    let archived = false;
    const archive = archiveConnection(connection.id, options).then(() => {
      archived = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(archived).toBe(false);
    const [during] = await testDb.db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.id, connection.id));
    expect(during.status).toBe("active");

    state.gate.open();
    expect((await sync).status).toBe("succeeded");
    await archive;
    const [after] = await testDb.db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.id, connection.id));
    expect(after.status).toBe("archived");
    const restored = await testDb.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.connectionId, connection.id),
          eq(accounts.archived, false),
        ),
      );
    expect(restored).toEqual([]);
    expect(state.revoked).toEqual([SESSIONS.gated]);
  });

  it("skips a connection removed before its sync started", async () => {
    const { options } = testProvider();
    const connection = await createConnection(SESSIONS.valid);
    await removeConnection(connection.id, options);

    const result = await syncBankConnection(connection.id, options);
    expect(result).toMatchObject({
      status: "skipped",
      error: "The connection was removed",
    });
  });
});

describe("syncBankConnections", () => {
  it("syncs every active bank connection; a failing one does not stop the others and is retried next time", async () => {
    // Its own database state: only these connections exist.
    await testDb.db.delete(connections);
    const { state, options } = testProvider();
    const flaky = await createConnection(SESSIONS.flaky);
    const buggy = await createConnection(SESSIONS.bug);
    const healthy = await createConnection(SESSIONS.valid);
    const expired = await createConnection(SESSIONS.valid, {
      status: "expired",
    });
    const archived = await createConnection(SESSIONS.valid, {
      status: "archived",
      sessionRef: null,
    });
    const kraken = await createConnection("kraken-credentials", {
      provider: "kraken",
    });

    const results = await syncBankConnections(options);

    expect(
      results.map(({ connectionId, institution, status, errorKind }) => ({
        connectionId,
        institution,
        status,
        errorKind,
      })),
    ).toEqual([
      {
        connectionId: flaky.id,
        institution: `Bank ${SESSIONS.flaky}`,
        status: "failed",
        errorKind: "unavailable",
      },
      {
        connectionId: buggy.id,
        institution: `Bank ${SESSIONS.bug}`,
        status: "failed",
        errorKind: "internal",
      },
      {
        connectionId: healthy.id,
        institution: `Bank ${SESSIONS.valid}`,
        status: "succeeded",
        errorKind: null,
      },
    ]);
    expect(results[1].error).toBe("a bug in the sync");
    expect(results[1].cause).toBeInstanceOf(Error);
    expect(await transactionCount(healthy.id)).toBeGreaterThan(0);

    // Every failure is in the sync log; nothing ran for the others.
    expect(
      (await runsOf(flaky.id)).map((run) => [run.kind, run.status, run.error]),
    ).toEqual([["balances", "failed", "fake bank unavailable"]]);
    expect(
      (await runsOf(buggy.id)).map((run) => [run.kind, run.status, run.error]),
    ).toEqual([["balances", "failed", "a bug in the sync"]]);
    for (const skipped of [expired, archived, kraken]) {
      expect(await runsOf(skipped.id)).toEqual([]);
    }

    // The next run retries the failed connection.
    state.recovered = true;
    const retried = await syncBankConnections(options);
    expect(
      retried.find((result) => result.connectionId === flaky.id)?.status,
    ).toBe("succeeded");
    expect(await transactionCount(flaky.id)).toBeGreaterThan(0);
  });

  it("syncs only the connections asked for (Sync now on one card)", async () => {
    const { options } = testProvider();
    const asked = await createConnection(SESSIONS.valid);
    const notAsked = await createConnection(SESSIONS.valid);
    const expired = await createConnection(SESSIONS.valid, {
      status: "expired",
    });

    const results = await syncBankConnections({
      ...options,
      connectionIds: [asked.id, expired.id],
    });

    expect(results.map((result) => result.connectionId)).toEqual([asked.id]);
    expect(await runsOf(notAsked.id)).toEqual([]);
    expect(
      await syncBankConnections({ ...options, connectionIds: [] }),
    ).toEqual([]);
  });
});

describe("sync log", () => {
  it("lists each connection's latest runs newest first, with durations", async () => {
    const { options } = testProvider();
    const connection = await createConnection(SESSIONS.valid);
    const failing = await createConnection(SESSIONS.unavailable);
    let clock = NOW.getTime();
    // Every reading of the clock advances it by 750 ms.
    const ticking = { ...options, now: () => new Date((clock += 750)) };
    await syncBankConnection(connection.id, ticking);
    await syncBankConnection(connection.id, ticking);
    await syncBankConnection(failing.id, ticking);

    const log = await getSyncLog([connection.id, failing.id, randomUUID()], {
      db: testDb.db,
      limit: 3,
    });

    const entries = log.get(connection.id)!;
    expect(entries.map((entry) => entry.kind)).toEqual([
      "transactions",
      "balances",
      "transactions",
    ]);
    expect(entries.every((entry) => entry.status === "succeeded")).toBe(true);
    // A balance run reads the clock twice; a transaction run also per account.
    expect(entries[1].durationMs).toBe(750);
    expect(entries[0].durationMs).toBe(3 * 750);
    expect(entries[2].inserted).toBeGreaterThan(0);
    expect(entries[0].inserted).toBe(0);
    expect(entries[1].accounts).toBe(2);
    expect(log.get(failing.id)).toMatchObject([
      { kind: "balances", status: "failed", error: "fake bank unavailable" },
    ]);
    expect([...log.values()].at(-1)).toEqual([]);
  });

  it("gives the last successful bank sync, not Kraken's", async () => {
    const at = new Date("2030-01-01T10:00:00Z");
    expect(
      (await getLastSuccessfulSync({ db: testDb.db }))?.getTime(),
    ).toBeLessThan(at.getTime());
    await createConnection("kraken-credentials", {
      provider: "kraken",
      lastSyncedAt: new Date("2031-01-01T00:00:00Z"),
    });
    await createConnection(SESSIONS.valid, { lastSyncedAt: at });
    expect(await getLastSuccessfulSync({ db: testDb.db })).toEqual(at);
  });
});
