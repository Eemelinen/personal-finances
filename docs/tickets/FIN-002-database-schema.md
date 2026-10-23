# FIN-002: Database schema, first migration and L2 integration layer

**Feature:** F-002 · **Milestone:** M0 Foundation · **Area:** foundation · **Depends on:** [F-000](FIN-000-scaffold-and-harness.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-002`. This ticket is the spec the session reads first.

## Goal

`pnpm db:migrate` creates the core tables (institutions, connections, accounts, balance_snapshots, transactions, categories, category_rules, sync_runs) with money as bigint minor units plus a currency code and idempotency constraints on transactions and balance snapshots. `pnpm test:integration` (L2) runs Vitest integration tests against a throwaway Postgres 18 started by Testcontainers.

## Acceptance criteria

- Tables in `src/server/db/schema/` (one file per domain area) as in [architecture: data model](../architecture.md#data-model)
- Money columns are `bigint` minor units plus `char(3)` currency; `accounts.type` enum `checking | savings | brokerage | crypto`
- Unique `(account_id, provider_txn_ref)` and `(account_id, dedupe_hash)` on transactions; unique `(account_id, date, balance_type)` on balance_snapshots; indexes on `transactions(account_id, booking_date)` and `transactions(category_id)`
- `timestamptz` everywhere; `created_at` / `updated_at` on mutable tables
- First migration generated with `pnpm db:generate` and committed in `drizzle/`; `docker compose up` applies it
- **L2 layer introduced:** `@testcontainers/postgresql`, `vitest.integration.config.mts` (project `integration`, `tests/integration/**/*.int.test.ts`), a shared helper that starts Postgres 18 and runs the migrations, the `test:integration` script, L2 added to `check:full`, AGENTS.md → Verification layers, init.sh / session-start text and a step in the CI `Verify` job

## Tests (what the verification proves)

- **L1** `tests/unit/server/dedupe-hash.test.ts`: dedupe hash normalises date, amount, counterparty and description
- **L2** `tests/integration/schema.int.test.ts`: migrations apply to a fresh Postgres 18; duplicate provider_txn_ref and dedupe_hash rows per account are rejected

## Notes

- Replaces old FIN-003. Investment tables are F-019.
- `casing: "snake_case"` is configured: TS fields camelCase, columns snake_case.
