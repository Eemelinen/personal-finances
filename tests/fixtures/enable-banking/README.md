# Enable Banking fixtures

Recorded from the Enable Banking **sandbox** on 2026-10-24 (F-001) with
`scripts/enable-banking-spike.ts`, then anonymised by
`scripts/enable-banking-fixtures.ts`. The findings behind them are in
[FIN-001](../../../docs/tickets/FIN-001-enable-banking-access-spike.md#findings).

Each file is one exchange: `{ request: { method, path, body? }, status, body }`.
Response headers are dropped (none carried rate-limit information).

| File                                       | Exchange                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `aspsps.json`                              | `GET /aspsps?country=FI`, cut to Nordea, S-Pankki and Mock ASPSP, without payment products                            |
| `auth-start.json`                          | `POST /auth` for Nordea                                                                                               |
| `error-wrong-authorization-code.json`      | `POST /sessions` with an unknown code → 422 `WRONG_AUTHORIZATION_CODE`                                                |
| `error-account-not-found.json`             | `GET /accounts/{uid}/balances` for an unknown uid → 404 `ACCOUNT_DOES_NOT_EXIST`                                      |
| `error-wrong-transactions-period.json`     | Nordea transactions with `date_from` over 540 days back → 422 `WRONG_TRANSACTIONS_PERIOD`                             |
| `nordea/session-create.json`               | `POST /sessions`: three current accounts                                                                              |
| `nordea/session.json`                      | `GET /sessions/{id}`                                                                                                  |
| `nordea/account-details.json`              | `GET /accounts/{uid}/details` (joint account with a credit limit)                                                     |
| `nordea/account-balances.json`             | its balances (`ITAV`, `ITBD`, `VALU`)                                                                                 |
| `nordea/transactions-default.json`         | its transactions without `date_from` (the last 7 days, one page)                                                      |
| `nordea/transactions-page-1…4.json`        | the same account from `date_from` 540 days back: 40 + 40 + 40 + 20 rows, `continuation_key` chained, `null` on page 4 |
| `s-pankki/session-create.json`             | `POST /sessions`: two current accounts and a credit card without IBAN                                                 |
| `s-pankki/account-details.json`            | a current account's details                                                                                           |
| `s-pankki/account-balances.json`           | its balances (`ITBD`, `ITAV`)                                                                                         |
| `s-pankki/card-details.json`               | the card's details (`CARD`, `account_id.other` with scheme `CPAN`)                                                    |
| `s-pankki/card-balances.json`              | the card's balances (`ITAV` includes the credit limit)                                                                |
| `s-pankki/transactions-page-1.json`        | the current account's first page without `date_from` (100 rows, with a `continuation_key`)                            |
| `s-pankki/transactions-page-2.json`        | the next page, requested with that key                                                                                |
| `s-pankki/transactions-last-page.json`     | page 14, the last (3 rows, `continuation_key` `null`)                                                                 |
| `s-pankki/transactions-pending-empty.json` | `transaction_status=PDNG`: no rows but a `continuation_key`                                                           |

## Anonymisation

The sandbox data is synthetic, but the S-Pankki sandbox is shared and holds
other developers' test payments, so the builder replaces, consistently across
all files:

- every UUID (account uids, session, authorization and entry references,
  `state`) with `00000000-0000-4000-8000-NNNNNNNNNNNN`;
- every Finnish IBAN with a synthetic one with valid check digits
  (`FI..12345600000NNN`);
- `identification_hash(es)` and `psu_id_hash` with `hash-N`, and
  `continuation_key` (in bodies and request paths) with `continuation-key-N`;
- the card number and the names of account holders and private
  counterparties with made-up ones (merchant and test-company names stay).

A uid in a request path therefore still matches the session's account, and
each page's `continuation_key` matches the next page's request. To refresh the
fixtures, record again with the spike script, adjust `SOURCES` (and `NAMES`)
in the builder and run `pnpm exec tsx scripts/enable-banking-fixtures.ts`.
