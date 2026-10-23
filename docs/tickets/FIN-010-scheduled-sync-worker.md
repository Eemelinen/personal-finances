# FIN-010: Scheduled sync, "Sync now" & sync log

**Milestone:** M1 Bank data · **Status:** Todo · **Depends on:** FIN-009

## Description

Run bank syncs automatically in the worker, let me trigger a sync from the UI, and show what happened.

## Acceptance criteria

- [ ] A `bank-sync` job in `src/worker/jobs.ts` runs balances and then transactions for every active connection, on a schedule from `SYNC_CRON` (default every 6 hours, within the banks' daily limits)
- [ ] Concurrency guard: a connection is never synced twice at once (Postgres advisory lock, so app and worker can't overlap)
- [ ] "Sync now" button on the dashboard and on `/connections` (server action) with a pending state
- [ ] `/connections/[id]` or a sync log panel shows the last N `sync_runs` with status, duration, counts and errors
- [ ] The header shows the last successful sync time
- [ ] Failed runs are retried with backoff on the next schedule tick. A run never crashes the worker.
