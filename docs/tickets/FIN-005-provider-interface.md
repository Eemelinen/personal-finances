# FIN-005: FinancialProvider interface & registry

**Milestone:** M1 Bank data · **Status:** Todo · **Depends on:** FIN-003

## Description

Define the provider abstraction that every data source implements (Enable Banking, CSV, later brokers and exchanges), so that sync and UI code never depend on a specific provider.

## Acceptance criteria

- [ ] `src/server/providers/types.ts` contains the `FinancialProvider` interface and normalized DTOs: `ProviderAccount`, `ProviderBalance`, `ProviderTransaction` (amounts in minor units plus currency)
- [ ] `src/server/providers/registry.ts` maps a `ProviderId` to its implementation
- [ ] Typed error classes: `ProviderAuthError` (consent expired or revoked), `ProviderRateLimitError`, `ProviderUnavailableError`
- [ ] A fake in-memory provider for tests
- [ ] Unit tests for the registry and the error mapping

## Notes

- See the [provider abstraction sketch](../architecture.md#provider-abstraction).
- Leave space for an optional `getHoldings()` for investment providers (FIN-023, FIN-024), but don't implement it yet.
