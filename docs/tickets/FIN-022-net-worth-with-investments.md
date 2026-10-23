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
