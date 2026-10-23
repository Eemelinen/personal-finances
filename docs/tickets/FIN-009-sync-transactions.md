# FIN-009: Sync transactions

**Milestone:** M1 Bank data · **Status:** Todo · **Depends on:** FIN-008

## Description

Fetch transactions for each account: a full backfill on first sync, then incremental syncs. The result must be idempotent: running a sync twice never creates duplicates.

## Acceptance criteria

- [ ] `syncTransactions(connectionId)` does a backfill from the oldest available date (per FIN-001), then incremental syncs from `last_synced_at` minus an overlap window (e.g. 7 days)
- [ ] Upserts on `provider_txn_ref`, falling back to `dedupe_hash` when the bank gives no stable ID
- [ ] Pending → booked: a pending transaction is replaced or updated by its booked version, not duplicated. Stale pending items are removed.
- [ ] Manual edits (category, note) are never overwritten by a re-sync
- [ ] Handles pagination (`continuation_key`) and rate-limit errors
- [ ] `sync_runs` counts: fetched, inserted, updated
- [ ] Unit tests: duplicate payloads, pending → booked, overlap window, no stable ID

## Notes

- After inserting, call the categorization hook (a no-op until FIN-013).
