# FIN-003: Database schema & migrations

**Milestone:** M0 Foundation · **Status:** Todo · **Depends on:** FIN-002

## Description

Define the core tables in Drizzle and generate the first migration. The model must support bank accounts now and brokerage or crypto accounts later without restructuring (see [architecture: data model](../architecture.md#data-model)).

## Acceptance criteria

- [ ] Tables in `src/server/db/schema/`: `institutions`, `connections`, `accounts`, `balance_snapshots`, `transactions`, `categories`, `category_rules`, `sync_runs`
- [ ] Money columns are `bigint` minor units plus a `char(3)` currency. No floats.
- [ ] `accounts.type` is an enum: `checking`, `savings`, `brokerage`, `crypto`
- [ ] `transactions` has a unique `(account_id, provider_txn_ref)` and a unique `(account_id, dedupe_hash)` for idempotent upserts
- [ ] `balance_snapshots` is unique on `(account_id, date, balance_type)`
- [ ] Indexes on `transactions(account_id, booking_date)` and `transactions(category_id)`
- [ ] Timestamps are `timestamptz`. `created_at` and `updated_at` on mutable tables.
- [ ] Migration generated with `npm run db:generate` and committed in `drizzle/`. `docker compose up` applies it.
- [ ] Unit test for the dedupe-hash helper (date + amount + counterparty + description, normalized)

## Notes

- `casing: "snake_case"` is configured, so TS field names are camelCase and the columns are snake_case.
- Keep investment tables out of this ticket (FIN-022).
