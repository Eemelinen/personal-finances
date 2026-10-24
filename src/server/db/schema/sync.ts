import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { connections } from "./banking";
import { timestamps, timestamptz } from "./columns";

export const syncStatus = pgEnum("sync_status", [
  "running",
  "succeeded",
  "failed",
]);

/**
 * Which step of a sync a run was: a bank or Kraken sync's accounts and
 * balances, a bank sync's transactions, or Kraken's holdings and ledger.
 */
export const syncRunKind = pgEnum("sync_run_kind", [
  "balances",
  "transactions",
  "holdings",
]);

/** One row per sync of a connection: status, timing, error and counts. */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    connectionId: uuid()
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    startedAt: timestamptz().notNull().defaultNow(),
    finishedAt: timestamptz(),
    // Null for runs recorded before F-010, which did not say.
    kind: syncRunKind(),
    status: syncStatus().notNull().default("running"),
    error: text(),
    accountsCount: integer().notNull().default(0),
    fetchedCount: integer().notNull().default(0),
    insertedCount: integer().notNull().default(0),
    updatedCount: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [index().on(t.connectionId, t.startedAt)],
);
