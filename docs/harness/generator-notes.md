- Before implementing, read the ticket the feature's `spec` field names (`docs/tickets/FIN-NNN-*.md`).
- Record a deviation from the ticket in the ticket's Notes and in `docs/DECISIONS.md`.
- Never run `pnpm db:up`, `pnpm db:down` or `docker compose …`: the Docker services are already
  running for the whole loop.
