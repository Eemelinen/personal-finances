# FIN-004: Single-user authentication

**Milestone:** M0 Foundation · **Status:** Todo · **Depends on:** FIN-002

## Description

Protect the whole app with a simple single-user login. Financial data must not be readable by anyone else who can reach the port, even locally.

## Acceptance criteria

- [ ] `/login` page with a password field. The password is checked against `AUTH_PASSWORD_HASH` (argon2) from the environment.
- [ ] Encrypted session cookie (iron-session, `SESSION_SECRET`), `httpOnly`, `sameSite=lax`, with a 30-day sliding expiry
- [ ] Every page and route handler except `/login` and `/api/health` requires a session. `proxy.ts` does an optimistic redirect and the data access layer checks the session again.
- [ ] Logout action
- [ ] Basic login rate limiting (for example, an in-memory backoff after 5 failed attempts)
- [ ] A small script `npm run auth:hash` prints a hash for a given password
- [ ] `.env.example` and the env schema are updated

## Notes

- Follow `node_modules/next/dist/docs/01-app/02-guides/authentication-with-cache-components.md`. With Cache Components enabled, session reads must sit behind `<Suspense>`.
- In Next 16, Middleware is called **Proxy** (`src/proxy.ts`).
