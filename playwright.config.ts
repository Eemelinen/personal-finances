import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (L3): Chromium against the production build, served by
 * tests/e2e/support/server.ts with its own Testcontainers Postgres. Needs
 * Docker and the Playwright Chromium (`pnpm exec playwright install chromium`).
 *
 *   pnpm test:e2e                                  build, serve, run every spec
 *   pnpm test:e2e tests/e2e/app-shell.spec.ts      one spec
 */
const port = process.env.E2E_PORT ?? "3100";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm exec tsx tests/e2e/support/server.ts",
    // Healthy only once the app reaches the test database.
    url: `${baseURL}/api/health`,
    env: { E2E_PORT: port },
    // A cold `next build` plus pulling the Postgres image.
    timeout: 300_000,
    // A fixed port: never test against some other server that happens to run there.
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    stdout: "pipe",
    stderr: "pipe",
  },
});
