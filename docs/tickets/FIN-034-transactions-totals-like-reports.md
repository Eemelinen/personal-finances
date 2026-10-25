# FIN-034: Transactions totals count like the reports

**Feature:** F-034 · **Milestone:** M6 Data correctness · **Area:** reports · **Depends on:** [F-026](FIN-026-income-from-income-categories.md), [F-027](FIN-027-excluded-transactions.md), [F-030](FIN-030-own-names-and-household.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-034`. This ticket is the spec the session reads first.

## Goal

The Income, Expenses and Net figures above the `/transactions` list mean the same as on the cash-flow report and the dashboard. Today they sum every filtered row by the sign of its amount, so own transfers, excluded transactions and household rows all count, and the figures are several times the real income and spending. After this feature the totals apply the report rules to the filtered rows, and a "Not counted" line shows what the reports leave out, so nothing disappears unseen. The list itself and its filters do not change.

## Acceptance criteria

- `listTransactions()` (`src/server/queries/transactions.ts`) computes the totals over the filtered rows with the report rules, by reusing `flowParts()` from `src/server/queries/reports.ts` (export it, or move it to a module both import; do not copy the SQL): only `REPORT_CURRENCY` rows count; own transfers (`transfer_group_id` or category kind `transfer`), Excluded rows (kind `excluded`) and, while `ignoreHouseholdTransfers` is on, `household` rows do not count; a credit in an expense category nets against expenses as a refund; a credit without a category (or in Uncategorized) is income while `uncategorizedCreditsAsIncome` is on and "Other money in" while it is off. Both settings come from `getAppSettings()` (`src/server/settings.ts`)
- `TransactionPage` returns income, expenses, other money in and net for the counted rows (net = income + expenses, as in the cash-flow report; other money in is not in net), and for the rows not counted their count and the sums of their credits and debits; the per-currency totals by sign are no longer shown
- The `transaction-totals` block in `src/app/(app)/transactions/page.tsx` shows Income, Expenses, Net and, when not zero, Other money in; under it a line "Not counted: N transactions (+x / −y)" naming the reasons present (own transfers, excluded, household, other currencies) and linking to the same filter with `transfers=only`, `excluded=only` or `household=only` when one reason covers them all, or explaining the reasons when they are mixed
- For any date range, the totals of `/transactions` with that range and no other filter equal `getCashFlowReport()`'s income, expenses and other money in for the same days
- The `type` filter (`income` / `expense`) keeps going by the sign of the amount; its labels say "Money in" / "Money out" so they are not read as the report's income and expenses
- The comment at the top of `transactions.ts` and the totals note in FIN-027 are updated; `docs/DECISIONS.md` gets an entry that amends D-030's "`/transactions` totals still sum the filtered rows by sign"; `README.md` says what the totals count

## Tests (what the verification proves)

- **L2** `tests/integration/transactions-view.int.test.ts`: with a transfer pair, a one-sided own transfer, an excluded debit, a household credit (toggle on and off), a refund in an expense category, a non-EUR row and an uncategorised credit (setting on and off), the totals equal `getCashFlowReport()` for the same range, and "Not counted" holds exactly the rest with the right count and sums
- **L3** `tests/e2e/transactions.spec.ts`: adding an own transfer pair leaves Income and Expenses unchanged and raises "Not counted"; its link opens the list filtered to transfers

## Notes

- Found with real data on 2026-10-25: for 2026 the page showed about €143k in and €140k out against about €30k of salary, while the reports showed €99k / €73k; own transfers alone added €42k in and €63k out to the page. This was open as PROGRESS.md Next Steps item 9 since F-015 and F-017.
- Out of scope: `category=none` vs the reports' `category=uncategorized`, and linking report rows to `/transactions` (the rest of that Next Steps item).
