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

Recorded on 2026-10-24 against the sandbox application `personal-finances-sandbox` (environment `SANDBOX`, redirect `http://localhost:3000/connections/callback`), key in `secrets/enable-banking.pem`. Enable Banking is viable; the plan is unchanged.

**How it was done.** `scripts/enable-banking-spike.ts` (`aspsps`, `auth "<bank>"`, `session <code>`, `fetch <session id> [date_from]`, `get <name> <path>`, `error`) signs the application JWT with `node:crypto` (RS256, `kid` = application id, `iss` `enablebanking.com`, `aud` `api.enablebanking.com`, one hour) and writes every raw response to `secrets/enable-banking-raw/` (gitignored). `scripts/enable-banking-fixtures.ts` builds the anonymised fixtures from them ([tests/fixtures/enable-banking/README.md](../../tests/fixtures/enable-banking/README.md)) and fails if an original id, IBAN, card number, hash, continuation key or listed name survives. Both banks were authorised in a browser; the bank redirected to the callback URL with `state` and `code`, and `POST /sessions` with the code created the session. Both banks share one base URL, `https://api.enablebanking.com`; the application decides the environment.

**Per bank (sandbox).**

|                                  | Nordea (`Nordea`, BIC NDEAFIHH)                                                                                                                                                                             | S-Pankki (`S-Pankki`, BIC SBANFIHH)                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Consent validity                 | `maximum_consent_validity` 15 552 000 s = 180 days; the session's `access.valid_until` is what was asked for                                                                                                | same, 180 days                                                                                                                           |
| Auth method                      | `MTA` "Nordea website", redirect; personal only                                                                                                                                                             | redirect, personal and business; sandbox user `customera` / `12345678` (listed in `/aspsps`)                                             |
| Accounts                         | 3 `CACC` (product `KÄYTTÖTILI`), IBAN; one joint (`name` "A;B"), one with `credit_limit`                                                                                                                    | 2 `CACC` (`S-Tili AO`) with IBAN + 1 `CARD` (`S-Etukortti Visa Credit`) with **no IBAN**, only `account_id.other` (`scheme_name` `CPAN`) |
| Balance types                    | `ITAV`, `ITBD`, `VALU`; `reference_date` null                                                                                                                                                               | `ITBD`, `ITAV` with `reference_date`; the card's `ITAV` includes the credit limit (3 061.21 vs `ITBD` 61.21)                             |
| Transactions without `date_from` | only the last 7 days                                                                                                                                                                                        | the whole history (sandbox: back to 2019, 1 300 rows)                                                                                    |
| History depth with `date_from`   | **540 days**: an older `date_from` is a 422 `WRONG_TRANSACTIONS_PERIOD` whose `detail.date_from` is the earliest allowed day                                                                                | a `date_from` 2 years back was accepted (no limit hit)                                                                                   |
| Page size                        | 40, `continuation_key` until the last page (`null`)                                                                                                                                                         | 100, same                                                                                                                                |
| Pending                          | none in the sandbox (`status` always `BOOK`; `transaction_status=PDNG` returns nothing)                                                                                                                     | same; the `PDNG` query returned an **empty page with a `continuation_key`**                                                              |
| Ids                              | `entry_reference` on every row, `transaction_id` null                                                                                                                                                       | same                                                                                                                                     |
| Texts                            | `bank_transaction_code.description` in Finnish (`Korttiosto`, `Oma siirto`, …), no ISO codes; reference number in `reference_number` and as the first `remittance_information` line; `transaction_date` set | ISO `code`/`sub_code` (`ICDT/ESCT`, `CCRD/POSD`, `RCDT/SALA`), no description; `transaction_date` null                                   |
| Rate-limit headers               | none on any response                                                                                                                                                                                        | none                                                                                                                                     |

**Facts for later features.**

- F-006: page until `continuation_key` is null, and keep paging after an empty page that still has a key. A missing `from` cannot simply be omitted (Nordea then gives 7 days): request `date_from` = today − 540 days for Nordea, or retry once with the 422's `detail.date_from`. Map `entry_reference` to the provider transaction ref. Amounts are positive strings with `credit_debit_indicator` `CRDT`/`DBIT`. `GET /sessions/{id}` lists account uids in a different order from `POST /sessions`; match by uid. Errors are JSON `{code, message, error, detail}`: 404 `ACCOUNT_DOES_NOT_EXIST`, 422 `WRONG_AUTHORIZATION_CODE`, 422 `WRONG_TRANSACTIONS_PERIOD`.
- F-006/F-008: the app's default preference shows `ITAV` first. For the card that is the credit left, not the balance, and for Nordea `ITAV` ≠ `ITBD` on a normal day. Recommended: prefer `ITBD` for both banks (per-bank override in `balance-types.ts`), to be checked against the netbank in F-013.
- F-007/F-011: accounts may have no IBAN (cards), so renewal's IBAN match needs the uid / `other` identification fallback that FIN-011 already names; `identification_hash` is stable per account and could be the fallback key.
- F-010: unattended fetches stay at PSD2's four a day per consent (RTS art. 36(5)(b)); the default 6-hour `SYNC_CRON` is exactly four. The sandbox does not enforce or report it, so F-013 checks it with real accounts.
- Restricted production (from the docs, F-013 confirms in practice): register a **production** application, then "Activate by linking accounts" and authorise your own accounts; it is then active in restricted mode and only returns the linked accounts. The docs describe this as meant for evaluation and "individual non-commercial use" until an agreement is signed, publish no numeric limits, and ask for no payment details; full activation (contract, KYC, billing) is not needed. Production registration also asks for a description, a data-protection email, a privacy policy URL and a terms URL.
- Real exports (D-011): the sandbox texts are synthetic, so comparing them with the CSV layouts in `bank-csv.ts` stays for F-013.
