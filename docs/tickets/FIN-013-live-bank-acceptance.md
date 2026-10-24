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

Recorded so far (2026-10-24, restricted production application):

- **Redirect URL.** A production application accepts only `https` redirect URLs (`http://localhost:3000/…` is refused as an unsupported scheme); `https://localhost:3000/connections/callback` was accepted. The app serves plain http, so after the bank's approval the browser shows `ERR_SSL_PROTOCOL_ERROR` and the address has to be changed to `http://` by hand to finish the callback.
- **Key file permissions.** The containers run as uid/gid 1000; a key file owned by another host user with mode `600` cannot be read through the `./secrets` mount. Group-readable by gid 1000 works.
- **Nordea connected:** consent until 22.4.2027 (180 days), a checking account (`CACC`) and a credit card (`CARD`, `Nordea Gold (credit)`, no IBAN). Balances synced for both; the checking account's 540-day backfill returned 389 transactions.
- **Nordea card history:** a `date_from` 540 days back fails with `400 ASPSP_ERROR`; any shorter range or none returns only the last ~3½ months (from 2026-07-10), although the netbank shows older purchases. Fixed in [F-025](FIN-025-nordea-card-history.md) (D-028); older card purchases need a CSV import.
