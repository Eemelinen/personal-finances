import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { decryptSecret, DecryptionError } from "@/server/crypto";
import { getDb, type Db } from "@/server/db/client";
import {
  accounts,
  balanceSnapshots,
  connections,
  institutions,
  transactions,
} from "@/server/db/schema";
import { ProviderAuthError } from "@/server/providers/errors";
import {
  asBankConnector,
  getProviderRegistry,
  type ProviderRegistry,
} from "@/server/providers/registry";
import { BANK_PROVIDER_IDS } from "@/server/providers/types";
import { lockConnectionSync } from "@/server/sync/bank-sync";
import { BANK_ACCOUNT_TYPES, MAX_ACCOUNT_NAME_LENGTH } from "./account-input";
import { BankConnectionError } from "./authorization";

// /connections (F-007): the bank connections with their accounts, renaming
// an account and choosing checking or savings, and ending a connection.
//
// - Remove revokes the session at the provider, then deletes the connection
//   and its accounts with all their history (transactions, balances). An
//   account with CSV-imported rows stays as a manual account with only
//   those rows (F-033); `summarizeRemovals()` counts both for the
//   confirmation.
// - Archive revokes the session too (an archived connection is never synced
//   again), forgets it and archives the accounts; their history stays in
//   reports and the transaction list.
// - A session the provider no longer knows (expired, already revoked) counts
//   as revoked. Any other failure keeps the connection as it was, so a
//   consent is never left running at the bank without the app knowing it.
// - Both wait for a running sync of the connection to finish before they
//   change anything (F-010), so a sync never writes into a connection that
//   is being ended.

export type ConnectionStatus = (typeof connections.$inferSelect)["status"];

export interface ConnectionAccount {
  id: string;
  name: string;
  type: (typeof accounts.$inferSelect)["type"];
  iban: string | null;
  currency: string;
  archived: boolean;
}

export interface ConnectionListItem {
  id: string;
  institutionName: string;
  provider: string;
  status: ConnectionStatus;
  consentExpiresAt: Date | null;
  /** The consent end has passed (the status may still say `active`). */
  consentExpired: boolean;
  lastSyncedAt: Date | null;
  createdAt: Date;
  accounts: ConnectionAccount[];
}

export interface ManageOptions {
  db?: Db;
  providers?: ProviderRegistry;
  /** Decrypts `connections.session_ref`; defaults to `decryptSecret()`. */
  decrypt?: (sessionRef: string) => string;
}

/**
 * Every bank connection (not Kraken's), archived ones last, each with its
 * accounts by name.
 */
export async function listConnections(
  options: { db?: Db; now?: () => Date } = {},
): Promise<ConnectionListItem[]> {
  const db = options.db ?? getDb();
  const now = (options.now ?? (() => new Date()))();
  const rows = await db
    .select({
      id: connections.id,
      institutionName: institutions.name,
      provider: connections.provider,
      status: connections.status,
      consentExpiresAt: connections.consentExpiresAt,
      lastSyncedAt: connections.lastSyncedAt,
      createdAt: connections.createdAt,
    })
    .from(connections)
    .innerJoin(institutions, eq(institutions.id, connections.institutionId))
    .where(inArray(connections.provider, [...BANK_PROVIDER_IDS]))
    .orderBy(
      sql`${connections.status} = 'archived'`,
      asc(institutions.name),
      asc(connections.createdAt),
    );
  if (rows.length === 0) return [];

  const accountRows = await db
    .select({
      id: accounts.id,
      connectionId: accounts.connectionId,
      name: accounts.name,
      type: accounts.type,
      iban: accounts.iban,
      currency: accounts.currency,
      archived: accounts.archived,
    })
    .from(accounts)
    .where(
      inArray(
        accounts.connectionId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(accounts.name), asc(accounts.id));

  return rows.map((row) => ({
    ...row,
    consentExpired:
      row.consentExpiresAt !== null &&
      row.consentExpiresAt.getTime() <= now.getTime(),
    accounts: accountRows
      .filter((account) => account.connectionId === row.id)
      .map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        iban: account.iban,
        currency: account.currency,
        archived: account.archived,
      })),
  }));
}

/** Renames a bank account and sets it to checking or savings. */
export async function updateBankAccount(
  accountId: string,
  input: { name: string; type: string },
  options: { db?: Db } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const name = input.name.trim();
  if (!name) throw new BankConnectionError("Give the account a name.");
  if (name.length > MAX_ACCOUNT_NAME_LENGTH) {
    throw new BankConnectionError(
      `Keep the name under ${MAX_ACCOUNT_NAME_LENGTH + 1} characters.`,
    );
  }
  const type = BANK_ACCOUNT_TYPES.find((value) => value === input.type);
  if (!type) throw new BankConnectionError("Choose checking or savings.");

  const updated = await db
    .update(accounts)
    .set({ name, type })
    .where(
      and(
        eq(accounts.id, accountId),
        inArray(accounts.type, [...BANK_ACCOUNT_TYPES]),
      ),
    )
    .returning({ id: accounts.id });
  if (updated.length === 0) {
    throw new BankConnectionError("This bank account no longer exists.");
  }
}

async function loadConnection(db: Db, connectionId: string) {
  const [connection] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        inArray(connections.provider, [...BANK_PROVIDER_IDS]),
      ),
    );
  if (!connection) {
    throw new BankConnectionError("This connection no longer exists.");
  }
  return connection;
}

