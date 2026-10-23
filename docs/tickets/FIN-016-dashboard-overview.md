# FIN-016: Dashboard overview

**Feature:** F-016 · **Milestone:** M3 Dashboard · **Area:** dashboard · **Depends on:** [F-004](FIN-004-single-user-auth.md), [F-008](FIN-008-sync-accounts-and-balances.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-016`. This ticket is the spec the session reads first.

## Goal

The dashboard shows net worth, totals in checking and in savings and the change vs 30 days ago, accounts grouped by bank with current balance, last sync and a 90-day sparkline, and connection status (OK, expiring, expired) linking to `/connections`; with no data it guides to Connect bank or Import CSV. Amounts are formatted fi-FI in EUR.

## Acceptance criteria

- Read queries live in `src/server/queries/`; Recharts set up for the sparklines

## Tests (what the verification proves)

- **L1** `tests/unit/format/money.test.ts`: fi-FI EUR formatting of minor units
- **L2** `tests/integration/dashboard-queries.int.test.ts`: net worth, per-type totals and 30-day change from snapshots
- **L3** `tests/e2e/dashboard.spec.ts`: seeded data renders the tiles and account list; empty state

## Notes

- Replaces old FIN-016 minus the app shell (now F-003). Month income/expense tiles come with F-017, which can exclude transfers.
