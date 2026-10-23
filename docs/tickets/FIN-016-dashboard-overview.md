# FIN-016: Dashboard overview (net worth, balances)

**Milestone:** M3 Dashboard · **Status:** Todo · **Depends on:** FIN-008

## Description

The landing page after login: how much money do I have right now, and where is it.

## Acceptance criteria

- [ ] KPI tiles: total net worth, total in checking, total in savings, change vs 30 days ago
- [ ] Account list grouped by bank: name, type, current balance, last synced
- [ ] Small sparkline of the last 90 days per account (from `balance_snapshots`)
- [ ] Connection status indicator (OK, expiring, expired) linking to `/connections`
- [ ] Empty state guiding to "Connect bank" or "Import CSV"
- [ ] App shell: navigation (Dashboard, Transactions, Reports, Connections, Settings) and a header with the last sync time
- [ ] Read queries live in `src/server/queries/`
- [ ] Amounts formatted `fi-FI` with EUR (e.g. `1 234,56 €`)
