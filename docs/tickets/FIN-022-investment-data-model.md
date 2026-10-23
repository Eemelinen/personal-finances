# FIN-022: Investment data model

**Milestone:** M4 Investments · **Status:** Todo · **Depends on:** FIN-003

## Description

Extend the schema for stocks, funds and crypto, so that investment accounts appear next to bank accounts in net worth.

## Acceptance criteria

- [ ] Tables:
  - [ ] `assets`: symbol, name, asset class (`stock`, `etf`, `fund`, `crypto`), exchange, currency, external IDs (ISIN, CoinGecko ID)
  - [ ] `holdings`: account, asset, quantity, with a quantity history or snapshot table
  - [ ] `investment_transactions`: buy, sell, dividend, fee, transfer in or out
  - [ ] `prices`: asset, date, close, currency
- [ ] Brokerage and crypto accounts reuse `accounts` (`type = brokerage | crypto`)
- [ ] Quantities use `numeric` (crypto needs up to 18 decimals). Money stays in minor units.
- [ ] Valuation function: account value on a date = Σ quantity × price, with FX conversion to EUR (an `fx_rates` table)
- [ ] `FinancialProvider` gets an optional `getHoldings()`
- [ ] Migration plus unit tests for valuation
