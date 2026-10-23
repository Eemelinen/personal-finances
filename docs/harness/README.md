# The Personal Finances harness

Personal Finances uses the shared agent harness from
[Eemelinen/harness](https://github.com/Eemelinen/harness). It lets a coding agent work on this
repository one feature at a time without drifting, and lets a driver run those sessions
unattended, one PR per feature. This page covers what is specific to this project. How the
harness works in general — the parts, one feature end to end, every safeguard, operating and
reading the loop — is in the harness docs:
[how it works](https://github.com/Eemelinen/harness/blob/main/docs/how-it-works.md),
[configuration](https://github.com/Eemelinen/harness/blob/main/docs/config.md),
[why each part exists](https://github.com/Eemelinen/harness/blob/main/docs/why.md).
The decisions behind it are D-001, D-002 and D-004 in [../DECISIONS.md](../DECISIONS.md).

## What lives where

| Shared (pinned release)                                                                                                                                              | In this repository                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@eemelinen/harness` in `devDependencies`: the `harness` CLI behind `pnpm harness:*` (check, feature, verify, clean-state, loop, report, doctor)                     | [harness.config.json](../../harness.config.json): ticket format (`FIN-NNN`), guard rules, clean-state checks, Docker services, session-start lines, models, caps     |
| Plugin `harness@eemelinen-harness` in [.claude/settings.json](../../.claude/settings.json): skills, `harness:evaluator`, guard / session-start / format / Stop hooks | [AGENTS.md](../../AGENTS.md), [CLAUDE.md](../../CLAUDE.md), [PROGRESS.md](../../PROGRESS.md), [feature_list.json](../../feature_list.json), [init.sh](../../init.sh) |
| Generator and evaluator prompts, verdict schema                                                                                                                      | [generator-notes.md](generator-notes.md) (appended to the generator prompt), [evaluator-rubric.md](evaluator-rubric.md) with its tuning log                          |
|                                                                                                                                                                      | [clean-state-checklist.md](clean-state-checklist.md), [session-handoff.md](session-handoff.md), [quality-document.md](quality-document.md)                           |

Both pins name the same tag. `pnpm harness:doctor` (also run by `./init.sh`) fails when they
differ. To update: install the new tag
(`pnpm add -D "@eemelinen/harness@github:Eemelinen/harness#vX.Y.Z"`), set the marketplace `ref`
in `.claude/settings.json`, run `pnpm harness:doctor` and `pnpm check`, and commit as
`chore(harness): update to vX.Y.Z`. A change to the harness itself is made in the harness
repository, never here.

## Personal Finances specifics

- **Layers.**
  - L1 is `pnpm check`: lint, typecheck, format, `harness:check` and unit tests.
  - L2 (`pnpm test:integration`, Testcontainers Postgres) arrives with F-002.
  - L3 (`pnpm test:e2e`, Playwright) arrives with F-003.
  - L2 and L3 need Docker. `harness verify` refuses to run them without it, and `services.up`
    (`pnpm db:up`) runs once in the driver preflight.
- **Guard rules beyond the core.**
  - Bare `vitest`/`playwright` and `docker compose down -v` are blocked.
  - In loop sessions, `db:up/down` and `docker compose` are blocked.
  - Edits to `next-env.d.ts` and `.env*` are denied.
  - The guard asks before edits to `drizzle/` migrations and the Next.js marker block in
    AGENTS.md.
- **Clean-state checks beyond the core.**
  - no `.only`/`.skip` added under `tests/` or `src/`
  - no `console.log` added under `src/`
  - the AGENTS.md marker block is intact
- **Human-only features.** F-001, F-013 and F-023 need real bank or broker credentials and a
  network. They carry `manual:` steps, so the driver never picks them.

## Operating the loop here

**Prerequisites (once):**

- Docker Desktop running.
- `gh` logged in.
- `main` clean and in sync with `origin/main`.
- Playwright browsers installed, once F-003 adds L3 (`pnpm exec playwright install chromium`).
- On Windows, run the driver from Git Bash.
- Run `claude` in the repository once and accept the trust dialog and the plugin marketplace.

**Merging.** `merge: "auto"`: the loop opens a PR per feature and arms
`gh pr merge --auto --squash`, and GitHub merges it once the required `Verify` check passes
(branch protection on `main`, no review requirement). A red check stops the loop; push a fix to
the branch and the PR still merges.

**Commands.** Start with `pnpm harness:loop --dry-run --no-docker`, then `pnpm harness:loop --once`.
`pnpm harness:report` shows past runs.

**Cost and limits.** The caps are 200 turns / 15 USD / 60 minutes per generator session and
60 turns / 4 USD for the evaluator. Raise them only after measuring runs.

**Sequential only.** Docker Compose uses fixed container names, and once F-003 adds L3 it uses a
fixed test port. So one feature runs at a time.
