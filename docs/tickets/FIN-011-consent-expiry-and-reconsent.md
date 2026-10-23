# FIN-011: Consent expiry tracking & re-consent

**Milestone:** M1 Bank data · **Status:** Todo · **Depends on:** FIN-007

## Description

PSD2 consents expire (typically after 90–180 days) and can be revoked at the bank. The app must make this visible and make renewing easy, without losing history.

## Acceptance criteria

- [ ] `connections.consent_expires_at` stored when connecting. Status becomes `expired` on expiry or on a `ProviderAuthError`.
- [ ] Warning banner on all pages when a consent expires within 14 days, and an error banner once it has expired
- [ ] "Renew" runs the authorization flow again for the same institution. The new session is attached to the **existing** connection and accounts, matched by IBAN or provider account ID, so history continues.
- [ ] Syncs skip expired connections and log the skip
- [ ] Tests for matching accounts after re-consent
