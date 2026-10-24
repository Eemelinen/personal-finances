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
- Implemented in F-020 (D-017). Choices made without a human, all in D-017: the reader finds columns by header name (Finnish, English, Swedish), detects UTF-16/UTF-8/Windows-1252 and the delimiter, and gives each `Valuutta` column to the value column before it; each portfolio (`Salkku`) becomes a brokerage account under a `csv` institution `nordnet`; rows dedupe by Nordnet's `Id` and a content hash (identical rows numbered in id order); holdings are derived again from all transactions after every import; withholding taxes are stored as `fee`, currency exchanges and cancelled rows are skipped ("not recorded"), unknown types are row errors.
- Price API: Twelve Data `/eod` (free plan, 8 a minute, 800 a day, enforced by the client), `PRICE_API_KEY` optional; ECB `eurofxref-daily.xml`; worker job `price-update` at 07:30. Addition beyond the ticket: each trade's unit price is stored as a `nordnet_trade` price, so holdings without an API price are valued at their last trade.
- "Included in net worth" is read as the dashboard's net-worth tile (today and its 30-day change) plus the holdings on the account row; the history and allocation are F-022. The import form lives on `/investments`, with no preview step.
- Unverified: the fixture `tests/fixtures/nordnet/transactions-utf16.csv` is synthetic (invented securities and ISINs) and follows the public descriptions of the export; F-023 must compare a real export with `nordnet-csv.ts`.
