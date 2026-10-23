# FIN-005: Provider contract, fake provider and token encryption

**Feature:** F-005 · **Milestone:** M1 Bank data · **Area:** banking · **Depends on:** [F-002](FIN-002-database-schema.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-005`. This ticket is the spec the session reads first.

## Goal

`src/server/providers` defines the `FinancialProvider` interface with normalised account, balance and transaction DTOs (minor units plus currency), a registry by provider id, typed errors (auth expired, rate limited, unavailable) and a deterministic in-memory fake provider used by tests and the e2e environment. `src/server/crypto.ts` encrypts and decrypts stored session ids with AES-256-GCM using `ENCRYPTION_KEY`.

## Acceptance criteria

- `types.ts`: `FinancialProvider`, `ProviderAccount`, `ProviderBalance`, `ProviderTransaction`; room for an optional `getHoldings()` (F-019)
- `registry.ts` maps `ProviderId` → implementation; selecting the fake provider is a config switch (e.g. `BANK_PROVIDER=fake`) used only by tests
- `ProviderAuthError`, `ProviderRateLimitError`, `ProviderUnavailableError`
- `crypto.ts` with versioned ciphertext format; `ENCRYPTION_KEY` added to the env schema and `.env.example`

## Tests (what the verification proves)

- **L1** `tests/unit/providers/registry.test.ts`: registry lookup, typed error mapping, fake provider determinism
- **L1** `tests/unit/server/crypto.test.ts`: round trip, tampered ciphertext and wrong key rejected

## Notes

- Replaces old FIN-005 plus the encryption helper from old FIN-007. Plain Node only: the worker imports it.
- Choices made without a human (D-008): ranges are inclusive `YYYY-MM-DD` strings, not the architecture sketch's `Date`s; providers get the decrypted session id (`ProviderConnection`); `ENCRYPTION_KEY` (32 bytes, base64) has its own schema `getEncryptionEnv()` in `src/server/env.ts` instead of joining the main one, so the migrate job runs without it; the fake is registered only when `BANK_PROVIDER=fake`; its failure modes are special session refs (`fake:expired`, `fake:rate-limited`, `fake:unavailable`); ciphertext format `v1:<iv>:<ciphertext>:<tag>` (base64url). Compose does not pass `ENCRYPTION_KEY` yet (F-007, the first runtime user).
