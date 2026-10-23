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
- Choices made unattended (D-010), deviations from the Goal in bold:
  - **The incremental window starts from a per-account watermark, `accounts.transactions_synced_at` minus 7 days, not `connections.last_synced_at`**: `syncBalances()` sets the latter too, so transactions that keep failing would leave a gap, and an account added later would get only 7 days. The window also reaches back to the account's oldest stored pending transaction. `last_synced_at` is still set on success.
  - **Provider contract changed** (F-005 types): `TransactionRange.from` is optional (backfill = "oldest available", the provider decides how far), and `getTransactions()` is paged with a `continuationKey`; `fetchAllTransactions()` follows the pages. The fake pages by 100.
  - **New column `transactions.note`** (migration `0001_sync_transactions.sql`, with `transactions_synced_at`), so preserving note edits is testable; F-015 edits it.
  - Own `sync_runs` row per call; each account is written in its own database transaction, so a rate limit keeps the accounts already done and is recorded with their counts. `removed` (stale pending) is in the result only; `sync_runs` has no column for it.
  - Pending → booked: matched by ref, then hash, then same amount and currency within 7 days (same counterparty first). Unmatched stored pending rows are deleted; booked rows are never deleted.
  - Identical transactions in one listing get an occurrence number in their `dedupe_hash` (resolves the FIN-002 known limit for synced data).
  - Categorisation hook: `categorize(tx, insertedIds)` option, called after inserts in the same database transaction, default no-op.
