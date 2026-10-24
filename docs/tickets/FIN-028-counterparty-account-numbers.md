# FIN-028: Counterparty account numbers

**Feature:** F-028 · **Milestone:** M6 Data correctness · **Area:** banking · **Depends on:** [F-009](FIN-009-sync-transactions.md), [F-014](FIN-014-categorization-engine.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-028`. This ticket is the spec the session reads first.

## Goal

Every synced transaction keeps the other party's account number (IBAN) when the bank gives one, and own-transfer detection uses it: a payment to or from the IBAN of another own account is a transfer even when the two legs do not match by amount and date (one side not in the app, a fee, a different booking day). Existing rows get the IBAN by re-reading the history.

## Acceptance criteria

- `transactions.counterparty_iban` (text, nullable, normalised: no spaces, upper case) with a migration by `pnpm db:generate`
- `ProviderTransaction` gets `counterpartyIban`; the Enable Banking provider (`mapTransaction()` in `src/server/providers/enable-banking/provider.ts`) takes `creditor_account` for a debit and `debtor_account` for a credit (`iban`, else `other.identification` when it looks like an IBAN), and the schemas in `schemas.ts` accept those fields; when the counterparty name is empty and the description is exactly an IBAN (Nordea transfers), that IBAN is used too
- `TransactionValues`, `identifyTransactions()` and `sameValues()` (`src/server/sync/transaction-merge.ts`) carry the column, so a re-sync updates stored rows in place; `dedupeHash()` does not change (stored hashes stay valid)
- `findTransfers()` (`src/server/categorization/transfers.ts`) checks `counterpartyIban` against the own accounts' IBANs before searching the texts; everything else about pairing stays as it is
- Each connection on `/connections` gets "Re-read history": it clears `transactions_synced_at` of its accounts and starts a sync, so the next listing backfills and the merge fills the column on existing rows (no duplicates: the merge matches by ref)
- The transaction details show the counterparty account number when known
- `docs/DECISIONS.md` decision entry; module comments updated

## Tests (what the verification proves)

- **L1** `tests/unit/providers/enable-banking.test.ts`: debtor/creditor account mapping by indicator, IBAN-only description fallback, no IBAN → null
- **L1** `tests/unit/categorization/transfers.test.ts`: a leg whose `counterpartyIban` is another own account's IBAN pairs only with that account or becomes a one-sided transfer
- **L2** `tests/integration/sync-transactions.int.test.ts`: a re-read after clearing `transactions_synced_at` fills the column on stored rows without inserting any

## Notes

- Found with real data on 2026-10-24: the provider kept only the counterparty name, so of ~860 transactions only those whose description happened to be an IBAN (one Nordea account's outgoing transfers) could be recognised by account number. The Enable Banking sandbox fixtures in `tests/fixtures/enable-banking/` show where the account objects are.
- Implemented in F-028 (D-031). "Looks like an IBAN" means the IBAN shape plus valid mod-97 check digits (`parseIban()` in `src/server/iban.ts`); the same test decides whether a description is "exactly an IBAN". The `iban` field itself is taken as the bank gives it (normalised). In the recorded Nordea card rows the `debtor_account` of a debit is the own card's masked `CPAN`: the indicator rule ignores it. The L2 test also covers that the re-read asks every account for its whole history and that the changed rows go through categorisation.
