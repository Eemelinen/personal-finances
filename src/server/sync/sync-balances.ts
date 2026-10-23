import { and, eq, sql } from "drizzle-orm";
import { decryptSecret } from "@/server/crypto";
import { getDb, type Db } from "@/server/db/client";
import {
  accounts,
  balanceSnapshots,
  connections,
  syncRuns,
} from "@/server/db/schema";
import {
  isProviderError,
  ProviderAuthError,
  ProviderRateLimitError,
  type ProviderError,
  type ProviderErrorKind,
} from "@/server/providers/errors";
import {
  getProviderRegistry,
  type ProviderRegistry,
} from "@/server/providers/registry";
import type {
  FinancialProvider,
  ProviderAccount,
  ProviderBalance,
  ProviderConnection,
} from "@/server/providers/types";

// Syncs the accounts of one connection and their balances (F-008).
//
// Everything is fetched from the provider first and written in one database
// transaction afterwards, so a provider failure halfway leaves the stored
// accounts and balances as they were. Every call writes one `sync_runs` row.
// Provider failures (`ProviderError`) are recorded and returned, not thrown;
// an auth failure also marks the connection `expired`, so the user is asked
// to reconnect. Anything else is a bug: it is recorded and rethrown.
//
// Two syncs of one connection must not run at once (F-010 holds an advisory
// lock around this call).

type ConnectionStatus = (typeof connections.$inferSelect)["status"];

export class ConnectionNotFoundError extends Error {
  override readonly name = "ConnectionNotFoundError";

  constructor(readonly connectionId: string) {
    super(`No connection ${JSON.stringify(connectionId)}`);
  }
}

export interface SyncBalancesOptions {
  db?: Db;
  providers?: ProviderRegistry;
  /** Decrypts `connections.session_ref`; defaults to `decryptSecret()`. */
  decrypt?: (sessionRef: string) => string;
  /** The clock for `started_at`, `finished_at` and `last_synced_at`. */
  now?: () => Date;
}

export interface SyncBalancesCounts {
  /** Accounts the provider listed. */
  accounts: number;
  accountsAdded: number;
  accountsArchived: number;
  /** Archived accounts the provider listed again. */
  accountsRestored: number;
  /** Balances the provider returned. */
  fetched: number;
  /** New snapshots. */
  inserted: number;
  /** Existing snapshots whose amount or currency changed. */
  updated: number;
}

export interface SyncBalancesResult {
  runId: string;
  status: "succeeded" | "failed";
  /** The connection's status after the sync. */
  connectionStatus: ConnectionStatus;
  error: string | null;
  /**
   * Why a failed run failed: the provider error's kind, or `not_active` when
   * the connection is not `active` and the provider was not called.
   */
  errorKind: ProviderErrorKind | "not_active" | null;
  /** When rate limited: how long the provider asked to wait, if it said. */
  retryAfterMs: number | null;
  counts: SyncBalancesCounts;
}

interface FetchedAccount {
  account: ProviderAccount;
  balances: ProviderBalance[];
}

const NO_COUNTS: SyncBalancesCounts = {
  accounts: 0,
  accountsAdded: 0,
  accountsArchived: 0,
  accountsRestored: 0,
  fetched: 0,
  inserted: 0,
  updated: 0,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function syncBalances(
  connectionId: string,
  options: SyncBalancesOptions = {},
): Promise<SyncBalancesResult> {
  const db = options.db ?? getDb();
  const now = options.now ?? (() => new Date());

  const [connection] = await db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!connection) throw new ConnectionNotFoundError(connectionId);

  const [run] = await db
    .insert(syncRuns)
    .values({ connectionId, startedAt: now() })
    .returning({ id: syncRuns.id });

  const failed = (
    connectionStatus: ConnectionStatus,
    error: string,
    errorKind: SyncBalancesResult["errorKind"],
    retryAfterMs: number | null = null,
  ): SyncBalancesResult => ({
    runId: run.id,
    status: "failed",
    connectionStatus,
    error,
    errorKind,
    retryAfterMs,
    counts: NO_COUNTS,
  });

  try {
    if (connection.status !== "active") {
      const error = `The connection is ${connection.status}`;
      await finishRun(db, run.id, now(), { status: "failed", error });
      return failed(connection.status, error, "not_active");
    }

    const providers = options.providers ?? getProviderRegistry();
    const provider = providers.get(connection.provider);
    const decrypt = options.decrypt ?? ((value) => decryptSecret(value));

    let fetched: FetchedAccount[];
    try {
      if (connection.sessionRef === null) {
        throw new ProviderAuthError(
          provider.id,
          "The connection has no provider session",
        );
      }
      fetched = await fetchAccounts(provider, {
        sessionRef: decrypt(connection.sessionRef),
      });
    } catch (error) {
      if (!isProviderError(error)) throw error;
      return await recordProviderFailure(db, run.id, connection.id, error, now);
    }

    return await db.transaction(async (tx) => {
      const counts = await storeAccounts(
        tx,
        connection.id,
        connection.institutionId,
        fetched,
      );
      const finishedAt = now();
      await finishRun(tx, run.id, finishedAt, {
        status: "succeeded",
        accountsCount: counts.accounts,
        fetchedCount: counts.fetched,
        insertedCount: counts.inserted,
        updatedCount: counts.updated,
      });
      await tx
        .update(connections)
        .set({ lastSyncedAt: finishedAt })
        .where(eq(connections.id, connection.id));
      return {
        runId: run.id,
        status: "succeeded" as const,
        connectionStatus: connection.status,
        error: null,
        errorKind: null,
        retryAfterMs: null,
        counts,
      };
    });
  } catch (error) {
    // A bug or a database failure: keep the run from staying `running`.
    await db
      .update(syncRuns)
      .set({ status: "failed", finishedAt: now(), error: errorMessage(error) })
      .where(and(eq(syncRuns.id, run.id), eq(syncRuns.status, "running")));
    throw error;
  }
}

