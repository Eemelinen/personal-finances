# FIN-029: Own accounts outside the bank connections

**Feature:** F-029 · **Milestone:** M6 Data correctness · **Area:** banking · **Depends on:** [F-028](FIN-028-counterparty-account-numbers.md), [F-015](FIN-015-transactions-view.md), [F-018](FIN-018-balance-history.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-029`. This ticket is the spec the session reads first.

## Goal

The user can add their own accounts that no bank connection shows (a savings or fixed-term account the consent does not cover, an account at another bank) by name and IBAN, optionally with a balance. Money moved between such an account and a connected one is then an own transfer, not income or spending, and the account's balance counts in net worth.

## Acceptance criteria

- Settings → "Accounts" (linked from `/settings` and `/connections`) lists the manual accounts (no connection) with name, institution, IBAN, type and latest balance; the user can add one (name, institution name, IBAN, type `checking` or `savings`, EUR), edit name, IBAN and type of any manual account (including those created by a CSV import), and archive it
- The IBAN is validated (country code + check digits, mod-97) and normalised; an IBAN already used by another account is refused with a message
- Optional "Balance on date": stores one `balance_snapshots` row (balance type `manual`) for that account and day; balance history and net worth (D-013, D-015) include it like any snapshot, and the `manual` type is handled in `src/server/sync/balance-types.ts`
- Saving an account or its IBAN re-runs categorisation over all transactions (`reapplyRules()`), so legs whose `counterparty_iban` or texts name that IBAN become one-sided transfers (the existing `oneSided` path in `findTransfers()`); the page reports how many were linked
- Reuse `createManualAccount()` (`src/server/csv/import-csv.ts`) and the IBAN normalising in `src/server/connections/account-matching.ts`; manual accounts get an institution row per user-given name under provider `manual`
- `README.md` and `docs/DECISIONS.md` updated

## Tests (what the verification proves)

- **L1** `tests/unit/connections/account-input.test.ts`: IBAN validation and normalising, required fields
- **L2** `tests/integration/manual-accounts.int.test.ts`: adding an account with an IBAN turns a stored leg naming it into a one-sided transfer that the cash-flow report leaves out; a manual balance appears in net worth; a duplicate IBAN is refused
- **L3** `tests/e2e/manual-accounts.spec.ts`: add an account with a balance, see it on the dashboard's account list

## Notes

- Found with real data on 2026-10-24: about a hundred transfers between a connected checking account and the user's own savings accounts (not in the bank consent) were counted as income and spending. One savings account was known only from a netbank CSV export.
