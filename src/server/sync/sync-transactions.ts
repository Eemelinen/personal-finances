import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  categorizeTransactions,
  lockCategorization,
} from "@/server/categorization/categorize";
import { getDb } from "@/server/db/client";
import { accounts, connections, transactions } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import { isProviderError } from "@/server/providers/errors";
import { fetchAllTransactions } from "@/server/providers/paging";
import {
  failNotActive,
  failRunOnBug,
  finishRun,
  openConnection,
  recordProviderFailure,
  startRun,
  type ConnectionStatus,
  type SyncErrorKind,
  type SyncFailure,
  type SyncOptions,
  type Tx,
} from "./runs";
import {
  identifyTransactions,
  mergeTransactions,
  syncWindowStart,
  type StoredTransaction,
  type TransactionValues,
} from "./transaction-merge";

// Syncs the transactions of one connection's accounts (F-009).
//
// The accounts come from the last `syncBalances()`: every non-archived one
// with a provider ref. An account never synced is backfilled from the oldest
// day the provider has; after that each sync asks from 7 days before the
// account's last successful one (`accounts.transactions_synced_at`), or from
// its oldest pending transaction if that is older, following every page.
// Each account's listing is merged (`transaction-merge.ts`) and written in
// its own database transaction, so a rate limit on the third account keeps
// the first two and the next sync continues where it stopped. Like
// `syncBalances()`, every call writes one `sync_runs` row, provider failures
// are results and anything else is rethrown (D-009, D-010).
//
// Two syncs of one connection must not run at once (F-010 holds an advisory
// lock around this call).

export { ConnectionNotFoundError } from "./runs";

/**
 * Runs inside the account's database transaction after the merge is
 * written, with the ids of the transactions it inserted or changed (a
 * pending one booked, a text corrected). The default is the rule engine and
 * transfer detection (F-014, `categorizeTransactions`).
 */
export type CategorizeHook = (
  tx: Tx,
  transactionIds: string[],
) => Promise<void>;

export interface SyncTransactionsOptions extends SyncOptions {
  /** Whose calendar days the overlap is counted in; `APP_TIMEZONE`. */
  timeZone?: string;
  categorize?: CategorizeHook;
}

export interface SyncTransactionsCounts {
  /** Accounts whose transactions were synced. */
  accounts: number;
  /** Transactions the provider returned, over all pages. */
  fetched: number;
  inserted: number;
  /** Stored transactions that changed, pending ones booked included. */
  updated: number;
  /** Stored pending transactions the provider no longer lists. */
  removed: number;
}

export interface SyncTransactionsResult {
  runId: string;
  status: "succeeded" | "failed";
  /** The connection's status after the sync. */
  connectionStatus: ConnectionStatus;
  error: string | null;
  errorKind: SyncErrorKind | null;
  retryAfterMs: number | null;
  /** On failure: what the accounts synced before it changed. */
  counts: SyncTransactionsCounts;
}

const NO_COUNTS: Readonly<SyncTransactionsCounts> = {
  accounts: 0,
  fetched: 0,
  inserted: 0,
  updated: 0,
  removed: 0,
};

/** Rows per insert statement, well below Postgres' parameter limit. */
const INSERT_BATCH = 500;

export async function syncTransactions(
  connectionId: string,
  options: SyncTransactionsOptions = {},
): Promise<SyncTransactionsResult> {
  const db = options.db ?? getDb();
  const now = options.now ?? (() => new Date());
  const { connection, runId } = await startRun(
    db,
    connectionId,
    "transactions",
    now,
  );
  const counts: SyncTransactionsCounts = { ...NO_COUNTS };

  const failed = (failure: SyncFailure): SyncTransactionsResult => ({
    runId,
    ...failure,
    counts,
  });

  try {
    if (connection.status !== "active") {
      return failed(await failNotActive(db, runId, connection, now));
    }
    const timeZone = options.timeZone ?? getEnv().APP_TIMEZONE;
    const categorize = options.categorize ?? categorizeTransactions;

    const synced = await db
      .select({
        id: accounts.id,
        ref: accounts.providerAccountRef,
        transactionsSyncedAt: accounts.transactionsSyncedAt,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.connectionId, connection.id),
          eq(accounts.archived, false),
          isNotNull(accounts.providerAccountRef),
        ),
      )
      .orderBy(asc(accounts.providerAccountRef));

    try {
      const { provider, session } = openConnection(connection, options);
      for (const account of synced) {
        const startedAt = now();
        const from = syncWindowStart({
          syncedAt: account.transactionsSyncedAt,
          oldestPendingDate: await oldestPendingDate(db, account.id),
          timeZone,
        });
        const listing = identifyTransactions(
          await fetchAllTransactions(
            provider,
            session,
            account.ref!,
            from === undefined ? {} : { from },
          ),
        );
        await db.transaction(async (tx) => {
          await lockCategorization(tx);
          const stored = await loadStored(tx, account.id, listing);
          const plan = mergeTransactions(stored, listing);
          const insertedIds = await applyPlan(tx, account.id, plan);
          const changedIds = [
            ...insertedIds,
            ...plan.update.map((update) => update.id),
          ];
          if (changedIds.length > 0) await categorize(tx, changedIds);
          await tx
            .update(accounts)
            .set({ transactionsSyncedAt: startedAt })
            .where(eq(accounts.id, account.id));
          counts.accounts++;
          counts.fetched += listing.length;
          counts.inserted += plan.insert.length;
          counts.updated += plan.update.length;
          counts.removed += plan.remove.length;
        });
      }
    } catch (error) {
      if (!isProviderError(error)) throw error;
      return failed(
        await recordProviderFailure(
          db,
          runId,
          connection.id,
          error,
          now,
          runCounts(counts),
        ),
      );
    }

    const finishedAt = now();
    await db.transaction(async (tx) => {
      await finishRun(tx, runId, finishedAt, {
        status: "succeeded",
        ...runCounts(counts),
      });
      await tx
        .update(connections)
        .set({ lastSyncedAt: finishedAt })
        .where(eq(connections.id, connection.id));
    });
    return {
      runId,
      status: "succeeded",
      connectionStatus: connection.status,
      error: null,
      errorKind: null,
      retryAfterMs: null,
      counts,
    };
  } catch (error) {
    // Accounts written before the error stay written: so do their counts.
    await failRunOnBug(db, runId, error, now, runCounts(counts));
    throw error;
  }
}

