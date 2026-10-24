# FIN-022: Net worth and allocation including investments

**Feature:** F-022 · **Milestone:** M4 Investments · **Area:** investments · **Depends on:** [F-018](FIN-018-balance-history.md), [F-020](FIN-020-nordnet-import-and-stock-prices.md), [F-021](FIN-021-kraken-and-crypto-prices.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-022`. This ticket is the spec the session reads first.

## Goal

Net-worth history and the dashboard tiles include brokerage and crypto accounts valued with historical prices; an allocation chart breaks wealth down by asset class (cash, stocks and ETFs, funds, crypto) and by account; portfolio performance over time separates contributions from market gains.

## Tests (what the verification proves)

- **L1** `tests/unit/investments/performance.test.ts`: contributions vs market gain
- **L2** `tests/integration/net-worth-investments.int.test.ts`: historical valuation in the net-worth series
- **L3** `tests/e2e/allocation.spec.ts`: allocation and performance charts render seeded data

## Notes

- Replaces old FIN-025.
- Implemented choices (F-022, D-019; nothing in the goal changed): the allocation and the performance are on `/reports/allocation` (a Reports tab); a Nordnet account's cash is the running sum of its EUR cash effects (the export's `Saldo` is not imported); stocks and ETFs are one class; shares are of the positive values; contributions are the value at the range's start plus transfers in and out (units at the day's price; a manual wallet's quantity changes) plus an account's value on the day it first has one (its units without a price yet then count on their first priced day, whether transferred or bought), and the market gain is the rest; the performance can be shown per investment account (`?account=`).
