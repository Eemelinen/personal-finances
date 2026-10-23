# FIN-021: Kraken holdings and crypto prices

**Feature:** F-021 · **Milestone:** M4 Investments · **Area:** investments · **Depends on:** [F-019](FIN-019-investment-data-model.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-021`. This ticket is the spec the session reads first.

## Goal

`KrakenProvider` signs private REST calls (HMAC-SHA512 with a nonce) with a read-only key from `KRAKEN_API_KEY` / `KRAKEN_API_SECRET`, maps `BalanceEx` to holdings and `Ledgers` to investment transactions (deposits, withdrawals, trades, staking); manual holdings cover wallets without an API; CoinGecko prices are added to the price-update job; crypto appears on `/investments` and in net worth.

## Acceptance criteria

- Key needs only Query Funds, Query Open/Closed Orders & Trades and Query Ledger Entries; never trading, deposit or withdrawal
- Stored keys encrypted with `src/server/crypto.ts`

## Tests (what the verification proves)

- **L1** `tests/unit/investments/kraken.test.ts`: signature against Kraken's documented example; BalanceEx and Ledgers mapping from fixtures
- **L2** `tests/integration/crypto-holdings.int.test.ts`: holdings and prices stored; a manual holding is valued

## Notes

- Replaces old FIN-024. See [research: Kraken](../api-access-research.md#3-kraken-crypto).
