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
