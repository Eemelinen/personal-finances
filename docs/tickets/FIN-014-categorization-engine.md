# FIN-014: Categorization engine and own-transfer detection

**Feature:** F-014 · **Milestone:** M2 Categorization · **Area:** categorization · **Depends on:** [F-009](FIN-009-sync-transactions.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-014`. This ticket is the spec the session reads first.

## Goal

Seeded two-level default categories and rules for common Finnish merchants categorise new transactions after every sync and import; rules match counterparty or description (contains, equals, regex) and optionally amount sign or range, applied by priority, first match wins; manual categories are never overwritten; re-apply rules recategorises all non-manual transactions. A debit and a credit of the same absolute amount between my own accounts within ±3 days (or to an own IBAN) are linked as a transfer pair with the Transfers category and excluded from spending and income.

## Acceptance criteria

- Default categories: Housing, Groceries, Restaurants & cafés, Transport, Shopping, Health, Subscriptions, Travel, Entertainment, Income, Savings & investments, Transfers, Uncategorized (with subcategories)
- Seeded rules: S-Market, Prisma, K-Market, Lidl, Alepa, HSL, VR, Wolt, Foodora, …
- `category_source`: `rule`, `manual` or `none`; transfer pairs share a `transfer_group_id`

## Tests (what the verification proves)

- **L1** `tests/unit/categorization/rules.test.ts`: match types, priority, manual always wins
- **L1** `tests/unit/categorization/transfers.test.ts`: same day, cross-bank delay, equal amounts that are not transfers
- **L2** `tests/integration/categorization.int.test.ts`: seeds load, the sync hook categorises, re-apply keeps manual categories

## Notes

- Replaces old FIN-013 (engine part) and FIN-014. The management UI is F-015.
