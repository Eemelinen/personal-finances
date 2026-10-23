# FIN-019: Balance & net worth history

**Milestone:** M3 Dashboard · **Status:** Todo · **Depends on:** FIN-008

## Description

Line charts of how balances and total net worth have developed over time.

## Acceptance criteria

- [ ] `/reports/balances`: net worth line chart plus a per-account (stacked area) view
- [ ] Range selector: 3 months, 6 months, 1 year, all
- [ ] Gaps filled by carrying the last known balance forward (no sync on some days)
- [ ] History before the first sync is reconstructed backwards from the oldest balance and the transactions (marked as estimated)
- [ ] Hover tooltip with the date and the per-account breakdown
