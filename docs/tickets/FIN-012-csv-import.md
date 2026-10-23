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
- Implemented 2026-10-23 (D-011). Choices made without a human:
  - Deviation: the importer is `src/server/csv/`, not a `FinancialProvider` under `providers/csv/`, and uses its own small RFC 4180 reader instead of papaparse (tech stack candidate).
  - Bank layouts are matched by Finnish header names (Nordea `Kirjauspäivä` + `Määrä`, S-Pankki `Kirjauspäivä` + `Summa`); the fixtures in `tests/fixtures/csv/` are synthetic and follow these names, which are not verified against a real export. The generic mapping covers any other or changed layout.
  - "Same upsert and dedupe path" is read as the sync's identity (`identifyTransactions()` occurrence numbering + `dedupeHash()` + the unique `(account_id, dedupe_hash)`), insert-only: an import never changes stored rows; the next bank sync adopts imported rows by hash.
  - "A chosen or new manual account": any non-archived account, or a new manual EUR account (checking or savings) under a `csv` institution per format.
  - Row numbers are file line numbers; a Nordea `Varaus` row is an error; a currency column that differs from the account's is an error. Imports write no `sync_runs` row.
  - `/import` is linked from the Transactions and Connections pages, not added to the main navigation.
