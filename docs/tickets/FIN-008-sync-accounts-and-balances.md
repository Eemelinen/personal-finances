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
- Choices made without a human (D-009): the F-001 findings do not exist yet, so the display balance type is a default order (`ITAV`, `CLAV`, `ITBD`, `CLBD`, `XPCD`, `OPAV`, `OPBD`) with an empty per-bank override map in `src/server/sync/balance-types.ts`; F-001 / F-006 fill it. Snapshots use the day the provider reports for each balance. Provider errors are returned as a failed result rather than thrown; only auth errors change the connection (`expired`), rate limits and outages leave it `active`. A non-`active` connection gets a failed `sync_runs` row without a provider call; a connection without a stored session counts as an auth error. Archived accounts that the provider lists again are restored. Accounts are matched by `(connection_id, provider_account_ref)` without a unique constraint; F-010's advisory lock keeps two syncs of one connection apart.
