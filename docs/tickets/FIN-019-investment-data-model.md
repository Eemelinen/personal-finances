# FIN-019: Investment data model and valuation

**Feature:** F-019 · **Milestone:** M4 Investments · **Area:** investments · **Depends on:** [F-002](FIN-002-database-schema.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-019`. This ticket is the spec the session reads first.

## Goal

The schema adds assets (symbol, ISIN or CoinGecko id, asset class, currency), holdings with quantity snapshots, investment transactions (buy, sell, dividend, fee, transfer), daily prices and ECB FX rates; brokerage and crypto accounts reuse `accounts`. A valuation function returns an account's EUR value on a date as Σ quantity × price × FX, and `FinancialProvider` gains an optional `getHoldings()`.

## Acceptance criteria

- Quantities are `numeric`; money stays in minor units

## Tests (what the verification proves)

- **L1** `tests/unit/investments/valuation.test.ts`: quantity × price × FX; a missing price falls back to the last known one
- **L2** `tests/integration/investment-schema.int.test.ts`: migration applies; numeric quantities keep 18 decimals

## Notes

- Replaces old FIN-022.
- Implemented in `src/server/db/schema/investments.ts` (migration `drizzle/0003_investments.sql`), `src/server/investments/{decimal,valuation}.ts`, `src/server/queries/investments.ts` and the final `ProviderHolding` in `src/server/providers/types.ts` (D-016).
- Choices made without a human (D-016): `numeric(38, 18)` for quantities, unit prices and rates; holdings are per-day quantity snapshots that hold until the next one (0 = sold out); signed quantity and cash effect on investment transactions; ECB rates as units per EUR; one rounding per position, total = sum of rounded positions; an asset without any earlier price or rate is reported as missing and left out of the total; holdings only, cash balances stay in `balance_snapshots`.
- Deviation (refinement): "money stays in minor units" holds for amounts (`amount_minor` is `bigint`); unit prices are minor units too, but as a `numeric(38, 18)` decimal, since a price per unit can be below a cent (D-016).
