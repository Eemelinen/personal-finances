import { randomBytes, randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BankConnectionError,
  completeBankConnection,
  hashState,
  startBankConnection,
  startConnectionRenewal,
  type CompleteOptions,
} from "@/server/connections/authorization";
import { archiveConnection } from "@/server/connections/manage";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import {
  accounts,
  balanceSnapshots,
  bankAuthorizations,
  connections,
  institutions,
  syncRuns,
  transactions,
} from "@/server/db/schema";
import { createFakeProvider, FAKE_SESSION_REFS } from "@/server/providers/fake";
import { createProviderRegistry } from "@/server/providers/registry";
import type {
  BankConnectorProvider,
  ProviderAccount,
  ProviderConnection,
} from "@/server/providers/types";
import { getConsentAlerts } from "@/server/queries/consent";
import {
  syncBankConnection,
  syncBankConnections,
  type BankSyncOptions,
} from "@/server/sync/bank-sync";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// Consent expiry and renewal (F-011) against the fake provider and a real
// Postgres 18: a connection whose consent has ended is skipped by the sync
// (and marked `expired`); renewing it attaches the new session to the same
// connection and accounts, so the account ids and their history stay and
// the next sync continues them.

const KEY = randomBytes(32);
const NOW = new Date("2026-10-24T09:00:00.000Z");
const DAY_MS = 86_400_000;

/** A renewed session's ref: its account ids differ from the first one's. */
const RENEWED_SESSION = "test:renewed";
const RENEWED_PREFIX = "renewed:";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

/**
 * The fake, where the sessions it hands out come from `sessions` in turn
 * (then the fake's own). `RENEWED_SESSION` sees the fake's accounts under
 * new ids, as a bank whose account ids are per session would. Records
 * revoked sessions and account listings.
 */
function testConnector(sessions: string[] = []) {
  let clock = NOW;
  const fake = createFakeProvider({ now: () => clock });
  const calls = { revoked: [] as string[], listed: [] as string[] };
  const queue = [...sessions];
  const renamed = (account: ProviderAccount, sessionRef: string) =>
    sessionRef === RENEWED_SESSION
      ? { ...account, ref: `${RENEWED_PREFIX}${account.ref}` }
      : account;
  const underlying = (connection: ProviderConnection): ProviderConnection =>
    connection.sessionRef === RENEWED_SESSION
      ? { sessionRef: FAKE_SESSION_REFS.valid }
      : connection;
  const ref = (account: string) =>
    account.startsWith(RENEWED_PREFIX)
      ? account.slice(RENEWED_PREFIX.length)
      : account;

  const connector: BankConnectorProvider = {
    ...fake,
    async completeAuthorization(code) {
      const session = await fake.completeAuthorization(code);
      const sessionRef = queue.shift() ?? session.sessionRef;
      return {
        ...session,
        sessionRef,
        accounts: session.accounts.map((account) =>
          renamed(account, sessionRef),
        ),
      };
    },
    async revokeSession(connection) {
      calls.revoked.push(connection.sessionRef);
      return fake.revokeSession(underlying(connection));
    },
    async listAccounts(connection) {
      calls.listed.push(connection.sessionRef);
      const listed = await fake.listAccounts(underlying(connection));
      return listed.map((account) => renamed(account, connection.sessionRef));
    },
    async getBalances(connection, account) {
      return fake.getBalances(underlying(connection), ref(account));
    },
    async getTransactions(connection, account, range, continuationKey) {
      return fake.getTransactions(
        underlying(connection),
        ref(account),
        range,
        continuationKey,
      );
    },
  };
  const options = (): CompleteOptions & BankSyncOptions => ({
    db: testDb.db,
    connector,
    providers: createProviderRegistry([connector]),
    encrypt: (value) => encryptSecret(value, KEY),
    decrypt: (value) => decryptSecret(value, KEY),
    now: () => clock,
    timeZone: "Europe/Helsinki",
    // Rules are F-014's; here only the rows matter.
    categorize: async () => {},
  });
  const setNow = (date: Date) => {
    clock = date;
  };
  return { connector, calls, options, setNow };
}

type Setup = ReturnType<typeof testConnector>;

/** The state and code the bank sends back for the URL `start` returned. */
function callbackFor(url: string) {
  const params = new URL(url, "http://app.test").searchParams;
  return { state: params.get("state")!, code: params.get("code")! };
}

async function connect(setup: Setup): Promise<string> {
  const { url } = await startBankConnection("Nordea", setup.options());
  const result = await completeBankConnection(
    { ...callbackFor(url), error: null },
    setup.options(),
  );
  if (!result.ok) throw new Error(`connect failed: ${result.error}`);
  return result.connectionId;
}

