/**
 * Direct access to the L3 test database, for specs that seed data no UI can
 * create yet (balance history, consent expiry). tests/e2e/support/server.ts
 * writes the Testcontainers URL to DATABASE_URL_FILE before it serves the app.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDb, type Db } from "@/server/db/client";

// Inside Playwright's outputDir, which it empties before the web server starts.
export const DATABASE_URL_FILE = path.join("test-results", "database-url");

/** `APP_TIMEZONE` of the app under test; seeded days are counted in it. */
export const E2E_TIME_ZONE = "Europe/Helsinki";

/** A small pool to the app's test database; `end()` it in `afterAll`. */
export function openTestDatabase(): Db {
  return createDb(readFileSync(DATABASE_URL_FILE, "utf8").trim(), { max: 2 });
}
