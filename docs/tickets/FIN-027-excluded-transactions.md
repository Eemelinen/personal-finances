# FIN-027: Excluded transactions

**Feature:** F-027 · **Milestone:** M6 Data correctness · **Area:** categorization · **Depends on:** [F-015](FIN-015-transactions-view.md), [F-017](FIN-017-spending-and-cash-flow-reports.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-027`. This ticket is the spec the session reads first.

## Goal

The user can take a transaction out of every calculation without deleting it: a loan drawdown, a property purchase or a bank correction. Excluded transactions stay in the transaction list (marked "Excluded", filterable) but are left out of the spending and cash-flow reports, the dashboard tiles, top merchants, averages and own-transfer detection. A transaction is excluded by putting it in the top-level "Excluded" category, by hand or through a rule, so the existing rule engine and manual edits do the work.

## Acceptance criteria

- Category kind `excluded` added to the `category_kind` enum (migration by `pnpm db:generate`) and to `CategoryKind` in `src/server/categorization/defaults.ts`; a top-level "Excluded" category is seeded for new installations and created on demand for existing ones, like `createTransfersCategory()` in `src/server/categorization/categorize.ts`
- The report queries (`counted` in `flowParts()`, merchants, averages, the drill-down list, the dashboard's month cash flow) leave out kind `excluded`; balances and balance history are unchanged (the money did move)
- Transfer detection never pairs an excluded leg (it is not eligible, and an IBAN match does not override it), and rules (`ruleOutcome`) can target Excluded like any category
- Transaction details get an "Exclude from reports" action (manual category Excluded) and, on an excluded one, "Include again" (back to `none`, then the rules run on it as after `setTransactionCategory(…, null)`); the list shows an "Excluded" badge, and the filter (`src/server/queries/transaction-filter.ts`) gets "Excluded" / "Not excluded"
- The Excluded category cannot be deleted or get subcategories in `/settings/categories`, like Transfers
- Marking a transaction as salary stays the existing category picker (Income/Salary); the ticket's tests cover that a manual Income/Salary pick counts as income
- `docs/DECISIONS.md` decision entry; `README.md` mentions excluding transactions

## Tests (what the verification proves)

- **L1** `tests/unit/categorization/rules.test.ts`: a rule targeting Excluded applies like any other
- **L2** `tests/integration/categorization.int.test.ts` and `tests/integration/report-queries.int.test.ts`: an excluded credit is neither income nor other-in, an excluded debit is not spending or a merchant, an excluded leg never pairs as a transfer, "Include again" re-runs the rules
- **L3** `tests/e2e/transactions.spec.ts`: exclude a transaction from its details, see the badge and the filter, include it again

## Notes

- Found with real data on 2026-10-24: a loan drawdown (one six-figure credit) and the property purchase it paid (one six-figure debit, one five-figure debit) dominated the year's income and spending.
- A category rather than a separate flag keeps one place that says how a transaction counts, and reuses rules, manual edits, the filter and the categories page.
