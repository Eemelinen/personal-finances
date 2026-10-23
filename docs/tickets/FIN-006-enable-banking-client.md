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
