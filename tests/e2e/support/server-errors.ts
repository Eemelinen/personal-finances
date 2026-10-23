/**
 * Runtime errors of the app under test. tests/e2e/support/server.ts copies
 * every error line the app server prints into ERRORS_FILE, and the global
 * teardown fails the L3 run if there are any: a page can render fine while
 * the server logs an error (a prerender or Cache Components violation, a
 * failed action), and no assertion in a spec would notice.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Inside Playwright's outputDir, which it empties before the web server starts.
export const ERRORS_FILE = path.join("test-results", "server-errors.log");

/** Next.js marks errors with "⨯"; uncaught ones print as "…Error: message". */
export function isServerErrorLine(line: string): boolean {
  return line.includes("⨯") || /\b\w*Error: /.test(line);
}

export default function failOnServerErrors(): void {
  const errors = existsSync(ERRORS_FILE)
    ? readFileSync(ERRORS_FILE, "utf8").trim()
    : "";
  if (errors) {
    throw new Error(`the app server logged errors during L3:\n${errors}`);
  }
}
