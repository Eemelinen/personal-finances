import { randomBytes } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AUTHORIZATION_TTL_MS,
  BankConnectionError,
  completeBankConnection,
  hashState,
  startBankConnection,
  type CompleteOptions,
} from "@/server/connections/authorization";
import {
  archiveConnection,
  listConnections,
  removeConnection,
  summarizeRemovals,
  updateBankAccount,
  type ManageOptions,
} from "@/server/connections/manage";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { dedupeHash } from "@/server/dedupe-hash";
import {
  accounts,
  balanceSnapshots,
  bankAuthorizations,
  connections,
  institutions,
  transactions,
} from "@/server/db/schema";
import {
  ProviderAuthError,
  ProviderUnavailableError,
} from "@/server/providers/errors";
import {
  createFakeProvider,
  FAKE_ACCOUNTS,
  FAKE_AUTHORIZATION_CODES,
  FAKE_SESSION_REFS,
} from "@/server/providers/fake";
import { createProviderRegistry } from "@/server/providers/registry";
import type {
  BankConnectorProvider,
  StartAuthorizationRequest,
} from "@/server/providers/types";
import { syncBalances } from "@/server/sync/sync-balances";
import { syncTransactions } from "@/server/sync/sync-transactions";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// The connect-bank flow (F-007) against the fake provider and a real
// Postgres 18: starting an authorisation, the callback, renaming accounts,
// and removing or archiving a connection; what Remove keeps and how a bank
// connected anew takes over the accounts the app already holds (F-033).

const KEY = randomBytes(32);
const NOW = new Date("2026-10-24T09:00:00.000Z");

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

/** The fake, recording what the flow asks of it; revoking can be made to fail. */
function recordingConnector() {
  const fake = createFakeProvider({ now: () => NOW });
  const calls = {
    started: [] as StartAuthorizationRequest[],
    revoked: [] as string[],
  };
  const knobs = { revokeError: undefined as Error | undefined };
  const connector: BankConnectorProvider = {
    ...fake,
    async startAuthorization(request) {
      calls.started.push(request);
      return fake.startAuthorization(request);
    },
    async revokeSession(connection) {
      calls.revoked.push(connection.sessionRef);
      if (knobs.revokeError) throw knobs.revokeError;
      return fake.revokeSession(connection);
    },
  };
  const options = (now: Date = NOW): CompleteOptions & ManageOptions => ({
    db: testDb.db,
    connector,
    providers: createProviderRegistry([connector]),
    encrypt: (value) => encryptSecret(value, KEY),
    decrypt: (value) => decryptSecret(value, KEY),
    now: () => now,
  });
  return { connector, calls, knobs, options };
}

/** Starts connecting `bank`; returns the state and code the bank would send back. */
async function start(
  setup: ReturnType<typeof recordingConnector>,
  bank = "Nordea",
) {
  const { url } = await startBankConnection(bank, setup.options());
  const params = new URL(url, "http://app.test").searchParams;
  return { url, state: params.get("state")!, code: params.get("code")! };
}

/** Starts and completes a connection; returns its id. */
async function connect(
  setup: ReturnType<typeof recordingConnector>,
  bank = "Nordea",
): Promise<string> {
  const { state, code } = await start(setup, bank);
  const result = await completeBankConnection(
    { state, code, error: null },
    setup.options(),
  );
  if (!result.ok) throw new Error(`connect failed: ${result.error}`);
  return result.connectionId;
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

async function countConnections() {
  return (await testDb.db.select({ id: connections.id }).from(connections))
    .length;
}

async function pendingState(state: string) {
  const [row] = await testDb.db
    .select()
    .from(bankAuthorizations)
    .where(eq(bankAuthorizations.stateHash, hashState(state)));
  return row;
}

/** Syncs balances and transactions, so the connection has history. */
async function syncHistory(
  setup: ReturnType<typeof recordingConnector>,
  connectionId: string,
) {
  const options = {
    ...setup.options(),
    timeZone: "Europe/Helsinki",
    // Rules are F-014's; here only the rows matter.
    categorize: async () => {},
  };
  expect((await syncBalances(connectionId, options)).status).toBe("succeeded");
  expect((await syncTransactions(connectionId, options)).status).toBe(
    "succeeded",
  );
}

describe("starting an authorisation", () => {
  it("stores a fresh state only as its hash and asks for the bank's maximum consent", async () => {
    const setup = recordingConnector();

    const first = await start(setup);
    const second = await start(setup, "S-Pankki");

    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.state).not.toBe(first.state);
    const row = await pendingState(first.state);
    expect(row).toMatchObject({
      provider: "fake",
      aspspName: "Nordea",
      aspspCountry: "FI",
      expiresAt: new Date(NOW.getTime() + AUTHORIZATION_TTL_MS),
    });
    const stored = await testDb.db.select().from(bankAuthorizations);
    expect(JSON.stringify(stored)).not.toContain(first.state);

    expect(setup.calls.started).toEqual([
      {
        aspsp: { name: "Nordea", country: "FI" },
        state: first.state,
        // 180 days (the fake's maximum, as Enable Banking's) less 10 minutes.
        validUntil: new Date("2027-04-22T08:50:00.000Z"),
      },
      {
        aspsp: { name: "S-Pankki", country: "FI" },
        state: second.state,
        validUntil: new Date("2027-04-22T08:50:00.000Z"),
      },
    ]);
  });

  it("refuses a bank the app does not connect", async () => {
    const setup = recordingConnector();
    const before = await testDb.db.select().from(bankAuthorizations);

    await expect(
      startBankConnection("Danske Bank", setup.options()),
    ).rejects.toBeInstanceOf(BankConnectionError);
    expect(await testDb.db.select().from(bankAuthorizations)).toHaveLength(
      before.length,
    );
    expect(setup.calls.started).toEqual([]);
  });

  it("prunes expired states when the next authorisation starts", async () => {
    const setup = recordingConnector();
    const old = await start(setup);

    const later = new Date(NOW.getTime() + AUTHORIZATION_TTL_MS + 1);
    await startBankConnection("Nordea", setup.options(later));

    expect(await pendingState(old.state)).toBeUndefined();
  });
});

