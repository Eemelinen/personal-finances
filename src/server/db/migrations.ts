import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client";

/** Generated SQL migrations (`pnpm db:generate`), relative to the repository root. */
export const migrationsFolder = path.resolve("drizzle");

/** Applies every pending migration; already applied ones are skipped. */
export async function applyMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
  await backfillTransactionSource(db);
}

/**
 * Migration `0012_transaction_source` marks every stored transaction
 * `bank`; those of accounts that never had a connection or provider ref
 * came from CSV imports (F-032). A generated migration cannot express the
 * update, so it runs after the migrations, each time: it changes nothing
 * once done, because the sync writes only accounts with a provider ref.
 */
async function backfillTransactionSource(db: Db): Promise<void> {
  await db.execute(sql`
    update transactions set source = 'csv'
    from accounts
    where transactions.account_id = accounts.id
      and transactions.source = 'bank'
      and accounts.connection_id is null
      and accounts.provider_account_ref is null
  `);
}
