# FIN-020: Nordnet import and stock prices

**Feature:** F-020 · **Milestone:** M4 Investments · **Area:** investments · **Depends on:** [F-004](FIN-004-single-user-auth.md), [F-019](FIN-019-investment-data-model.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-020`. This ticket is the spec the session reads first.

## Goal

Importing a Nordnet transaction export (Sivuni → Tapahtumat ja laskelmat → Vie CSV-tiedostoon) records buys, sells, dividends, fees and deposits, derives holdings and dedupes overlapping imports; a daily price-update job fetches closing prices and ECB FX rates through a price client that respects the free-tier limit; `/investments` lists holdings with quantity, price, value, gain or loss and portfolio weight, and their value is included in net worth.

## Acceptance criteria

- `PRICE_API_KEY` in the env schema; tests never call the real API
- Synthetic Nordnet fixture only; real exports are never committed

## Tests (what the verification proves)

- **L1** `tests/unit/investments/nordnet-csv.test.ts`: synthetic Nordnet export parsed into investment transactions
- **L1** `tests/unit/investments/price-client.test.ts`: mocked API: parsing, rate limit, unknown symbol
- **L2** `tests/integration/nordnet-import.int.test.ts`: holdings derived from transactions; re-import dedupes
- **L3** `tests/e2e/investments.spec.ts`: import, then the holdings table

## Notes

- Replaces old FIN-023. Nordnet's API is closed to new customers, so CSV is the route ([research](../api-access-research.md#2-nordnet-stocks-funds-osakesäästötili)).
