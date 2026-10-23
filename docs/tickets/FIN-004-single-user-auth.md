# FIN-004: Single-user authentication

**Feature:** F-004 · **Milestone:** M0 Foundation · **Area:** foundation · **Depends on:** [F-003](FIN-003-app-shell-and-e2e-layer.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-004`. This ticket is the spec the session reads first.

## Goal

Every page and route except `/login` and `/api/health` requires a session. `/login` accepts the password whose argon2 hash is in `AUTH_PASSWORD_HASH` and sets an encrypted, httpOnly session cookie (iron-session, 30-day sliding expiry); logout clears it; repeated wrong passwords are slowed down. `pnpm auth:hash` prints a hash for a password.

## Acceptance criteria

- `/login` page; argon2 check against `AUTH_PASSWORD_HASH`
- iron-session cookie (`SESSION_SECRET`), `httpOnly`, `sameSite=lax`, 30-day sliding expiry
- `src/proxy.ts` (Next 16 name for middleware) redirects optimistically; the data access layer checks the session again
- Logout action; in-memory backoff after 5 failed attempts
- `pnpm auth:hash` script; `.env.example` and the env schema updated; test-only credentials in committed test config, never real ones

## Tests (what the verification proves)

- **L1** `tests/unit/auth/session.test.ts`: password check, session sealing and expiry, login backoff
- **L3** `tests/e2e/auth.spec.ts`: logged-out redirect to /login, login, logout, wrong password rejected

## Notes

- Replaces old FIN-004. Follow `node_modules/next/dist/docs/01-app/02-guides/authentication-with-cache-components.md`.
