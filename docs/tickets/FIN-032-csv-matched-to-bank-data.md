# FIN-032: CSV rows matched to bank-synced transactions

**Feature:** F-032 · **Milestone:** M6 Data correctness · **Area:** banking · **Depends on:** [F-031](FIN-031-real-bank-csv-exports.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-032`. This ticket is the spec the session reads first.

## Goal

Importing a CSV into an account the bank already syncs adds only the transactions the app does not have yet. Today an import skips a row only when its hash equals a stored one, and the hash includes texts that differ between the CSV and the bank API, so an overlapping import duplicates nearly every row and doubles income and spending. The preview says how many rows are already in the app before anything is written.

## Acceptance criteria

- `transactions.source` (`bank` | `csv`, not null; migration backfills `bank` for accounts with a connection or provider ref, `csv` otherwise); the sync writes `bank`, the import `csv`
- Before inserting, the import matches each row to a stored transaction of the same account, each stored row used at most once, in this order:
  1. same `ref` (S-Pankki archive id = the bank's id);
  2. same hash (an earlier import of the same file);
  3. same amount and currency, booking date within 3 days of the stored row's booking or value date; among several, prefer the same `counterparty_iban`, then the most similar normalised counterparty/description, then the nearest day, then the oldest row
- Two equal purchases on one day match two stored rows, not one; a third in the file is new
- A matched row is a duplicate: the import never changes, books or deletes stored data
- The preview (`src/app/(app)/import/actions.ts`) runs the same matching read-only for the chosen account and shows "N already in the app, M new, K errors"; the summary counts duplicates the same way
- The matching is a pure function next to `closestPending()` in `src/server/sync/transaction-merge.ts` (or `src/server/csv/match.ts`) with the I/O in `import-csv.ts`
- Fix the header comment of `import-csv.ts` (it claims API rows hash alike); amend D-011 in `docs/DECISIONS.md`

## Tests (what the verification proves)

- **L1** `tests/unit/csv/match.test.ts`: ref match, date window against booking and value date, tie-breaks, each stored row once, equal purchases
- **L2** `tests/integration/csv-import.int.test.ts`: importing a synced account's export over its API rows inserts nothing; an export reaching further back inserts only the older rows; a Nordea row whose API booking date is one day later is matched; re-importing a file is all duplicates
- **L3** `tests/e2e/csv-import.spec.ts`: the preview shows the already-present count

## Notes

- Verified on 2026-10-24 with real data: Nordea API `booking_date` was one day after the CSV `Kirjauspäivä` for some transfers, with the API `value_date` equal to it; S-Pankki API rows have no description where the CSV fills it from `Tapahtumalaji`.
- Implemented 2026-10-24 (D-011 amendment, F-032): `src/server/csv/match.ts` (`matchCsvRows()`), the I/O in `import-csv.ts` (`importCsvRows()`, `countCsvMatches()`), the preview line in step 3 of `/import` (`countCsv` action).
- Deviation: "migration backfills `bank` … `csv` otherwise". Migration `0012_transaction_source` adds the column with default `bank`; the `csv` backfill runs in `applyMigrations()` after the migrations (idempotent), because an unattended session may not hand-write SQL into a (custom) migration file.
- Choices made without a human: text similarity is the Dice coefficient of the word sets of the normalised counterparty + description; the window counts from the CSV row's booking date only; the best-scoring pairs over the whole file are taken first (not file order); stored rows of either status and source are candidates; "oldest" is booking date, then `created_at`; `source` records the inserter, so a sync adopting an imported row leaves it `csv`; the import takes `lockCategorization()` so a concurrent sync's write is seen whole.