async function renew(setup: Setup, connectionId: string) {
  const { url } = await startConnectionRenewal(connectionId, setup.options());
  return completeBankConnection(
    { ...callbackFor(url), error: null },
    setup.options(),
  );
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
    .orderBy(asc(accounts.iban), asc(accounts.name));
}

async function historyOf(connectionId: string) {
  const ids = (await accountsOf(connectionId)).map((account) => account.id);
  const rows = await testDb.db
    .select({ id: transactions.id, accountId: transactions.accountId })
    .from(transactions)
    .where(inArray(transactions.accountId, ids))
    .orderBy(asc(transactions.id));
  const snapshots = await testDb.db.$count(
    balanceSnapshots,
    inArray(balanceSnapshots.accountId, ids),
  );
  return { transactions: rows, snapshots };
}

async function runCount(connectionId: string) {
  return testDb.db.$count(syncRuns, eq(syncRuns.connectionId, connectionId));
}

/**
 * A connection seeded directly. `nordea`: under the fake's Nordea (which
 * renewal needs, as connecting creates it); otherwise its own institution.
 */
async function createConnection(
  values: Partial<typeof connections.$inferInsert>,
  { nordea = false } = {},
) {
  const [institution] = await testDb.db
    .insert(institutions)
    .values(
      nordea
        ? {
            name: "Nordea",
            country: "FI",
            provider: "fake",
            providerRef: "Nordea",
          }
        : {
            name: `Bank ${randomUUID().slice(0, 8)}`,
            country: "FI",
            provider: "fake",
            providerRef: `test-${randomUUID()}`,
          },
    )
    .onConflictDoUpdate({
      target: [institutions.provider, institutions.providerRef],
      set: { updatedAt: NOW },
    })
    .returning();
  const [connection] = await testDb.db
    .insert(connections)
    .values({
      institutionId: institution.id,
      provider: "fake",
      sessionRef: encryptSecret(FAKE_SESSION_REFS.valid, KEY),
      status: "active",
      ...values,
    })
    .returning();
  return { ...connection, institution: institution.name };
}

describe("consent expiry in the sync", () => {
  it("skips a connection whose consent has ended without calling the bank, marks it expired and logs the skip", async () => {
    const setup = testConnector();
    const ended = await createConnection({
      consentExpiresAt: new Date(NOW.getTime() - 60_000),
    });
    const valid = await createConnection({
      consentExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    });

    const results = (await syncBankConnections(setup.options())).filter(
      (result) => [ended.id, valid.id].includes(result.connectionId),
    );

    expect(
      results.map((result) => [
        result.connectionId,
        result.status,
        result.status === "skipped" ? result.skipReason : null,
      ]),
    ).toEqual([
      [ended.id, "skipped", "consent_expired"],
      [valid.id, "succeeded", null],
    ]);
    expect(results[0].error).toBe(
      "The consent has expired; renew the connection",
    );
    expect((await getConnection(ended.id)).status).toBe("expired");
    expect(await runCount(ended.id)).toBe(0);
    expect(setup.calls.listed).toHaveLength(1);

    // Every later run skips it again, until it is renewed.
    const again = await syncBankConnection(ended.id, setup.options());
    expect(again).toMatchObject({
      status: "skipped",
      skipReason: "consent_expired",
    });
    expect(await runCount(ended.id)).toBe(0);
  });

  it("skips a connection the bank stopped accepting from the next run on", async () => {
    const setup = testConnector();
    const refused = await createConnection({
      sessionRef: encryptSecret(FAKE_SESSION_REFS.expired, KEY),
      consentExpiresAt: new Date(NOW.getTime() + 90 * DAY_MS),
    });

    const first = await syncBankConnection(refused.id, setup.options());
    expect(first).toMatchObject({
      status: "failed",
      errorKind: "auth_expired",
    });
    expect((await getConnection(refused.id)).status).toBe("expired");
    expect(await runCount(refused.id)).toBe(1);

    const second = await syncBankConnection(refused.id, setup.options());
    expect(second).toMatchObject({
      status: "skipped",
      skipReason: "consent_expired",
    });
    expect(await runCount(refused.id)).toBe(1);
  });
});

