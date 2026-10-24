- Before implementing, read the ticket the feature's `spec` field names (`docs/tickets/FIN-NNN-*.md`).
- Record a deviation from the ticket in the ticket's Notes and in `docs/DECISIONS.md`.
- Never run `pnpm db:up`, `pnpm db:down` or `docker compose …`: the Docker services are already
  running for the whole loop.
- Never launch the `harness:evaluator` agent yourself, and never wait for one: the driver runs the
  evaluator in its own session after yours ends and hands its findings to the next attempt. A
  self-run review duplicates that cost and keeps the session idle.
