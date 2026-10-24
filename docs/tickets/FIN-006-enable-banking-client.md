# FIN-006: Enable Banking client and provider

**Feature:** F-006 · **Milestone:** M1 Bank data · **Area:** banking · **Depends on:** [F-001](FIN-001-enable-banking-access-spike.md), [F-005](FIN-005-provider-contract.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-006`. This ticket is the spec the session reads first.

## Goal

`EnableBankingProvider` implements `FinancialProvider` over a typed Enable Banking client: RS256 application JWT, authorisation start, session creation, account details, balances and paginated transactions, zod-validated responses, retries on 429 and 5xx, and mapping to normalised DTOs (amount sign, booking and value date, counterparty, remittance info, pending vs booked). Tests run only against the fixtures recorded in F-001; no network.

## Acceptance criteria

- `src/server/providers/enable-banking/client.ts` and `provider.ts`
- Env: `ENABLE_BANKING_APP_ID`, `ENABLE_BANKING_PRIVATE_KEY_PATH`, `ENABLE_BANKING_REDIRECT_URL`, `ENABLE_BANKING_ENV` (`sandbox` / `production`)
- Private key mounted read-only into `app` and `worker` (`./secrets:/app/secrets:ro`)
- Never logs the JWT, session ids or full IBANs

## Tests (what the verification proves)

- **L1** `tests/unit/providers/enable-banking.test.ts`: JWT claims, continuation_key pagination, error mapping and DTO mapping against recorded fixtures

## Notes

- Replaces old FIN-006. JWT signing with `jose`.
- Implemented in session 022 (unattended, D-023). Choices made without a human: Enable Banking is always registered and reads `ENABLE_BANKING_*` and the key on first use (all four variables optional; `ENABLE_BANKING_ENV` defaults to `sandbox` and changes nothing but `environment()`, the API URL is the same); a first sync asks Nordea from today − 540 days and S-Pankki (or any bank not in `HISTORY_DAYS_BY_ASPSP`) without `date_from`, an older `from` is clamped for Nordea and otherwise retried once from the 422's `detail.date_from`; the bank comes from `GET /sessions/{id}`, cached per session and process; three attempts for 429/408/5xx/network failures (1 s, 2 s or `Retry-After` up to 30 s), no repeat of `POST /sessions` after a 5xx; `PDNG`/`HOLD` → pending, `CNCL`/`RJCT`/`SCHD`/`OTHR` dropped; account names are nickname or product plus the last four characters of the IBAN or card number; cards are `checking`. Also applied FIN-001's recommendation to prefer `ITBD` for Nordea and S-Pankki in `balance-types.ts`.
- The fixtures have no `GET /sessions/{id}` for S-Pankki and details only for one account per bank; the tests build those exchanges from the recorded `POST /sessions` bodies (same account objects). Session error names (`EXPIRED_SESSION`, …) come from the API reference, not from a recording; F-013 should confirm them.