describe("the callback", () => {
  it("stores the connection, its encrypted session, the institution and the accounts", async () => {
    const setup = recordingConnector();
    const { state, code } = await start(setup);

    const result = await completeBankConnection(
      { state, code, error: null },
      setup.options(),
    );

    expect(result).toMatchObject({ ok: true, accounts: 2 });
    const connectionId = (result as { connectionId: string }).connectionId;
    const connection = await getConnection(connectionId);
    expect(connection).toMatchObject({
      provider: "fake",
      status: "active",
      consentExpiresAt: new Date("2027-04-22T08:50:00.000Z"),
      lastSyncedAt: null,
    });
    expect(connection.sessionRef).not.toContain(FAKE_SESSION_REFS.valid);
    expect(decryptSecret(connection.sessionRef!, KEY)).toBe(
      FAKE_SESSION_REFS.valid,
    );

    const [institution] = await testDb.db
      .select()
      .from(institutions)
      .where(eq(institutions.id, connection.institutionId));
    expect(institution).toMatchObject({
      name: "Nordea",
      country: "FI",
      provider: "fake",
      providerRef: "Nordea",
    });

    const stored = await accountsOf(connectionId);
    expect(
      stored.map(
        ({ providerAccountRef, name, type, iban, currency, archived }) => ({
          ref: providerAccountRef,
          name,
          type,
          iban,
          currency,
          archived,
        }),
      ),
    ).toEqual(
      FAKE_ACCOUNTS.map((account) => ({ ...account, archived: false })),
    );
    expect(
      stored.every(
        (account) => account.institutionId === connection.institutionId,
      ),
    ).toBe(true);
    expect(await pendingState(state)).toBeUndefined();
  });

  it("reuses the bank's institution for a second connection", async () => {
    const setup = recordingConnector();

    const first = await getConnection(await connect(setup));
    const second = await getConnection(await connect(setup));
    const other = await getConnection(await connect(setup, "S-Pankki"));

    expect(second.institutionId).toBe(first.institutionId);
    expect(other.institutionId).not.toBe(first.institutionId);
  });

  it("accepts a state only once", async () => {
    const setup = recordingConnector();
    const { state, code } = await start(setup);
    await completeBankConnection({ state, code, error: null }, setup.options());
    const count = await countConnections();

    const again = await completeBankConnection(
      { state, code, error: null },
      setup.options(),
    );

    expect(again).toEqual({ ok: false, error: "invalid_state" });
    expect(await countConnections()).toBe(count);
  });

  it("rejects a missing, unknown or expired state", async () => {
    const setup = recordingConnector();
    const { state, code } = await start(setup);
    const count = await countConnections();

    for (const bad of [null, "", "not-a-state-we-sent"]) {
      expect(
        await completeBankConnection(
          { state: bad, code, error: null },
          setup.options(),
        ),
      ).toEqual({ ok: false, error: "invalid_state" });
    }
    // The bad attempts left the real state alone; an hour later it is
    // expired, and the attempt still uses it up.
    expect(await pendingState(state)).toBeDefined();
    const later = new Date(NOW.getTime() + AUTHORIZATION_TTL_MS);
    expect(
      await completeBankConnection(
        { state, code, error: null },
        setup.options(later),
      ),
    ).toEqual({ ok: false, error: "invalid_state" });
    expect(await pendingState(state)).toBeUndefined();
    expect(await countConnections()).toBe(count);
  });

  it("reports a login cancelled at the bank and uses up the state", async () => {
    const setup = recordingConnector();
    const { state } = await start(setup);
    const count = await countConnections();

    expect(
      await completeBankConnection(
        { state, code: null, error: "access_denied" },
        setup.options(),
      ),
    ).toEqual({ ok: false, error: "cancelled" });
    expect(await pendingState(state)).toBeUndefined();
    expect(await countConnections()).toBe(count);
  });

  it("reports bank and provider errors without storing anything", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const setup = recordingConnector();
      const count = await countConnections();
      const attempts = [
        { code: null, error: "server_error" },
        { code: null, error: null },
        { code: FAKE_AUTHORIZATION_CODES.unavailable, error: null },
        { code: "fake-code:spent", error: null },
      ];

      for (const attempt of attempts) {
        const { state } = await start(setup);
        expect(
          await completeBankConnection({ state, ...attempt }, setup.options()),
        ).toEqual({ ok: false, error: "provider_error" });
      }
      expect(await countConnections()).toBe(count);
      // Logged by error name, never with the code.
      expect(warn.mock.calls.flat().join("\n")).not.toContain("fake-code");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("managing connections", () => {
  it("lists bank connections with their accounts, archived ones last", async () => {
    const setup = recordingConnector();
    const archivedId = await connect(setup, "S-Pankki");
    // Connected before the archive: the fake's banks share IBANs, and a
    // bank connected anew takes over archived accounts (F-033).
    const activeId = await connect(setup);
    await archiveConnection(archivedId, setup.options());
    await testDb.db
      .update(connections)
      .set({ consentExpiresAt: new Date(NOW.getTime() - 1) })
      .where(eq(connections.id, activeId));

    const listed = (await listConnections({ db: testDb.db, now: () => NOW }))
      .filter(({ id }) => id === activeId || id === archivedId)
      .map(({ id, institutionName, status, consentExpired, accounts }) => ({
        id,
        institutionName,
        status,
        consentExpired,
        accounts: accounts.map(({ name, type, archived }) => ({
          name,
          type,
          archived,
        })),
      }));

    expect(listed).toEqual([
      {
        id: activeId,
        institutionName: "Nordea",
        status: "active",
        consentExpired: true,
        accounts: [
          { name: "Fake Checking", type: "checking", archived: false },
          { name: "Fake Savings", type: "savings", archived: false },
        ],
      },
      {
        id: archivedId,
        institutionName: "S-Pankki",
        status: "archived",
        consentExpired: false,
        accounts: [
          { name: "Fake Checking", type: "checking", archived: true },
          { name: "Fake Savings", type: "savings", archived: true },
        ],
      },
    ]);
  });

  it("renames an account and sets its type, and the next sync keeps both", async () => {
    const setup = recordingConnector();
    const connectionId = await connect(setup);
    const [checking] = await accountsOf(connectionId);

    await updateBankAccount(
      checking.id,
      { name: "  Bills  ", type: "savings" },
      { db: testDb.db },
    );
    await syncHistory(setup, connectionId);

    const [after] = await accountsOf(connectionId);
    expect(after).toMatchObject({ name: "Bills", type: "savings" });
  });

  it("refuses an empty or long name, another type and a missing account", async () => {
    const setup = recordingConnector();
    const [account] = await accountsOf(await connect(setup));
    const options = { db: testDb.db };

    for (const input of [
      { name: "   ", type: "checking" },
      { name: "x".repeat(101), type: "checking" },
      { name: "Name", type: "brokerage" },
    ]) {
      await expect(
        updateBankAccount(account.id, input, options),
      ).rejects.toBeInstanceOf(BankConnectionError);
    }
    await expect(
      updateBankAccount(
        "00000000-0000-4000-8000-000000000000",
        { name: "Name", type: "checking" },
        options,
      ),
    ).rejects.toBeInstanceOf(BankConnectionError);
    const [unchanged] = await accountsOf(account.connectionId!);
    expect(unchanged.name).toBe(account.name);
  });

  it("removes a connection: revokes the session, then deletes it with its accounts and history", async () => {
    const setup = recordingConnector();
    const connectionId = await connect(setup);
    await syncHistory(setup, connectionId);
    const accountIds = (await accountsOf(connectionId)).map(({ id }) => id);
    const { institutionId } = await getConnection(connectionId);

    await removeConnection(connectionId, setup.options());

    expect(setup.calls.revoked).toEqual([FAKE_SESSION_REFS.valid]);
    expect(await getConnection(connectionId)).toBeUndefined();
    expect(
      await testDb.db
        .select()
        .from(accounts)
        .where(inArray(accounts.id, accountIds)),
    ).toEqual([]);
    expect(
      await testDb.db
        .select()
        .from(balanceSnapshots)
        .where(inArray(balanceSnapshots.accountId, accountIds)),
    ).toEqual([]);
    expect(
      await testDb.db
        .select()
        .from(transactions)
        .where(inArray(transactions.accountId, accountIds)),
    ).toEqual([]);
    const [institution] = await testDb.db
      .select()
      .from(institutions)
      .where(eq(institutions.id, institutionId));
    expect(institution).toBeDefined();
  });

  it("keeps the connection when the provider cannot revoke it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const setup = recordingConnector();
      const connectionId = await connect(setup);
      setup.knobs.revokeError = new ProviderUnavailableError("fake", "down");

      await expect(
        removeConnection(connectionId, setup.options()),
      ).rejects.toBeInstanceOf(BankConnectionError);
      await expect(
        archiveConnection(connectionId, setup.options()),
      ).rejects.toBeInstanceOf(BankConnectionError);

      expect(await getConnection(connectionId)).toMatchObject({
        status: "active",
      });
      expect(await accountsOf(connectionId)).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("treats a session the provider no longer knows as revoked", async () => {
    const setup = recordingConnector();
    const connectionId = await connect(setup);
    setup.knobs.revokeError = new ProviderAuthError("fake", "gone");

    await removeConnection(connectionId, setup.options());

    expect(await getConnection(connectionId)).toBeUndefined();
  });

  it("archives a connection: revokes and forgets the session, archives the accounts, keeps their history", async () => {
    const setup = recordingConnector();
    const connectionId = await connect(setup);
    await syncHistory(setup, connectionId);
    const before = await accountsOf(connectionId);
    const snapshotsBefore = await testDb.db
      .select()
      .from(balanceSnapshots)
      .where(
        inArray(
          balanceSnapshots.accountId,
          before.map(({ id }) => id),
        ),
      );
    expect(snapshotsBefore.length).toBeGreaterThan(0);

    await archiveConnection(connectionId, setup.options());
    await archiveConnection(connectionId, setup.options());

    expect(setup.calls.revoked).toEqual([FAKE_SESSION_REFS.valid]);
    expect(await getConnection(connectionId)).toMatchObject({
      status: "archived",
      sessionRef: null,
    });
    const after = await accountsOf(connectionId);
    expect(after.map(({ id, archived }) => ({ id, archived }))).toEqual(
      before.map(({ id }) => ({ id, archived: true })),
    );
    expect(
      await testDb.db
        .select()
        .from(balanceSnapshots)
        .where(
          inArray(
            balanceSnapshots.accountId,
            before.map(({ id }) => id),
          ),
        ),
    ).toHaveLength(snapshotsBefore.length);
    expect(
      await testDb.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          inArray(
            transactions.accountId,
            before.map(({ id }) => id),
          ),
        ),
    ).not.toHaveLength(0);

    // Removing it later deletes the history without calling the provider.
    await removeConnection(connectionId, setup.options());
    expect(setup.calls.revoked).toHaveLength(1);
    expect(await getConnection(connectionId)).toBeUndefined();
  });

  it("refuses a connection that does not exist", async () => {
    const setup = recordingConnector();
    const missing = "00000000-0000-4000-8000-000000000000";

    await expect(
      removeConnection(missing, setup.options()),
    ).rejects.toBeInstanceOf(BankConnectionError);
    await expect(
      archiveConnection(missing, setup.options()),
    ).rejects.toBeInstanceOf(BankConnectionError);
  });
});

describe("history across removal and reconnects (F-033)", () => {
  async function rowsOf(accountId: string) {
    return testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, accountId))
      .orderBy(asc(transactions.bookingDate), asc(transactions.id));
  }

  /**
   * Stores an imported copy of `row` the way an export describes it: other
   * texts, no ref, a day earlier (Nordea's API books some a day later).
   */
  async function importCopyOf(row: typeof transactions.$inferSelect) {
    const bookingDate = new Date(Date.parse(row.bookingDate) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const values = {
      bookingDate,
      amountMinor: row.amountMinor,
      counterparty: "EXPORT NAME OY",
      description: "Korttiosto",
    };
    const [inserted] = await testDb.db
      .insert(transactions)
      .values({
        ...values,
        accountId: row.accountId,
        currency: row.currency,
        dedupeHash: dedupeHash(values),
        source: "csv",
      })
      .returning();
    return inserted;
  }

  async function deleteAccounts(ids: string[]) {
    await testDb.db.delete(accounts).where(inArray(accounts.id, ids));
  }

  it("remove keeps an account with imported rows as a manual account and deletes its bank rows", async () => {
    const setup = recordingConnector();
    const connectionId = await connect(setup);
    await syncHistory(setup, connectionId);
    const [checking, savings] = await accountsOf(connectionId);
    const bankRows = await rowsOf(checking.id);
    expect(bankRows.length).toBeGreaterThan(1);
    const savingsRows = await rowsOf(savings.id);
    const imported = await importCopyOf(bankRows[0]);

    const summaries = await summarizeRemovals([connectionId], {
      db: testDb.db,
    });
    expect(summaries.get(connectionId)).toEqual({
      deletedAccounts: 1,
      keptAccounts: [checking.name],
      bankTransactions: bankRows.length + savingsRows.length,
      importedTransactions: 1,
    });

    await removeConnection(connectionId, setup.options());

    expect(await getConnection(connectionId)).toBeUndefined();
    const [kept] = await testDb.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, checking.id));
    expect(kept).toMatchObject({
      connectionId: null,
      providerAccountRef: null,
      archived: false,
      name: checking.name,
      iban: checking.iban,
      transactionsSyncedAt: null,
    });
    expect((await rowsOf(checking.id)).map(({ id }) => id)).toEqual([
      imported.id,
    ]);
    expect(
      await testDb.db
        .select()
        .from(balanceSnapshots)
        .where(eq(balanceSnapshots.accountId, checking.id)),
    ).toEqual([]);
    expect(
      await testDb.db
        .select()
        .from(accounts)
        .where(eq(accounts.id, savings.id)),
    ).toEqual([]);

    await deleteAccounts([checking.id]);
  });

  it("connecting anew reuses an archived account with the same IBAN without duplicating its transactions", async () => {
    const setup = recordingConnector();
    const archivedId = await connect(setup);
    await syncHistory(setup, archivedId);
    const before = await accountsOf(archivedId);
    const counts = await Promise.all(
      before.map(async ({ id }) => (await rowsOf(id)).length),
    );
    await updateBankAccount(
      before[0].id,
      { name: "My bills", type: "savings" },
      { db: testDb.db },
    );
    await archiveConnection(archivedId, setup.options());

    const connectionId = await connect(setup);
    const after = await accountsOf(connectionId);
    expect(after.map(({ id }) => id)).toEqual(before.map(({ id }) => id));
    expect(after[0]).toMatchObject({
      name: "My bills",
      type: "savings",
      archived: false,
      transactionsSyncedAt: null,
    });
    expect(await accountsOf(archivedId)).toEqual([]);

    await syncHistory(setup, connectionId);
    expect(
      await Promise.all(after.map(async ({ id }) => (await rowsOf(id)).length)),
    ).toEqual(counts);

    // Not taken from a connection that is still in use.
    const third = await connect(setup);
    expect(
      (await accountsOf(third)).every(
        ({ id }) => !after.some((account) => account.id === id),
      ),
    ).toBe(true);
    await removeConnection(third, setup.options());
    await removeConnection(connectionId, setup.options());
    await removeConnection(archivedId, setup.options());
  });

  it("connecting anew attaches a kept manual account and its sync adopts the imported rows", async () => {
    const setup = recordingConnector();
    const firstId = await connect(setup);
    await syncHistory(setup, firstId);
    const [checking] = await accountsOf(firstId);
    const bankRows = await rowsOf(checking.id);
    const imported = await importCopyOf(bankRows[bankRows.length - 1]);
    await removeConnection(firstId, setup.options());
    expect(await rowsOf(checking.id)).toHaveLength(1);

    const connectionId = await connect(setup);
    const attached = await accountsOf(connectionId);
    expect(attached.map(({ id }) => id)).toContain(checking.id);
    await syncHistory(setup, connectionId);

    const rows = await rowsOf(checking.id);
    // The bank's history once: its copy of the imported row is that row.
    expect(rows).toHaveLength(bankRows.length);
    const adopted = rows.find(({ id }) => id === imported.id);
    expect(adopted).toMatchObject({
      source: "csv",
      providerTxnRef: bankRows[bankRows.length - 1].providerTxnRef,
    });

    await removeConnection(connectionId, setup.options());
    await deleteAccounts([checking.id]);
  });
});
