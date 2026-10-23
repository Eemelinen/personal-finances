# FIN-003: App shell and L3 end-to-end layer

**Feature:** F-003 · **Milestone:** M0 Foundation · **Area:** foundation · **Depends on:** [F-000](FIN-000-scaffold-and-harness.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-003`. This ticket is the spec the session reads first.

## Goal

Every page shares an app shell with navigation (Dashboard, Transactions, Reports, Connections, Settings) and a header; pages without content yet show an empty state. `pnpm test:e2e` (L3) builds and serves the app and runs Playwright tests against it.

## Acceptance criteria

- App shell layout with navigation and header; placeholder pages for Transactions, Reports, Connections and Settings
- shadcn/ui initialised (Radix + Tailwind) for the shell components
- **L3 layer introduced:** `@playwright/test` (Chromium), `playwright.config.ts` with a `webServer` that builds and starts the app on a fixed test port, the `test:e2e` script, and the e2e database approach (Testcontainers or a compose `db_test` service — record the choice in docs/DECISIONS.md)
- AGENTS.md → Verification layers, init.sh / session-start text, `harness.config.json` allowedTools and a step in the CI `Verify` job updated for L3

## Tests (what the verification proves)

- **L3** `tests/e2e/app-shell.spec.ts`: every navigation link opens its page; the shell renders at desktop and mobile widths

## Notes

- Moved from old FIN-016 (the app shell part), so every UI feature after it can be verified end to end.
- Cache Components are on: request-time data must sit behind `<Suspense>` (see node_modules/next/dist/docs/).
