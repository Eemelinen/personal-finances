# FIN-007: "Connect bank" flow

**Milestone:** M1 Bank data · **Status:** Todo · **Depends on:** FIN-004, FIN-006

## Description

UI and server flow to link a Nordea or S-Pankki account: choose the bank, authenticate at the bank, return to the app, store the connection.

## Acceptance criteria

- [ ] `/connections` page lists existing connections (bank, status, consent expiry, last sync) and has a "Connect bank" button
- [ ] Choosing Nordea or S-Pankki starts authorization with an unguessable `state` stored server-side. The app redirects to the bank.
- [ ] Callback route `/connections/callback` validates `state`, exchanges the code for a session, and stores `connections`, `institutions` and `accounts`
- [ ] The session ID is encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY`), using a small `crypto.ts` helper with unit tests
- [ ] The user can name or rename accounts and mark them as `checking` or `savings`
- [ ] The first sync starts right after connecting (it can call the FIN-008 function directly)
- [ ] Error states shown clearly: cancelled at the bank, invalid state, API error
- [ ] A connection can be removed: revoke the session at Enable Banking, then delete it locally, or archive it while keeping history

## Notes

- Request the maximum consent validity the bank allows (from FIN-001 findings).