function runCounts(counts: SyncTransactionsCounts) {
  return {
    accountsCount: counts.accounts,
    fetchedCount: counts.fetched,
    insertedCount: counts.inserted,
    updatedCount: counts.updated,
  };
}

async function oldestPendingDate(
  db: Pick<Tx, "select">,
  accountId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ date: sql<string | null>`min(${transactions.bookingDate})` })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.status, "pending"),
      ),
    );
  return row?.date ?? null;
}

const STORED_COLUMNS = {
  id: transactions.id,
  providerTxnRef: transactions.providerTxnRef,
  dedupeHash: transactions.dedupeHash,
  bookingDate: transactions.bookingDate,
  valueDate: transactions.valueDate,
  amountMinor: transactions.amountMinor,
  currency: transactions.currency,
  counterparty: transactions.counterparty,
  description: transactions.description,
  status: transactions.status,
};

/** Values per `IN (…)` list, well below Postgres' parameter limit. */
const LOOKUP_BATCH = 1_000;

/** What `mergeTransactions()` needs: every pending row and every match. */
async function loadStored(
  tx: Tx,
  accountId: string,
  listing: TransactionValues[],
): Promise<StoredTransaction[]> {
  const refs = listing.flatMap((txn) =>
    txn.providerTxnRef === null ? [] : [txn.providerTxnRef],
  );
  const hashes = listing.map((txn) => txn.dedupeHash);
  const filters = [eq(transactions.status, "pending")];
  for (let start = 0; start < refs.length; start += LOOKUP_BATCH) {
    const batch = refs.slice(start, start + LOOKUP_BATCH);
    filters.push(inArray(transactions.providerTxnRef, batch));
  }
  for (let start = 0; start < hashes.length; start += LOOKUP_BATCH) {
    const batch = hashes.slice(start, start + LOOKUP_BATCH);
    filters.push(inArray(transactions.dedupeHash, batch));
  }

  const byId = new Map<string, StoredTransaction>();
  for (const filter of filters) {
    const rows = await tx
      .select(STORED_COLUMNS)
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), filter));
    for (const row of rows) byId.set(row.id, row);
  }
  return [...byId.values()].sort(
    (a, b) =>
      a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id),
  );
}

/**
 * Writes a merge plan; returns the ids of the inserted rows. Postgres checks
 * unique keys row by row, so updated rows whose ref or hash changes first
 * move to a placeholder key: two rows may swap hashes.
 */
async function applyPlan(
  tx: Tx,
  accountId: string,
  plan: ReturnType<typeof mergeTransactions>,
): Promise<string[]> {
  if (plan.remove.length > 0) {
    await tx.delete(transactions).where(inArray(transactions.id, plan.remove));
  }
  const rekeyed = plan.update
    .filter((update) => update.rekey)
    .map((update) => update.id);
  if (rekeyed.length > 0) {
    await tx
      .update(transactions)
      .set({
        providerTxnRef: null,
        dedupeHash: sql`'rekey:' || ${transactions.id}`,
      })
      .where(inArray(transactions.id, rekeyed));
  }
  for (const update of plan.update) {
    await tx
      .update(transactions)
      .set(update.values)
      .where(eq(transactions.id, update.id));
  }

  const ids: string[] = [];
  for (let start = 0; start < plan.insert.length; start += INSERT_BATCH) {
    const rows = await tx
      .insert(transactions)
      .values(
        plan.insert
          .slice(start, start + INSERT_BATCH)
          .map((values) => ({ ...values, accountId })),
      )
      .returning({ id: transactions.id });
    ids.push(...rows.map((row) => row.id));
  }
  return ids;
}
