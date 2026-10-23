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
- Implemented 2026-10-23 (D-005). Choices beyond the acceptance criteria, all made without a human:
  - "`timestamptz` everywhere" is read as every _point in time_; calendar days (`transactions.booking_date`, `value_date`, `balance_snapshots.date`) are `date`, because banks report them as days and a timestamp would shift them across midnight.
  - `bigint` money columns are read as JS `number` (`mode: "number"`, exact up to 2^53 minor units) so DTOs and JSON stay plain.
  - `provider` is open `text`, not an enum; `balance_type` holds the provider's ISO 20022 code as text. The closed sets are Postgres enums (see docs/architecture.md → Data model).
  - Every table has `created_at` / `updated_at` (also `balance_snapshots` and `sync_runs`, which syncs update). Extra constraints: unique `(provider, provider_ref)` on institutions and `(parent_id, name)` `NULLS NOT DISTINCT` on categories, for idempotent seeding (F-014).
  - The unique constraints have explicit snake_case names (Drizzle would derive camelCase ones from the TS keys under `casing: "snake_case"`).
  - "`docker compose up` applies it" is covered by an L2 test that runs `src/server/db/migrate.ts` (the `migrate` service's command) against a fresh database; unattended sessions may not run Docker Compose.
- Known limit for F-009 / F-012: two genuinely identical transactions on one day (same amount, counterparty and description, no provider ref) share a `dedupe_hash`, so the second is rejected. The importer must disambiguate them (for example an occurrence counter in the hashed input) if the bank data contains such pairs.