describe("renewing a connection", () => {
  it("keeps the connection, its account ids, names and history, and the next sync continues them", async () => {
    const setup = testConnector([FAKE_SESSION_REFS.valid, RENEWED_SESSION]);
    const connectionId = await connect(setup);
    expect(
      (await syncBankConnection(connectionId, setup.options())).status,
    ).toBe("succeeded");
    const [checking] = await accountsOf(connectionId);
    await testDb.db
      .update(accounts)
      .set({ name: "Everyday" })
      .where(eq(accounts.id, checking.id));
    const before = await accountsOf(connectionId);
    const history = await historyOf(connectionId);
    expect(history.transactions.length).toBeGreaterThan(0);

    // 180 days later the consent has ended: the sync skips it.
    const later = new Date(NOW.getTime() + 181 * DAY_MS);
    setup.setNow(later);
    expect(
      await syncBankConnection(connectionId, setup.options()),
    ).toMatchObject({ status: "skipped", skipReason: "consent_expired" });
    expect((await getConnection(connectionId)).status).toBe("expired");

    const connectionCount = await testDb.db.$count(connections);
    const { url } = await startConnectionRenewal(connectionId, setup.options());
    const { state, code } = callbackFor(url);
    const [pending] = await testDb.db
      .select()
      .from(bankAuthorizations)
      .where(eq(bankAuthorizations.stateHash, hashState(state)));
    expect(pending).toMatchObject({ connectionId, aspspName: "Nordea" });

    const result = await completeBankConnection(
      { state, code, error: null },
      setup.options(),
    );
    expect(result).toEqual({
      ok: true,
      connectionId,
      accounts: 2,
      renewed: true,
    });

    // The same connection, active again with the new session and consent.
    expect(await testDb.db.$count(connections)).toBe(connectionCount);
    const renewed = await getConnection(connectionId);
    expect(renewed.status).toBe("active");
    expect(decryptSecret(renewed.sessionRef!, KEY)).toBe(RENEWED_SESSION);
    // 180 days (the fake's maximum) less 10 minutes from the renewal.
    expect(renewed.consentExpiresAt).toEqual(
      new Date(later.getTime() + 180 * DAY_MS - 10 * 60_000),
    );
    // The old session is ended at the bank.
    expect(setup.calls.revoked).toEqual([FAKE_SESSION_REFS.valid]);

    // The same accounts (matched by IBAN: the new session's ids differ),
    // with the user's name, now under the new provider ids.
    const after = await accountsOf(connectionId);
    expect(after.map(({ id, name, type }) => ({ id, name, type }))).toEqual(
      before.map(({ id, name, type }) => ({ id, name, type })),
    );
    expect(after.map((account) => account.providerAccountRef)).toEqual(
      before.map((account) => `${RENEWED_PREFIX}${account.providerAccountRef}`),
    );
    expect(await historyOf(connectionId)).toEqual(history);

    // The next sync continues the same accounts: no duplicates, nothing
    // archived, the gap's transactions added, the old ones kept.
    const sync = await syncBankConnection(connectionId, setup.options());
    expect(sync.status).toBe("succeeded");
    expect(sync.balances?.counts).toMatchObject({
      accounts: 2,
      accountsAdded: 0,
      accountsArchived: 0,
    });
    const synced = await accountsOf(connectionId);
    expect(synced.map(({ id, archived }) => ({ id, archived }))).toEqual(
      before.map(({ id }) => ({ id, archived: false })),
    );
    const continued = await historyOf(connectionId);
    expect(continued.transactions.length).toBeGreaterThan(
      history.transactions.length,
    );
    expect(continued.transactions).toEqual(
      expect.arrayContaining(history.transactions),
    );
    expect(continued.snapshots).toBeGreaterThan(history.snapshots);
  });

  it("matches by IBAN, then provider id, restores an archived account and adds a new one", async () => {
    const setup = testConnector();
    const connection = await createConnection(
      { status: "expired", consentExpiresAt: new Date(NOW.getTime() - DAY_MS) },
      { nordea: true },
    );
    const insert = (values: Partial<typeof accounts.$inferInsert>) =>
      testDb.db
        .insert(accounts)
        .values({
          connectionId: connection.id,
          institutionId: connection.institutionId,
          type: "checking",
          name: "Stored",
          currency: "EUR",
          ...values,
        })
        .returning()
        .then(([row]) => row);
    // The fake's checking account by IBAN under an old id; its savings by
    // its id only (no IBAN stored), archived; one the bank no longer lists.
    const checking = await insert({
      name: "Bills",
      iban: "FI0000000000000001",
      providerAccountRef: "old-uid",
    });
    const savings = await insert({
      name: "Rainy day",
      type: "savings",
      iban: null,
      providerAccountRef: "fake-savings",
      archived: true,
    });
    const gone = await insert({
      name: "Closed",
      iban: "FI00 0000 0000 0000 99",
      providerAccountRef: "closed-uid",
    });

    const result = await renew(setup, connection.id);
    expect(result).toMatchObject({ ok: true, renewed: true });

    const after = await accountsOf(connection.id);
    expect(
      after.map(({ id, name, iban, providerAccountRef, archived }) => ({
        id,
        name,
        iban,
        providerAccountRef,
        archived,
      })),
    ).toEqual([
      {
        id: checking.id,
        name: "Bills",
        iban: "FI00 0000 0000 0000 01",
        providerAccountRef: "fake-checking",
        archived: false,
      },
      {
        id: savings.id,
        name: "Rainy day",
        iban: "FI00 0000 0000 0000 02",
        providerAccountRef: "fake-savings",
        archived: false,
      },
      {
        id: gone.id,
        name: "Closed",
        iban: "FI00 0000 0000 0000 99",
        providerAccountRef: "closed-uid",
        archived: false,
      },
    ]);

    // With only the checking account stored, the savings one is added.
    const other = await createConnection(
      { status: "expired" },
      { nordea: true },
    );
    const [only] = await testDb.db
      .insert(accounts)
      .values({
        connectionId: other.id,
        institutionId: other.institutionId,
        type: "checking",
        name: "Only",
        iban: "FI00 0000 0000 0000 01",
        currency: "EUR",
        providerAccountRef: "old-uid",
      })
      .returning();
    expect(await renew(setup, other.id)).toMatchObject({ ok: true });
    const otherAccounts = await accountsOf(other.id);
    expect(
      otherAccounts.map(({ id, name, providerAccountRef }) => [
        id === only.id,
        name,
        providerAccountRef,
      ]),
    ).toEqual([
      [true, "Only", "fake-checking"],
      [false, "Fake Savings", "fake-savings"],
    ]);

    // The sync then archives the account the bank no longer lists.
    const sync = await syncBankConnection(connection.id, setup.options());
    expect(sync.balances?.counts).toMatchObject({
      accountsAdded: 0,
      accountsArchived: 1,
    });
  });

  it("refuses to renew an archived or unknown connection", async () => {
    const setup = testConnector();
    const archived = await createConnection({
      status: "archived",
      sessionRef: null,
    });

    await expect(
      startConnectionRenewal(archived.id, setup.options()),
    ).rejects.toThrow(BankConnectionError);
    await expect(
      startConnectionRenewal(randomUUID(), setup.options()),
    ).rejects.toThrow("That connection no longer exists.");
  });

  it("does not attach a renewal to a connection archived meanwhile, and ends the new session", async () => {
    const setup = testConnector(["test:unused"]);
    const connection = await createConnection(
      { status: "expired" },
      { nordea: true },
    );

    const { url } = await startConnectionRenewal(
      connection.id,
      setup.options(),
    );
    await archiveConnection(connection.id, setup.options());
    setup.calls.revoked.length = 0;

    const result = await completeBankConnection(
      { ...callbackFor(url), error: null },
      setup.options(),
    );
    expect(result).toEqual({ ok: false, error: "invalid_state" });
    expect((await getConnection(connection.id)).status).toBe("archived");
    expect(setup.calls.revoked).toEqual(["test:unused"]);
  });
});

