# FIN-013: Live bank acceptance with real accounts

**Feature:** F-013 · **Milestone:** M1 Bank data · **Area:** banking · **Depends on:** [F-010](FIN-010-scheduled-sync.md), [F-011](FIN-011-consent-expiry-and-renewal.md) · **Runs:** human-only (has `manual:` steps)

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-013`. This ticket is the spec the session reads first.

## Goal

My real Nordea and S-Pankki checking and savings accounts are connected through Enable Banking restricted production mode, the scheduled sync keeps balances and transactions current, a second sync creates no duplicates and the consent expiry shown matches the bank's.

## Acceptance criteria

- Any defect found becomes a new feature (or a fix in the owning feature) instead of being patched here

## Tests (what the verification proves)

- **manual** Enable Banking production application in restricted mode with my accounts linked in the control panel; ENABLE_BANKING_* set in .env
- **manual** Nordea and S-Pankki connected via /connections; balances match the netbank
- **manual** the last 30 days of transactions match the netbank; a second Sync now inserts nothing
- **manual** findings (fetch limits, history depth, surprises) recorded in docs/tickets/FIN-013

## Notes

- Human-only: real credentials and bank authentication. The first real use of the MVP.

## Findings

_To be filled in._
