# FIN-033: History survives connection removal and reconnects

**Feature:** F-033 · **Milestone:** M6 Data correctness · **Area:** banking · **Depends on:** [F-032](FIN-032-csv-matched-to-bank-data.md), [F-011](FIN-011-consent-expiry-and-renewal.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-033`. This ticket is the spec the session reads first.

## Goal

Imported history is never lost by managing bank connections, and connecting a bank again never counts its accounts twice. Today "Remove" deletes the connection's accounts with every transaction, CSV-imported ones included, and connecting a bank anew (instead of Renew) creates new accounts beside the archived ones, whose overlapping history both count in the reports.

## Acceptance criteria

- `removeConnection()` (`src/server/connections/manage.ts`): accounts that hold `source = csv` transactions are kept as manual accounts (connection and provider ref cleared) with only those rows; their `bank` rows, balances and the other accounts are deleted as today
- The Remove confirmation on `/connections` states what goes and what stays (accounts, bank transactions, imported transactions) from a read-only count
- Connecting a bank anew (`src/server/connections/authorization.ts`, `sync-balances.ts`) attaches an incoming account to an existing archived or manual account with the same IBAN (`matchRenewedAccounts()` in `account-matching.ts`) instead of creating a second one; it is un-archived and its history kept, and the bank's sync then matches its rows (F-032's matching for rows without the bank's ref)
- `docs/DECISIONS.md` decision entry; `docs/operations.md` explains what Remove, Archive and Renew keep

## Tests (what the verification proves)

- **L2** `tests/integration/connections.int.test.ts`: remove keeps an account with imported rows as manual and deletes its bank rows; connecting anew reuses an archived account with the same IBAN without duplicating its transactions
- **L3** `tests/e2e/connect-bank.spec.ts`: the Remove confirmation lists what stays

## Notes

- Found on 2026-10-24: after the database was reset by hand, no imported history survived and nightly backups were off; F-024's backups need `BACKUP_AGE_RECIPIENTS`. This feature removes the in-app ways to lose imported data.
- Implemented 2026-10-24 (D-034). The sync's matching of imported rows (`mergeTransactions()` → `matchCsvRows()`) did not exist before (a sync adopted imported rows only by ref or hash), so it was added; it runs on every sync, not only after an account is taken over. Takeover candidates are manual accounts (archived or not) and accounts of archived connections; accounts of an expired or revoked connection are not taken (renew those). Accounts without an IBAN are not matched.
