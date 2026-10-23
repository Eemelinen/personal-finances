# FIN-006: Enable Banking API client

**Milestone:** M1 Bank data · **Status:** Todo · **Depends on:** FIN-001, FIN-005

## Description

A typed client for the Enable Banking API, plus an `EnableBankingProvider` that implements `FinancialProvider`.

## Acceptance criteria

- [ ] `src/server/providers/enable-banking/client.ts` handles:
  - [ ] application JWT (RS256, `kid` = application ID, short expiry) signed with the key from `ENABLE_BANKING_PRIVATE_KEY_PATH`
  - [ ] endpoints: list ASPSPs, start authorization, create session from code, get session, account details, balances, transactions (with `continuation_key` pagination)
  - [ ] responses validated with zod
  - [ ] HTTP errors mapped to the typed provider errors from FIN-005, with retry/backoff on 429 and 5xx
- [ ] `EnableBankingProvider` maps API payloads to normalized DTOs: amount sign (credit/debit indicator), booking and value dates, counterparty name, remittance info, pending vs booked
- [ ] Env vars added: `ENABLE_BANKING_APP_ID`, `ENABLE_BANKING_PRIVATE_KEY_PATH`, `ENABLE_BANKING_REDIRECT_URL`, `ENABLE_BANKING_ENV` (`sandbox`/`production`)
- [ ] The private key is mounted read-only into the `app` and `worker` containers (`./secrets:/app/secrets:ro`)
- [ ] Unit tests with recorded sandbox fixtures (no network in tests)

## Notes

- Never log the JWT, session IDs or full IBANs.
