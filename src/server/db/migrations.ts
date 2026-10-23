import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client";

/** Generated SQL migrations (`pnpm db:generate`), relative to the repository root. */
export const migrationsFolder = path.resolve("drizzle");

/** Applies every pending migration; already applied ones are skipped. */
export async function applyMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
