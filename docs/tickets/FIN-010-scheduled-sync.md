# FIN-010: Scheduled sync, Sync now and sync log

**Feature:** F-010 · **Milestone:** M1 Bank data · **Area:** banking · **Depends on:** [F-007](FIN-007-connect-bank-flow.md), [F-009](FIN-009-sync-transactions.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-010`. This ticket is the spec the session reads first.

## Goal

The worker runs a `bank-sync` job on `SYNC_CRON` (default every 6 hours) for every active connection; a Postgres advisory lock prevents two syncs of one connection at once, and a failing connection is logged and retried on the next tick without stopping the others or crashing the worker. A Sync now button on the dashboard and `/connections` runs the same sync with a pending state, the first sync runs right after connecting, the connection page shows the last sync runs (status, duration, counts, errors) and the header shows the last successful sync.

## Acceptance criteria

- Job registered in `src/worker/jobs.ts`; `SYNC_CRON` in the env schema
- Default schedule stays within the banks' unattended fetch limits (F-001 findings)

## Tests (what the verification proves)

- **L2** `tests/integration/bank-sync-job.int.test.ts`: advisory lock blocks a concurrent run; a failing connection does not stop the others
- **L3** `tests/e2e/sync-now.spec.ts`: Sync now through the fake provider updates balances and the sync log

## Notes

- Replaces old FIN-010.
