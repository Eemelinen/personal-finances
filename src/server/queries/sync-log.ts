import { eq, inArray, lte, max, sql } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { connections, syncRuns } from "@/server/db/schema";
import { BANK_PROVIDER_IDS } from "@/server/providers/types";

// The sync log on /connections and the header's last sync (F-010).

/** Runs shown per connection: a sync is two (balances, transactions). */
export const SYNC_LOG_LIMIT = 10;

export interface SyncLogEntry {
  id: string;
  kind: (typeof syncRuns.$inferSelect)["kind"];
  status: (typeof syncRuns.$inferSelect)["status"];
  startedAt: Date;
  finishedAt: Date | null;
  /** Null while running. */
  durationMs: number | null;
  error: string | null;
  accounts: number;
  fetched: number;
  inserted: number;
  updated: number;
}

/** Each connection's latest runs, newest first. */
export async function getSyncLog(
  connectionIds: string[],
  options: { db?: Db; limit?: number } = {},
): Promise<Map<string, SyncLogEntry[]>> {
  const db = options.db ?? getDb();
  const limit = options.limit ?? SYNC_LOG_LIMIT;
  const log = new Map<string, SyncLogEntry[]>(
    connectionIds.map((id) => [id, []]),
  );
  if (connectionIds.length === 0) return log;

  const ranked = db
    .select({
      id: syncRuns.id,
      rank: sql<number>`row_number() over (partition by ${syncRuns.connectionId} order by ${syncRuns.startedAt} desc, ${syncRuns.id})`.as(
        "rank",
      ),
    })
    .from(syncRuns)
    .where(inArray(syncRuns.connectionId, connectionIds))
    .as("ranked");
  const rows = await db
    .select({
      id: syncRuns.id,
      connectionId: syncRuns.connectionId,
      kind: syncRuns.kind,
      status: syncRuns.status,
      startedAt: syncRuns.startedAt,
      finishedAt: syncRuns.finishedAt,
      error: syncRuns.error,
      accounts: syncRuns.accountsCount,
      fetched: syncRuns.fetchedCount,
      inserted: syncRuns.insertedCount,
      updated: syncRuns.updatedCount,
    })
    .from(syncRuns)
    .innerJoin(ranked, eq(ranked.id, syncRuns.id))
    .where(lte(ranked.rank, limit));

  for (const { connectionId, ...row } of rows) {
    log.get(connectionId)?.push({
      ...row,
      durationMs:
        row.finishedAt === null
          ? null
          : row.finishedAt.getTime() - row.startedAt.getTime(),
    });
  }
  for (const entries of log.values()) {
    entries.sort(
      (a, b) =>
        b.startedAt.getTime() - a.startedAt.getTime() ||
        // A sync's transaction run follows its balance run; with a pinned
        // clock in tests both start at once.
        Number(a.kind === "balances") - Number(b.kind === "balances"),
    );
  }
  return log;
}

/** When a bank connection last synced successfully; null if never. */
export async function getLastSuccessfulSync(
  options: { db?: Db } = {},
): Promise<Date | null> {
  const db = options.db ?? getDb();
  const [row] = await db
    .select({ at: max(connections.lastSyncedAt) })
    .from(connections)
    .where(inArray(connections.provider, [...BANK_PROVIDER_IDS]));
  return row?.at ?? null;
}
