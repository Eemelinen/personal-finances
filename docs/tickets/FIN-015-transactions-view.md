# FIN-015: Transactions view and category management

**Feature:** F-015 · **Milestone:** M2 Categorization · **Area:** categorization · **Depends on:** [F-004](FIN-004-single-user-auth.md), [F-014](FIN-014-categorization-engine.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-015`. This ticket is the spec the session reads first.

## Goal

`/transactions` lists all transactions (date, account, counterparty or description, category, signed amount, pending badge) with filters kept in the URL (date range, accounts, category, text, income or expense, transfers), pagination that works with 10k+ rows and totals for the filter; I can change a category inline (marked manual), add a note, mark or unlink a transfer and create a rule from a transaction, optionally applying it to similar past ones. `/settings/categories` manages categories and rules.

## Acceptance criteria

- One-sided transfers (to an unconnected account) can be marked manually

## Tests (what the verification proves)

- **L3** `tests/e2e/transactions.spec.ts`: filters via the URL, inline category change persists, create rule from a transaction
- **L3** `tests/e2e/categories-settings.spec.ts`: create, reorder and delete a rule

## Notes

- Replaces old FIN-015 plus the `/settings/categories` UI from old FIN-013.
