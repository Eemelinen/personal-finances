# FIN-011: Consent expiry and renewal

**Feature:** F-011 · **Milestone:** M1 Bank data · **Area:** banking · **Depends on:** [F-007](FIN-007-connect-bank-flow.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-011`. This ticket is the spec the session reads first.

## Goal

Connections store `consent_expires_at`; a warning banner appears on every page 14 days before expiry and an error banner after it; syncs skip expired connections and log the skip. Renew runs the authorisation again and attaches the new session to the existing connection and accounts (matched by IBAN, then provider account id), so history continues.

## Acceptance criteria

- Status becomes `expired` on expiry or on a `ProviderAuthError`

## Tests (what the verification proves)

- **L1** `tests/unit/connections/account-matching.test.ts`: renewed accounts match by IBAN, then provider id
- **L2** `tests/integration/consent-renewal.int.test.ts`: renewal keeps account ids and history; expired connections are skipped
- **L3** `tests/e2e/consent-banner.spec.ts`: expiring and expired banners, renew through the fake provider

## Notes

- Replaces old FIN-011.
