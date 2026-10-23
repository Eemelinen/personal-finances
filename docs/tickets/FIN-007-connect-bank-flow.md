# FIN-007: Connect-bank flow

**Feature:** F-007 · **Milestone:** M1 Bank data · **Area:** banking · **Depends on:** [F-004](FIN-004-single-user-auth.md), [F-006](FIN-006-enable-banking-client.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-007`. This ticket is the spec the session reads first.

## Goal

`/connections` lists connections (bank, status, consent expiry, last sync) and connects Nordea or S-Pankki: the app redirects to the bank with a server-stored state, `/connections/callback` validates the state, creates the session and stores the encrypted session id, institution and accounts, and I can name accounts and mark them checking or savings. A cancelled or invalid callback shows an error; a connection can be removed (revoked at the provider) or archived with its history.

## Acceptance criteria

- Unguessable `state` stored server-side and single-use
- Request the maximum consent validity per bank (F-001 findings)
- Error states: cancelled at the bank, invalid state, provider error
- Remove = revoke at Enable Banking, then delete; archive keeps history

## Tests (what the verification proves)

- **L2** `tests/integration/connections.int.test.ts`: callback stores connection and accounts, rejects a bad state, revoke and archive
- **L3** `tests/e2e/connect-bank.spec.ts`: connect through the fake provider, rename an account, cancelled flow shows an error

## Notes

- Replaces old FIN-007. Real banks are checked in F-013; here the e2e environment uses the fake provider.
- The first sync after connecting is triggered by F-010.
