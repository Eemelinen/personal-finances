# FIN-009: Sync transactions

**Feature:** F-009 · **Milestone:** M1 Bank data · **Area:** banking · **Depends on:** [F-008](FIN-008-sync-accounts-and-balances.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-009`. This ticket is the spec the session reads first.

## Goal

`syncTransactions(connectionId)` backfills from the oldest available date, then syncs incrementally from `last_synced_at` minus a 7-day overlap; it upserts on `provider_txn_ref` with `dedupe_hash` as fallback, replaces pending transactions with their booked version, removes stale pending ones, never overwrites manual category or note edits, follows pagination and records fetched / inserted / updated counts in `sync_runs`. Running it twice changes nothing.

## Acceptance criteria

- Rate-limit errors stop the run cleanly and are recorded
- A categorisation hook is called after insert (no-op until F-014)

## Tests (what the verification proves)

- **L1** `tests/unit/sync/transaction-merge.test.ts`: pending to booked matching, overlap window, missing provider ids
- **L2** `tests/integration/sync-transactions.int.test.ts`: backfill, idempotent re-run, manual edits preserved

## Notes

- Replaces old FIN-009.
