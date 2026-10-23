# FIN-023: Live investments acceptance

**Feature:** F-023 · **Milestone:** M4 Investments · **Area:** investments · **Depends on:** [F-022](FIN-022-net-worth-with-investments.md) · **Runs:** human-only (has `manual:` steps)

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-023`. This ticket is the spec the session reads first.

## Goal

A real Nordnet export imports with holdings matching Nordnet, a read-only, IP-restricted Kraken key syncs balances matching Kraken, and the price APIs (with my keys) value both in net worth.

## Acceptance criteria

- Defects found become new features instead of being patched here

## Tests (what the verification proves)

- **manual** a real Nordnet transaction export imports; holdings and quantities match Nordnet
- **manual** a read-only, IP-whitelisted Kraken key syncs; balances match Kraken
- **manual** price API keys set in .env; holdings are valued and appear in net worth
- **manual** findings recorded in docs/tickets/FIN-023

## Notes

- Human-only: real exports, API keys and network access.

## Findings

_To be filled in._