/** Ends the connection's session at the provider, if it still has one. */
async function revoke(
  connection: typeof connections.$inferSelect,
  institutionLabel: string,
  options: ManageOptions,
): Promise<void> {
  if (connection.sessionRef === null) return;
  let sessionRef: string;
  try {
    sessionRef = (options.decrypt ?? ((value) => decryptSecret(value)))(
      connection.sessionRef,
    );
  } catch (error) {
    // Encrypted under a lost key: nobody can use the session any more.
    if (error instanceof DecryptionError) return;
    throw error;
  }
  const provider = asBankConnector(
    (options.providers ?? getProviderRegistry()).get(connection.provider),
  );
  try {
    await provider.revokeSession({ sessionRef });
  } catch (error) {
    if (error instanceof ProviderAuthError) return;
    console.warn(
      `[connections] revoking the ${institutionLabel} session failed (${error instanceof Error ? error.name : "unknown"})`,
    );
    throw new BankConnectionError(
      `The bank service could not end the ${institutionLabel} consent, so nothing was changed. Try again later.`,
    );
  }
}

async function institutionName(db: Db, institutionId: string) {
  const [row] = await db
    .select({ name: institutions.name })
    .from(institutions)
    .where(eq(institutions.id, institutionId));
  return row?.name ?? "bank";
}

/** What `removeConnection()` would delete and keep (F-033). */
export interface RemovalSummary {
  /** Accounts deleted with their transactions and balances. */
  deletedAccounts: number;
  /** Accounts kept as manual accounts with their imported rows, by name. */
  keptAccounts: string[];
  /** Transactions from the bank sync (deleted). */
  bankTransactions: number;
  /** Transactions from CSV imports (kept). */
  importedTransactions: number;
}

const NO_REMOVAL: Readonly<RemovalSummary> = {
  deletedAccounts: 0,
  keptAccounts: [],
  bankTransactions: 0,
  importedTransactions: 0,
};

/** Per connection: what removing it would delete and keep. Read-only. */
export async function summarizeRemovals(
  connectionIds: readonly string[],
  options: { db?: Db } = {},
): Promise<Map<string, RemovalSummary>> {
  const db = options.db ?? getDb();
  const summaries = new Map<string, RemovalSummary>(
    connectionIds.map((id) => [id, { ...NO_REMOVAL, keptAccounts: [] }]),
  );
  if (connectionIds.length === 0) return summaries;
  const rows = await db
    .select({
      connectionId: accounts.connectionId,
      name: accounts.name,
      bank: sql<number>`count(${transactions.id}) filter (where ${transactions.source} = 'bank')`.mapWith(
        Number,
      ),
      imported:
        sql<number>`count(${transactions.id}) filter (where ${transactions.source} = 'csv')`.mapWith(
          Number,
        ),
    })
    .from(accounts)
    .leftJoin(transactions, eq(transactions.accountId, accounts.id))
    .where(inArray(accounts.connectionId, [...connectionIds]))
    .groupBy(accounts.id)
    .orderBy(asc(accounts.name), asc(accounts.id));
  for (const row of rows) {
    const summary = summaries.get(row.connectionId!);
    if (!summary) continue;
    summary.bankTransactions += row.bank;
    summary.importedTransactions += row.imported;
    if (row.imported > 0) summary.keptAccounts.push(row.name);
    else summary.deletedAccounts++;
  }
  return summaries;
}

/**
 * Revokes the session, then deletes the connection and its accounts with
 * their transactions and balances. An account holding CSV-imported rows
 * (F-033) is kept as a manual account with only those rows: the import is
 * history the bank no longer gives, and nothing else holds it.
 */
export async function removeConnection(
  connectionId: string,
  options: ManageOptions = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const connection = await loadConnection(db, connectionId);
  await revoke(
    connection,
    await institutionName(db, connection.institutionId),
    options,
  );
  await db.transaction(async (tx) => {
    await lockConnectionSync(tx, connectionId);
    const kept = (
      await tx
        .selectDistinct({ id: accounts.id })
        .from(accounts)
        .innerJoin(transactions, eq(transactions.accountId, accounts.id))
        .where(
          and(
            eq(accounts.connectionId, connectionId),
            eq(transactions.source, "csv"),
          ),
        )
    ).map(({ id }) => id);
    if (kept.length > 0) {
      await tx
        .delete(transactions)
        .where(
          and(
            inArray(transactions.accountId, kept),
            eq(transactions.source, "bank"),
          ),
        );
      await tx
        .delete(balanceSnapshots)
        .where(inArray(balanceSnapshots.accountId, kept));
      await tx
        .update(accounts)
        .set({
          connectionId: null,
          providerAccountRef: null,
          archived: false,
          transactionsSyncedAt: null,
        })
        .where(inArray(accounts.id, kept));
    }
    // `accounts.connection_id` is `ON DELETE SET NULL`, so the accounts go
    // first; their transactions and balances cascade.
    await tx.delete(accounts).where(eq(accounts.connectionId, connectionId));
    await tx.delete(connections).where(eq(connections.id, connectionId));
  });
}

/**
 * Revokes the session, forgets it and archives the connection and its
 * accounts; their history stays.
 */
export async function archiveConnection(
  connectionId: string,
  options: ManageOptions = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const connection = await loadConnection(db, connectionId);
  if (connection.status === "archived") return;
  await revoke(
    connection,
    await institutionName(db, connection.institutionId),
    options,
  );
  await db.transaction(async (tx) => {
    await lockConnectionSync(tx, connectionId);
    await tx
      .update(connections)
      .set({ status: "archived", sessionRef: null })
      .where(eq(connections.id, connectionId));
    await tx
      .update(accounts)
      .set({ archived: true })
      .where(eq(accounts.connectionId, connectionId));
  });
}
