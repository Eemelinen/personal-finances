# FIN-001: Enable Banking access spike and sandbox fixtures

**Feature:** F-001 · **Milestone:** M0 Foundation · **Area:** banking · **Depends on:** [F-000](FIN-000-scaffold-and-harness.md) · **Runs:** human-only (has `manual:` steps)

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-001`. This ticket is the spec the session reads first.

## Goal

Enable Banking sandbox access works for Nordea FI and S-Pankki: an application whose RSA private key lives in `secrets/` (gitignored) authorises against both mock banks and fetches accounts, balances and transactions. Anonymised responses are committed under `tests/fixtures/enable-banking/`, and the facts later features depend on (consent validity, history depth, fetch limits, pending support, restricted-production terms) are recorded in this ticket's Findings.

## Acceptance criteria

- Enable Banking account and a **sandbox** application registered; RSA key pair generated, private key in `secrets/` (never committed)
- Sandbox flow works end to end for the Nordea FI and S-Pankki mock banks: authorise, list accounts, fetch balances and transactions (curl or a small script under `scripts/` is fine)
- Recorded responses for: ASPSP list, auth start, session creation, account details, balances, one transactions page with `continuation_key` and the last page, and one error response — anonymised and committed under `tests/fixtures/enable-banking/`
- Restricted production terms confirmed: linking my own accounts is free, limits (accounts, requests per day)
- Per bank: consent validity (days), transaction history depth, unattended fetches per day, pending transaction support, preferred balance type
- If Enable Banking is not viable: the alternative recorded (another aggregator, or CSV-first with F-012 pulled forward)

## Tests (what the verification proves)

- **manual** sandbox authorisation, accounts, balances and transactions fetched for Nordea FI and S-Pankki (needs the Enable Banking account and private key)
- **manual** anonymised fixtures under tests/fixtures/enable-banking/ contain no real names, IBANs, tokens or session ids
- **manual** Findings in docs/tickets/FIN-001 filled in, docs/plan.md updated if the approach changed

## Notes

- Human-only: needs an Enable Banking account and network access. The fixtures are what makes F-006 verifiable unattended.
- Research so far: [API access research](../api-access-research.md#1-banks-nordea-and-s-pankki) — restricted production is free for own accounts, consent ~180 days, ~4 unattended fetches per day per bank (unverified).
- Enable Banking authenticates applications with an RS256 JWT signed with the application's private key; the application id is the `kid`.

## Findings

_To be filled in._
