# FIN-017: Spending by category

**Milestone:** M3 Dashboard · **Status:** Todo · **Depends on:** FIN-013, FIN-014

## Description

Answer "what am I spending money on?" with graphs.

## Acceptance criteria

- [ ] `/reports/spending` with a period selector: this month, last month, last 3, 6 or 12 months, custom
- [ ] Donut or bar chart of spending per top-level category for the period, with amounts and %
- [ ] Stacked monthly bar chart of spending per category over the last 12 months
- [ ] Clicking a category drills down to its subcategories, then to the filtered transactions list (FIN-015)
- [ ] Comparison to the previous period and to the 6-month average per category
- [ ] Transfers excluded; refunds net against their category
- [ ] Recharts set up with a consistent category color palette (colors from `categories.color`)
- [ ] Monthly aggregation in `APP_TIMEZONE`, done in SQL rather than in JS
