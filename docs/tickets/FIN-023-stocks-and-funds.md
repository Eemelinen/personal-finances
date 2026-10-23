# FIN-023: Stocks & funds holdings + prices

**Milestone:** M4 Investments · **Status:** Todo · **Depends on:** FIN-022

## Description

Track stock, ETF and fund holdings and their value over time.

## Acceptance criteria

- [ ] Add holdings manually (asset search, quantity, average purchase price)
- [ ] **Nordnet CSV import** of the transaction export (_Sivuni → Tapahtumat ja laskelmat → Vie CSV-tiedostoon_): buys, sells, dividends, fees, deposits. Holdings are derived from the transactions, and re-imports dedupe overlapping periods.
- [ ] A daily `price-update` worker job fetches closing prices (Twelve Data or Alpha Vantage free tier) and ECB FX rates
- [ ] `/investments`: holdings table with quantity, price, value, gain/loss (absolute and %) and portfolio weight
- [ ] Holdings value included in dashboard net worth
- [ ] API key in env (`PRICE_API_KEY`), and the free-tier rate limit is respected

## Notes

- As of 2026-10 the Nordnet External API is **not onboarding new customers**, and a key reportedly grants full trading access. Recheck when this ticket starts, but plan for CSV. See [API access research](../api-access-research.md#2-nordnet-stocks-funds-osakesäästötili).
- Fixtures must be synthetic. Never commit real exports.
