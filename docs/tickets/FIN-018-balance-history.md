# FIN-018: Balance and net-worth history

**Feature:** F-018 · **Milestone:** M3 Dashboard · **Area:** dashboard · **Depends on:** [F-016](FIN-016-dashboard-overview.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-018`. This ticket is the spec the session reads first.

## Goal

`/reports/balances` shows a net-worth line and a stacked per-account area chart for 3 months, 6 months, 1 year or all, carrying the last known balance over days without a sync and reconstructing history before the first sync from transactions (marked estimated), with a tooltip of the per-account breakdown.

## Tests (what the verification proves)

- **L1** `tests/unit/reports/balance-series.test.ts`: gap filling, backward reconstruction
- **L2** `tests/integration/balance-history.int.test.ts`: series built from snapshots and transactions
- **L3** `tests/e2e/balance-history.spec.ts`: range selector changes the series

## Notes

- Replaces old FIN-019.
- F-018 implementation (2026-10-24, D-015): pure ranges and series in `src/server/reports/balance-series.ts`, read model `getBalanceHistory()` in `src/server/queries/balance-history.ts`, page `src/app/(app)/reports/balances/page.tsx` (a Balances tab and a card on `/reports`), charts in `src/components/reports/balance-history-chart.tsx`; date helpers moved to `src/server/dates.ts`. Choices made without a human: `?range=3m|6m|1y|all` (default 3 months) ending today, a month range starting the day after the same day that many months ago; non-archived EUR accounts with at least one snapshot (CSV-only accounts have nothing to reconstruct from and are counted as omitted); estimates go back to the account's first transaction, subtracting booked and pending transactions including transfers; estimated days are dashed in the net-worth line, shaded in both charts and marked "(est.)" in the tooltip and table; days on which some account has no balance yet are a grey "partial" net worth, and the table's net-worth change counts only accounts known at both ends (after the F-018 review).
