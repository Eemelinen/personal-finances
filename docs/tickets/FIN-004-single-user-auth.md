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
- Implemented in F-004 (D-007). Choices made without a human:
  - `AUTH_PASSWORD_HASH` is the argon2id PHC string **base64url-encoded** (what `pnpm auth:hash` prints), because the Next.js `.env` loader expands the `$` signs of a raw hash even inside quotes. A raw PHC string is accepted too.
  - Sliding expiry: the proxy re-issues the cookie once the session is a day old (not on every request); the session ends 30 days after it was last re-issued.
  - Backoff: global, in memory; after 5 consecutive failures every attempt waits 1 s, 2 s, 4 s, … (max 15 min) after the last failure. Attempts are serialised. A persistent attacker who can reach the app could keep the owner locked out; accepted because the app is bound to `127.0.0.1`, and a restart clears it.
  - Without a session, `/api/*` answers 401 instead of redirecting. After login the app opens `/` (no return-to parameter).
  - The login secrets are validated by `getAuthEnv()`, separate from `getEnv()`, so the worker runs without them.
  - The DAL check: `verifySession()` in `src/lib/auth/session.ts`, used by the header's logout button for now; future data access calls it too.
