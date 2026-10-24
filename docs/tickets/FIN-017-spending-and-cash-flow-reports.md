# FIN-017: Spending and cash-flow reports

**Feature:** F-017 · **Milestone:** M3 Dashboard · **Area:** dashboard · **Depends on:** [F-014](FIN-014-categorization-engine.md), [F-016](FIN-016-dashboard-overview.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-017`. This ticket is the spec the session reads first.

## Goal

`/reports/spending` shows spending per category for a chosen period (chart with amounts and %, drill-down to subcategories and to the filtered transaction list), a 12-month stacked bar per category, comparison to the previous period and the 6-month average, and the top merchants with normalised names. `/reports/cash-flow` shows monthly income vs expenses with a net line, savings rate and year-to-date totals, and the dashboard gets this month's income, expenses and net. Transfers are excluded, refunds net against their category, and months are grouped in `APP_TIMEZONE` in SQL.

## Acceptance criteria

- Period selector: this month, last month, last 3 / 6 / 12 months, custom
- Category colours from `categories.color`

## Tests (what the verification proves)

- **L1** `tests/unit/reports/merchant-name.test.ts`: merchant name normalisation
- **L2** `tests/integration/report-queries.int.test.ts`: category and monthly aggregates, transfers excluded, refunds netted, Helsinki month boundaries
- **L3** `tests/e2e/reports.spec.ts`: period switch, drill-down to transactions, cash-flow chart

## Notes

- Replaces old FIN-017, FIN-018 and the top-merchants part of FIN-020. Recurring-payment detection moved to the backlog.
- F-017 implementation (2026-10-24, D-014): read models in `src/server/queries/reports.ts` (`getSpendingReport()`, `getCashFlowReport()`, `getMonthCashFlow()`), pure period and merchant-name helpers in `src/server/reports/`, pages `src/app/(app)/reports/{spending,cash-flow}/page.tsx` (`/reports` links to both), components in `src/components/reports/`, dashboard tiles in `src/components/dashboard/month-cash-flow.tsx`. Choices made without a human: booked and pending EUR transactions count; the category kind decides spending or income (no category: debit = spending, credit = income, shown as Uncategorized); presets are whole months ending with the current one; previous period = as many months (or days for a custom range) before; 6-month average = per month over the 6 whole months before, counted from the first transaction; the 12-month chart ends with the period's last month and folds past 7 series into Other; cash flow always shows the last 12 months.
- Deviations: the drill-down's transaction list is on the spending report itself (`?category=…`), since `/transactions` is a placeholder until F-015; months are grouped by `booking_date`, which is already a local calendar day, so only "today" uses `APP_TIMEZONE` (no time-zone conversion in SQL).
