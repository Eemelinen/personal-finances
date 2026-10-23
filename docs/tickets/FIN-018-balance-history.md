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
