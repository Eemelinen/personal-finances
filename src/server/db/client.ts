import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "@/server/env";
import * as schema from "./schema";

/** Opens a pool to `url`. App code uses `getDb()`; tests pass their own URL. */
export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, { max: options.max ?? 10 });
  // Must match `casing` in drizzle.config.ts.
  return drizzle(client, { schema, casing: "snake_case" });
}

export type Db = ReturnType<typeof createDb>;

// Kept on globalThis so Next.js hot reloads don't open a new pool each time.
const globalForDb = globalThis as unknown as { db?: Db };

export function getDb(): Db {
  return (globalForDb.db ??= createDb(getEnv().DATABASE_URL));
}

export async function closeDb(): Promise<void> {
  if (globalForDb.db) {
    await globalForDb.db.$client.end();
    globalForDb.db = undefined;
  }
}
