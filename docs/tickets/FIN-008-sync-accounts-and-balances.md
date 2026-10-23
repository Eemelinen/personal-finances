# FIN-008: Sync accounts and balances

**Feature:** F-008 · **Milestone:** M1 Bank data · **Area:** banking · **Depends on:** [F-002](FIN-002-database-schema.md), [F-005](FIN-005-provider-contract.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-008`. This ticket is the spec the session reads first.

## Goal

`syncBalances(connectionId)` adds new accounts, archives vanished ones, upserts one balance snapshot per account per day and balance type, writes a `sync_runs` row with status and counts, updates `last_synced_at`, and marks the connection expired instead of failing when the provider reports an auth error.

## Acceptance criteria

- `src/server/sync/sync-balances.ts`
- Preferred display balance type per bank (e.g. `ITAV` / `CLBD`), from F-001 findings, with a sensible default

## Tests (what the verification proves)

- **L2** `tests/integration/sync-balances.int.test.ts`: fake provider: new and archived accounts, same-day upsert, auth error marks the connection expired

## Notes

- Replaces old FIN-008. Depends only on the provider contract, so it can be built before the connect flow.
