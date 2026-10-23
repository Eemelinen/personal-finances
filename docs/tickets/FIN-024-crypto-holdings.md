# FIN-024: Crypto holdings + prices

**Milestone:** M4 Investments · **Status:** Todo · **Depends on:** FIN-022

## Description

Track crypto holdings from exchanges and wallets.

## Acceptance criteria

- [ ] `KrakenProvider` using the official REST API with a **read-only key** (Query Funds, Query Open/Closed Orders & Trades, Query Ledger Entries only, IP-whitelisted), implementing `getHoldings()` from `BalanceEx`
- [ ] Kraken ledger history (`Ledgers`) imported for deposits, withdrawals, trades and staking rewards, for cost basis and performance
- [ ] Env or config: `KRAKEN_API_KEY` and `KRAKEN_API_SECRET`, with request signing (HMAC-SHA512 with a nonce)
- [ ] Manual holdings for wallets or exchanges without an API, with an optional public-address balance lookup
- [ ] Prices from the CoinGecko API, in the daily (or hourly) `price-update` job
- [ ] Crypto shown on `/investments` and included in net worth
- [ ] API keys encrypted at rest like bank sessions (FIN-007)

## Notes

- See [API access research: Kraken](../api-access-research.md#3-kraken-crypto). Never enable trading, deposit or withdrawal permissions on the key.
