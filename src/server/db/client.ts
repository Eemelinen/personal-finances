import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "@/server/env";
import * as schema from "./schema";

function createDb() {
  const client = postgres(getEnv().DATABASE_URL, { max: 10 });
  // Must match `casing` in drizzle.config.ts.
  return drizzle(client, { schema, casing: "snake_case" });
}

export type Db = ReturnType<typeof createDb>;

// Kept on globalThis so Next.js hot reloads don't open a new pool each time.
const globalForDb = globalThis as unknown as { db?: Db };

export function getDb(): Db {
  return (globalForDb.db ??= createDb());
}

export async function closeDb(): Promise<void> {
  if (globalForDb.db) {
    await globalForDb.db.$client.end();
    globalForDb.db = undefined;
  }
}
