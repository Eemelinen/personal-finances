# FIN-008: Sync accounts & balances

**Milestone:** M1 Bank data · **Status:** Todo · **Depends on:** FIN-007

## Description

Fetch account details and current balances for a connection and store a daily balance snapshot for each account.

## Acceptance criteria

- [ ] `src/server/sync/sync-balances.ts` exports `syncBalances(connectionId)`
- [ ] New accounts on a connection are added. Accounts that disappear are marked archived, not deleted.
- [ ] One `balance_snapshots` row per account per day per balance type (upsert, so later syncs that day update it)
- [ ] The preferred balance type for display is chosen per bank (e.g. `ITAV`/`CLBD`), based on FIN-001 findings
- [ ] `connections.last_synced_at` updated. A row is written to `sync_runs` with its status and counts.
- [ ] `ProviderAuthError` marks the connection `expired` instead of failing the whole run
- [ ] Unit tests with the fake provider from FIN-005