describe("getConsentAlerts", () => {
  it("lists ended consents, then those ending within 14 days, leaving out archived ones and the rest", async () => {
    await testDb.db.delete(connections);
    const expiring = await createConnection({
      consentExpiresAt: new Date(NOW.getTime() + 5 * DAY_MS),
    });
    const ended = await createConnection({
      consentExpiresAt: new Date(NOW.getTime() - DAY_MS),
    });
    const refused = await createConnection({
      status: "expired",
      consentExpiresAt: new Date(NOW.getTime() + 60 * DAY_MS),
    });
    await createConnection({
      consentExpiresAt: new Date(NOW.getTime() + 15 * DAY_MS),
    });
    await createConnection({
      status: "archived",
      consentExpiresAt: new Date(NOW.getTime() - DAY_MS),
    });
    await createConnection({ consentExpiresAt: null });

    const alerts = await getConsentAlerts({ db: testDb.db, now: () => NOW });
    expect(
      alerts.map(({ connectionId, institution, level }) => ({
        connectionId,
        institution,
        level,
      })),
    ).toEqual([
      {
        connectionId: ended.id,
        institution: ended.institution,
        level: "expired",
      },
      {
        connectionId: refused.id,
        institution: refused.institution,
        level: "expired",
      },
      {
        connectionId: expiring.id,
        institution: expiring.institution,
        level: "expiring",
      },
    ]);
  });
});
