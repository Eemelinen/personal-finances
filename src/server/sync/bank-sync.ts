import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { connections, institutions } from "@/server/db/schema";
import { BANK_PROVIDER_IDS } from "@/server/providers/types";
import {
  ConnectionNotFoundError,
  errorMessage,
  type SyncErrorKind,
  type Tx,
} from "./runs";
import { syncBalances, type SyncBalancesResult } from "./sync-balances";
import {
  syncTransactions,
  type SyncTransactionsOptions,
  type SyncTransactionsResult,
} from "./sync-transactions";

// The bank sync (F-010): the worker's `bank-sync` job, Sync now and the first
// sync after connecting all run `syncBankConnection()`. One connection's sync
// is `syncBalances()` (accounts and balances) and then, if that succeeded,
// `syncTransactions()`, under a Postgres advisory lock per connection, so two
// syncs of one connection never run at once: the second finds the lock taken
// and is skipped (the first one is fetching the same data). The lock is a
// transaction-level one, held by an otherwise idle transaction for the
// duration of the sync, so a crashed process releases it with its
// connection. Archiving or removing a connection waits for it
// (`lockConnectionSync()`), so a sync never writes into a connection that is
// being ended.
//
// Provider failures are results (D-009): a failed connection is logged by
// the caller and retried on the next run. `syncBankConnections()` also turns
// a bug in one connection's sync into a failed result, so the others still
// sync and the worker keeps running.

/** The advisory lock namespace (the first key) of connection syncs. */
const CONNECTION_LOCK_NAMESPACE = 0x46_10;

/**
 * The second key: the first 32 bits of the connection's UUID (random in a
 * v4 UUID). Two connections sharing them would only wait for each other.
 */
function connectionLockKey(connectionId: string): number {
  return Number.parseInt(connectionId.replace(/-/g, "").slice(0, 8), 16) | 0;
}

/**
 * Waits until no sync of the connection runs, then keeps new ones out for
 * the rest of `tx`.
 */
export async function lockConnectionSync(
  tx: Tx,
  connectionId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${CONNECTION_LOCK_NAMESPACE}, ${connectionLockKey(connectionId)})`,
  );
}

/**
 * Why a connection's sync failed: the provider error's kind, `not_active`,
 * or `internal` for a bug or a database failure.
 */
export type BankSyncErrorKind = SyncErrorKind | "internal";

interface BankSyncFields {
  connectionId: string;
  error: string | null;
  errorKind: BankSyncErrorKind | null;
}

/**
 * One connection's sync, by `status`: a succeeded sync ran both steps; a
 * `skipped` one ran neither, because another sync of the connection was
 * running or the connection was removed before its sync started.
 */
export type BankSyncResult = BankSyncFields &
  (
    | {
        status: "succeeded";
        balances: SyncBalancesResult;
        transactions: SyncTransactionsResult;
      }
    | {
        status: "failed";
        /** Null when the sync failed on a bug before it. */
        balances: SyncBalancesResult | null;
        /** Null unless the balances succeeded and the transactions ran. */
        transactions: SyncTransactionsResult | null;
      }
    | { status: "skipped"; balances: null; transactions: null }
  );

export type BankSyncOptions = SyncTransactionsOptions;

function skipped(connectionId: string, error: string): BankSyncResult {
  return {
    connectionId,
    status: "skipped",
    error,
    errorKind: null,
    balances: null,
    transactions: null,
  };
}

/**
 * Syncs one connection's balances, then its transactions; skipped while
 * another sync of it runs. Provider failures are results; anything else is
 * recorded in the run and rethrown.
 */
export async function syncBankConnection(
  connectionId: string,
  options: BankSyncOptions = {},
): Promise<BankSyncResult> {
  const db = options.db ?? getDb();
  const syncOptions = { ...options, db };
  return db.transaction(async (lock) => {
    const [row] = await lock.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${CONNECTION_LOCK_NAMESPACE}, ${connectionLockKey(connectionId)}) as locked`,
    );
    if (!row?.locked) {
      return skipped(connectionId, "A sync of this connection is running");
    }

    let balances: SyncBalancesResult;
    try {
      balances = await syncBalances(connectionId, syncOptions);
    } catch (error) {
      if (error instanceof ConnectionNotFoundError) {
        return skipped(connectionId, "The connection was removed");
      }
      throw error;
    }
    if (balances.status === "failed") {
      return {
        connectionId,
        status: "failed",
        error: balances.error,
        errorKind: balances.errorKind,
        balances,
        transactions: null,
      };
    }

    const transactions = await syncTransactions(connectionId, syncOptions);
    const fields = {
      connectionId,
      error: transactions.error,
      errorKind: transactions.errorKind,
      balances,
      transactions,
    };
    return transactions.status === "succeeded"
      ? { ...fields, status: "succeeded" }
      : { ...fields, status: "failed" };
  });
}

export type BankConnectionSyncResult = BankSyncResult & {
  institution: string;
  /** The error a failed `internal` sync threw, for the log. */
  cause?: unknown;
};

export interface SyncBankConnectionsOptions extends BankSyncOptions {
  /** Only these connections (Sync now on one); default every one. */
  connectionIds?: string[];
}

/**
 * Syncs every `active` bank connection (not Kraken's, which has its own
 * job), oldest first, one at a time. One connection's failure, a bug
 * included, never stops the others.
 */
export async function syncBankConnections(
  options: SyncBankConnectionsOptions = {},
): Promise<BankConnectionSyncResult[]> {
  const { connectionIds, ...syncOptions } = options;
  const db = options.db ?? getDb();
  if (connectionIds?.length === 0) return [];
  const active = await db
    .select({ id: connections.id, institution: institutions.name })
    .from(connections)
    .innerJoin(institutions, eq(institutions.id, connections.institutionId))
    .where(
      and(
        inArray(connections.provider, [...BANK_PROVIDER_IDS]),
        eq(connections.status, "active"),
        connectionIds ? inArray(connections.id, connectionIds) : undefined,
      ),
    )
    .orderBy(asc(connections.createdAt), asc(connections.id));

  const results: BankConnectionSyncResult[] = [];
  for (const { id, institution } of active) {
    try {
      results.push({
        ...(await syncBankConnection(id, { ...syncOptions, db })),
        institution,
      });
    } catch (error) {
      results.push({
        connectionId: id,
        institution,
        status: "failed",
        error: errorMessage(error),
        errorKind: "internal",
        balances: null,
        transactions: null,
        cause: error,
      });
    }
  }
  return results;
}

/** One line per connection for the worker's log, without ids or secrets. */
export function describeBankSync(result: BankConnectionSyncResult): string {
  if (result.status === "skipped") {
    return `${result.institution}: skipped (${result.error})`;
  }
  if (result.status === "failed") {
    return `${result.institution}: failed (${result.errorKind}): ${result.error}`;
  }
  const balances = result.balances.counts;
  const transactions = result.transactions.counts;
  return `${result.institution}: ${balances.accounts} accounts, ${balances.inserted} new and ${balances.updated} changed balances, ${transactions.inserted} new, ${transactions.updated} changed and ${transactions.removed} removed of ${transactions.fetched} transactions`;
}
