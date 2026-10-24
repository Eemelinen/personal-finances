import { defineConfig, devices } from "@playwright/test";
import { E2E_AUTH_STATE } from "./tests/e2e/support/credentials";

/**
 * End-to-end tests (L3): Chromium against the production build, served by
 * tests/e2e/support/server.ts with its own Testcontainers Postgres. Needs
 * Docker and the Playwright Chromium (`pnpm exec playwright install chromium`).
 *
 *   pnpm test:e2e                                  build, serve, run every spec
 *   pnpm test:e2e tests/e2e/app-shell.spec.ts      one spec
 *
 * The `setup` project logs in once (tests/e2e/auth.setup.ts); specs start
 * logged in from its storage state unless they reset it (auth.spec.ts).
 * The `dashboard` project (tests/e2e/dashboard.spec.ts) runs before every
 * other spec: it checks the empty dashboard while the database has no
 * accounts, then seeds accounts and balances, which later specs see too.
 * The `reports` project (tests/e2e/reports.spec.ts) runs next, alone, so
 * the report totals see only the transactions it seeds.
 * The `settings-reports` project (tests/e2e/settings-reports.spec.ts) runs
 * after it, alone, so the dashboard's income tile is exactly the reports'
 * seed plus its own credit while it switches the income setting.
 * The `household-settings` project (tests/e2e/household-settings.spec.ts)
 * runs after that, alone, so the income tile changes only by its own
 * household credit while it flips the household toggle.
 * The `investments` project (tests/e2e/investments.spec.ts) runs after the
 * shared `chromium` one, so the balance history there never sees its
 * brokerage and crypto accounts (F-022 counts them in net worth), and
 * `allocation` (tests/e2e/allocation.spec.ts) last, so the holdings table
 * of `investments` lists only its own holdings.
 * The run fails if the app server logged an error line
 * (tests/e2e/support/server-errors.ts), even when every test passed.
 */
const port = process.env.E2E_PORT ?? "3100";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: true,
  globalTeardown: "./tests/e2e/support/server-errors.ts",
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "setup", testMatch: "**/*.setup.ts" },
    {
      name: "dashboard",
      testMatch: "**/dashboard.spec.ts",
      use: { ...devices["Desktop Chrome"], storageState: E2E_AUTH_STATE },
      dependencies: ["setup"],
    },
    {
      name: "reports",
      testMatch: "**/reports.spec.ts",
      use: { ...devices["Desktop Chrome"], storageState: E2E_AUTH_STATE },
      dependencies: ["setup", "dashboard"],
    },
    {
      name: "settings-reports",
      testMatch: "**/settings-reports.spec.ts",
      use: { ...devices["Desktop Chrome"], storageState: E2E_AUTH_STATE },
      dependencies: ["setup", "dashboard", "reports"],
    },
    {
      name: "household-settings",
      testMatch: "**/household-settings.spec.ts",
      use: { ...devices["Desktop Chrome"], storageState: E2E_AUTH_STATE },
      dependencies: ["setup", "dashboard", "reports", "settings-reports"],
    },
    {
      name: "chromium",
      testIgnore: [
        "**/dashboard.spec.ts",
        "**/reports.spec.ts",
        "**/settings-reports.spec.ts",
        "**/household-settings.spec.ts",
        "**/investments.spec.ts",
        "**/allocation.spec.ts",
      ],
      use: { ...devices["Desktop Chrome"], storageState: E2E_AUTH_STATE },
      dependencies: [
        "setup",
        "dashboard",
        "reports",
        "settings-reports",
        "household-settings",
      ],
    },
    {
      name: "investments",
      testMatch: "**/investments.spec.ts",
      use: { ...devices["Desktop Chrome"], storageState: E2E_AUTH_STATE },
      dependencies: [
        "setup",
        "dashboard",
        "reports",
        "settings-reports",
        "household-settings",
        "chromium",
      ],
    },
    {
      name: "allocation",
      testMatch: "**/allocation.spec.ts",
      use: { ...devices["Desktop Chrome"], storageState: E2E_AUTH_STATE },
      dependencies: [
        "setup",
        "dashboard",
        "reports",
        "settings-reports",
        "household-settings",
        "chromium",
        "investments",
      ],
    },
  ],
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
