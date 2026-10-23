# FIN-012: CSV import for Nordea and S-Pankki exports

**Feature:** F-012 · **Milestone:** M1 Bank data · **Area:** banking · **Depends on:** [F-004](FIN-004-single-user-auth.md), [F-009](FIN-009-sync-transactions.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-012`. This ticket is the spec the session reads first.

## Goal

`/import` uploads a Nordea or S-Pankki netbank CSV export (or a generic CSV with chosen columns), previews the parsed rows for a chosen or new manual account and imports them through the same upsert and dedupe path as API sync; the summary shows rows read, inserted, skipped as duplicates and errors with row numbers.

## Acceptance criteria

- Fixtures are synthetic and live in `tests/fixtures/csv/`; real exports are never committed
- Generic mapping: choose date, amount, counterparty and description columns

## Tests (what the verification proves)

- **L1** `tests/unit/csv/bank-csv.test.ts`: Nordea and S-Pankki formats: decimal comma, dd.mm.yyyy dates, Windows-1252, synthetic fixtures
- **L2** `tests/integration/csv-import.int.test.ts`: overlapping imports and API data do not duplicate
- **L3** `tests/e2e/csv-import.spec.ts`: upload, preview, import summary

## Notes

- Replaces old FIN-012. Can be pulled forward right after F-009 if API access is delayed.
