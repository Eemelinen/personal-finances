# FIN-038: L3 runs with a test environment of its own

**Feature:** F-038 · **Milestone:** M6 Data correctness · **Area:** harness · **Depends on:** [F-003](FIN-003-app-shell-and-e2e-layer.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-038`. This ticket is the spec the session reads first.

## Goal

`pnpm test:e2e` works in any checkout, including one with a real `.env` (the real machine's main checkout, where Docker Compose reads it). Today `next build` copies the checkout's `.env` files into `.next/standalone`, and the served test app loads them. Every variable that `tests/e2e/support/server.ts` does not set itself then comes from the production configuration. On the real machine the test app answered `/api/health` with 503, and Playwright's webServer timed out after 300 s. L3 must build and serve the test app with a test environment of its own, and the build output must not carry a copy of the real secrets.

## Acceptance criteria

- A pure function, for example `testEnvironment(base)` in `tests/e2e/support/test-env.ts`, returns the environment for the e2e build and the served app:
  - every variable of the schemas in `src/server/env.ts` (`envSchema`, the auth and the encryption schema) gets a test value, or an empty value for an optional one, which `env.ts` already reads as unset. Next.js never overrides a variable the process already has, so a `.env` cannot supply any of them;
  - variables the app does not read (`PATH`, Docker and Testcontainers settings) pass through from `base`;
  - the list of app variables comes from the schemas themselves (export their keys from `env.ts` if needed), so a variable added later is covered without editing the test environment.
- `server.ts` runs `next build` and the standalone server with that environment. Before serving it deletes every `.env*` file Next.js copied into `.next/standalone`, and checks that none is left.
- Before serving, `server.ts` parses the test environment with the app's own parsers (`parseEnv()`, `parseAuthEnv()`, `parseEncryptionEnv()`). A failure stops the run at once with the parser's message, instead of waiting for the webServer timeout.
- Nothing changes for the L2 Testcontainers setup, the Playwright projects or the production Docker build (`.dockerignore` already leaves `.env*` out).
- `README.md` (or `docs/architecture.md` → testing) and the comment at the top of `server.ts` say how L3 gets its environment.

## Tests (what the verification proves)

- **L1** `tests/unit/e2e/test-env.test.ts` (or the unit project's equivalent path), with a `base` holding production-like values for every app variable (a `DATABASE_URL` to another host, `BANK_PROVIDER=enable_banking`, `BACKUP_AGE_RECIPIENTS`, `NTFY_URL`, a real-looking `ENCRYPTION_KEY`):
  - the result has only test values for app variables;
  - every schema key is present;
  - the result parses with `parseEnv()`, `parseAuthEnv()` and `parseEncryptionEnv()`;
  - unrelated variables pass through.
- **L1**: the helper that removes `.env*` from a standalone directory, against a temporary directory.
- **L3** `tests/e2e/app-shell.spec.ts`: the suite still passes through the new environment.

## Notes

- Found on the real machine on 2026-10-25 while verifying F-035: L3 failed only in the main checkout, which has the real `.env`. Loop worktrees have none, which is why the loop never saw it.
- The guard denies agents reading or writing `.env`, `.env.local` and `.env.*.local`, so a test must not create one. The unit tests prove the isolation instead, and a human checks it once on the real machine by running `pnpm test:e2e tests/e2e/app-shell.spec.ts` in the main checkout.