/** Accounts and their balances, one request at a time (rate limits). */
async function fetchAccounts(
  provider: FinancialProvider,
  connection: ProviderConnection,
): Promise<FetchedAccount[]> {
  const listed = await provider.listAccounts(connection);
  const fetched: FetchedAccount[] = [];
  for (const account of listed) {
    const balances = await provider.getBalances(connection, account.ref);
    fetched.push({ account, balances });
  }
  return fetched;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function finishRun(
  db: Db | Tx,
  runId: string,
  finishedAt: Date,
  values: Partial<typeof syncRuns.$inferInsert>,
): Promise<void> {
  await db
    .update(syncRuns)
    .set({ ...values, finishedAt })
    .where(eq(syncRuns.id, runId));
}

async function recordProviderFailure(
  db: Db,
  runId: string,
  connectionId: string,
  error: ProviderError,
  now: () => Date,
): Promise<SyncBalancesResult> {
  const expired = error.kind === "auth_expired";
  const connectionStatus = await db.transaction(async (tx) => {
    await finishRun(tx, runId, now(), {
      status: "failed",
      error: errorMessage(error),
    });
    if (!expired) return "active" as const;
    await tx
      .update(connections)
      .set({ status: "expired" })
      .where(eq(connections.id, connectionId));
    return "expired" as const;
  });
  return {
    runId,
    status: "failed",
    connectionStatus,
    error: errorMessage(error),
    errorKind: error.kind,
    retryAfterMs:
      error instanceof ProviderRateLimitError ? error.retryAfterMs : null,
    counts: NO_COUNTS,
  };
}

/**
 * Adds the accounts the provider lists for the first time, updates and
 * restores known ones, archives the connection's accounts it no longer
 * lists (keeping their history) and upserts the balances.
 */
async function storeAccounts(
  tx: Tx,
  connectionId: string,
  institutionId: string,
  fetched: FetchedAccount[],
): Promise<SyncBalancesCounts> {
  const counts: SyncBalancesCounts = {
    ...NO_COUNTS,
    accounts: fetched.length,
  };
  const existing = await tx
    .select()
    .from(accounts)
    .where(eq(accounts.connectionId, connectionId));
  const byRef = new Map(
    existing.map((account) => [account.providerAccountRef, account]),
  );
  const seen = new Set<string>();

  for (const { account, balances } of fetched) {
    seen.add(account.ref);
    const values = {
      type: account.type,
      name: account.name,
      iban: account.iban,
      currency: account.currency,
    };
    const stored = byRef.get(account.ref);
    let accountId: string;
    if (!stored) {
      const [inserted] = await tx
        .insert(accounts)
        .values({
          ...values,
          connectionId,
          institutionId,
          providerAccountRef: account.ref,
        })
        .returning({ id: accounts.id });
      accountId = inserted.id;
      counts.accountsAdded++;
    } else {
      accountId = stored.id;
      if (stored.archived) counts.accountsRestored++;
      const changed =
        stored.archived ||
        stored.type !== values.type ||
        stored.name !== values.name ||
        stored.iban !== values.iban ||
        stored.currency !== values.currency;
      if (changed) {
        await tx
          .update(accounts)
          .set({ ...values, archived: false })
          .where(eq(accounts.id, stored.id));
      }
    }

    counts.fetched += balances.length;
    const { inserted, updated } = await upsertBalances(tx, accountId, balances);
    counts.inserted += inserted;
    counts.updated += updated;
  }

  for (const stored of existing) {
    if (
      !stored.archived &&
      stored.providerAccountRef !== null &&
      !seen.has(stored.providerAccountRef)
    ) {
      await tx
        .update(accounts)
        .set({ archived: true })
        .where(eq(accounts.id, stored.id));
      counts.accountsArchived++;
    }
  }

  return counts;
}

/**
 * One snapshot per account, day and balance type: a later sync on the same
 * day overwrites the amount. Unchanged snapshots are not rewritten, so the
 * counts say what changed.
 */
async function upsertBalances(
  tx: Tx,
  accountId: string,
  balances: ProviderBalance[],
): Promise<{ inserted: number; updated: number }> {
  // One statement cannot touch a row twice: if a response repeats a day and
  // type, the last one wins.
  const unique = new Map(
    balances.map((balance) => [
      `${balance.date}|${balance.balanceType}`,
      balance,
    ]),
  );
  if (unique.size === 0) return { inserted: 0, updated: 0 };

  const rows = await tx
    .insert(balanceSnapshots)
    .values(
      [...unique.values()].map((balance) => ({
        accountId,
        date: balance.date,
        amountMinor: balance.amountMinor,
        currency: balance.currency,
        balanceType: balance.balanceType,
      })),
    )
    .onConflictDoUpdate({
      target: [
        balanceSnapshots.accountId,
        balanceSnapshots.date,
        balanceSnapshots.balanceType,
      ],
      set: {
        amountMinor: sql`excluded.amount_minor`,
        currency: sql`excluded.currency`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`(balance_snapshots.amount_minor, balance_snapshots.currency) is distinct from (excluded.amount_minor, excluded.currency)`,
    })
    // `xmax = 0` only for rows this statement inserted.
    .returning({ inserted: sql<boolean>`(xmax = 0)` });

  const inserted = rows.filter((row) => row.inserted).length;
  return { inserted, updated: rows.length - inserted };
}
