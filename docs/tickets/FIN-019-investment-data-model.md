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
