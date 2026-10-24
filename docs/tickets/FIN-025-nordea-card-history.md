# FIN-025: Nordea card transactions without a 540-day date_from

**Feature:** F-025 · **Milestone:** M1 Bank data · **Area:** banking · **Depends on:** [F-006](FIN-006-enable-banking-client.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-025`. This ticket is the spec the session reads first.

## Goal

A Nordea credit card connected through Enable Banking (`cash_account_type` `CARD`) syncs its transactions: its first sync asks without `date_from` and gets everything the card serves, instead of failing every sync with `400 ASPSP_ERROR` because it was asked for Nordea's 540 days. Checking and savings accounts keep the 540-day backfill.

## Acceptance criteria

- The per-bank history limit (`HISTORY_DAYS_BY_ASPSP`) applies to every account but cards; a card's `from` is passed on as it is, and a first sync sends no `date_from`
- Whether an account is a card comes from its details (`cash_account_type`), remembered from `listAccounts()` and looked up once per account and process otherwise
- A generic `ASPSP_ERROR` is still not retried with another range: on a checking account that would quietly shrink a first backfill to Nordea's default 7 days

## Tests (what the verification proves)

- **L1** `tests/unit/providers/enable-banking.test.ts`: a Nordea card account is asked without `date_from` on a first sync and with its own `from` afterwards; checking accounts still from 540 days back

## Notes

- Found in [F-013](FIN-013-live-bank-acceptance.md) on 2026-10-24 with a real Nordea Gold card (`cash_account_type` `CARD`, `CPAN` card number, no IBAN), in the same session as a `CACC` checking account:
  - `date_from` 540 days back: `400 ASPSP_ERROR` "Error interacting with ASPSP", not the `422 WRONG_TRANSACTIONS_PERIOD` checking accounts give, so the existing retry never ran and every sync failed again (the card had no synced transactions, so each sync was a first sync).
  - No `date_from`, or 90, 180 or 365 days back: `200`, the same rows from 2026-07-10 on (pages of 10). 1 April – 9 July: no rows, although the netbank shows purchases then. The card serves about 3½ months; older purchases can only come from a CSV import.
- The S-Pankki card was already asked without `date_from` (S-Pankki has no entry in the history table). Nordea First Card is its own ASPSP (`Nordea First Card FI`) without an entry, so it is unaffected too.
