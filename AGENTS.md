# Personal Finances — agent operating manual

Personal Finances is a single-user, self-hosted dashboard: it syncs balances and transactions
from Nordea and S-Pankki through Enable Banking (PSD2, read-only), categorises spending, draws
reports, and will add Nordnet and Kraken holdings later. Stack: Next.js 16 + React 19,
TypeScript, PostgreSQL 18 with Drizzle, a node-cron worker, Docker Compose, pnpm. Code, docs and
commits are English; amounts are EUR and shown `fi-FI`. Product: [docs/plan.md](docs/plan.md).

This file is a router, not a manual: it defines the session loop and the invariants and
links to the detail. The repository, not the chat, is the system of record.

## Clock-in (session start)

Before touching code:

1. `pwd` — confirm you are in the repository root.
2. Read [PROGRESS.md](PROGRESS.md) — Current Verified State and Next Steps.
3. `pnpm harness:feature next --include-manual` — the highest-priority `not_started` feature whose `depends_on` are all `passing` ([feature_list.json](feature_list.json)). `pnpm harness:feature show F-NNN` prints it with its ticket (`spec`); read the ticket before coding.
4. `git log --oneline -5` — what changed most recently.
5. `./init.sh` — installs, checks tooling and runs the L1 baseline (`FAST=1` skips it).
6. If the baseline is red, fix that first. Never stack feature work on a broken start.
7. `pnpm harness:feature activate F-NNN` (WIP=1, dependency check) and work only on it.

Claude Code: `/harness:clock-in` runs these steps; the SessionStart hook prints the state summary.

## Verification layers

| Layer | Command                 | Covers                                                    | Needs                        |
| ----- | ----------------------- | --------------------------------------------------------- | ---------------------------- |
| L1    | `pnpm check`            | lint, typecheck, format:check, unit tests (incl. harness) | nothing                      |
| L2    | `pnpm test:integration` | DB schema, migrations, sync, queries (Testcontainers)     | Docker Desktop               |
| L3    | `pnpm test:e2e`         | Playwright (Chromium) against the built app (own test DB) | Docker + Playwright Chromium |

- Layers run in order. Do not proceed to layer N+1 while layer N fails, and do not skip a layer a feature lists.
- L3 is required when a change crosses component boundaries (UI + server/DB/worker).
- The repository is in a consistent state when `pnpm check` exits 0. `pnpm check:full` adds L2 and L3 (which builds the app).
- The feature that introduces L2 or L3 also updates this table, `check:full`, `init.sh`, the session-start hook and the CI `Verify` job.
- `pnpm harness:check` validates `feature_list.json`; it also runs from `pnpm check` and lint-staged.
- `pnpm harness:verify F-NNN` runs a feature's layers in order and records evidence; `manual:` steps fail closed. `pnpm harness:clean-state` is the machine-checkable clock-out gate.
- Focused test commands name the file without `--`: `pnpm test:unit tests/unit/x.test.ts`.

## Constraints

Each rule carries a `why:` so it can be revisited when the reason disappears.

- MUST use `pnpm` (never npm/yarn/npx). why: lockfile + `packageManager` pin; the harness scripts and hooks call pnpm. source: package.json, docs/DECISIONS.md D-003.
- MUST run tests only through `pnpm test:*`, never bare `vitest`/`playwright`. why: the scripts select the right Vitest project and test config. source: package.json, vitest.config.mts.
- MUST read configuration via `getEnv()` from `src/server/env.ts`, never `process.env` in `src/`; new variables go into its zod schema and `.env.example`. why: validated once, fails fast. source: docs/architecture.md → Conventions.
- MUST keep `src/server/**` runnable in plain Node: no `next/*`, `server-only` or React imports there. why: the worker imports it outside Next.js. source: docs/architecture.md → Conventions.
- MUST change the schema only in `src/server/db/schema/` and generate migrations with `pnpm db:generate`; never hand-edit `drizzle/**` or `next-env.d.ts`. why: generated files are overwritten; the migration history is the only source of schema. source: drizzle.config.ts.
- MUST store money as integer minor units plus an ISO-4217 currency, never floats. why: rounding errors in sums and reports. source: docs/architecture.md → Data model.
- MUST keep bank and exchange integrations read-only: no payment initiation, no trading or withdrawal permissions. why: the app only observes money. source: docs/plan.md → Scope.
- MUST NOT commit real bank or broker exports, real account data, credentials, tokens or private keys; fixtures are synthetic or anonymised, keys live in `secrets/` (gitignored). why: financial data and secrets. source: .gitignore, docs/tickets/FIN-001.
- MUST NOT read or edit `.env`; use `.env.example` for the variable list. why: secrets.
- MUST verify code features against the fake provider and recorded fixtures; tests never call Enable Banking, Kraken or price APIs over the network. why: unattended sessions have no credentials or network guarantees. source: docs/plan.md → Key constraint.
- MUST use `console.info` / `console.warn` / `console.error` in `src/`, not `console.log`. why: the clean-state check treats `console.log` as a debug leftover. source: harness.config.json → cleanState.
- MUST NOT `.skip`/`.only` tests or weaken assertions to get green. why: verification is the completion gate.
- MUST update docs affected by a change in the same commit (README, `docs/architecture.md`, `docs/DECISIONS.md`, the feature's ticket). why: stale docs mislead the next session more than no docs.
- MUST make one logical change per commit, with a conventional-commit subject and a body that explains why, and no AI attribution lines. why: commitlint and the commit-msg hook enforce it; the history is read at every clock-in.

## Working rules

- WIP=1: only one feature may be `in_progress`. Finish it (`passing`) or mark it `blocked` with a note before activating the next.
- State machine: `not_started → in_progress → passing`, or `→ blocked` with the reason in `notes`. Change status only through `pnpm harness:feature` / `pnpm harness:verify`; never set `passing` by hand without evidence.
- Dependencies live in `depends_on`; a feature is ready when every dependency is `passing`. Tickets in `docs/tickets/` map 1:1 to features (`FIN-NNN` ↔ `F-NNN`, `ticket` and `spec` fields) and carry no status.
- Granularity: a feature must be completable in one session. If it cannot, split it in `feature_list.json` (and its ticket) before starting.
- Scope: stay inside the selected feature; a narrow supporting fix is fine, a second feature is not.
- Completion means evidence, not confidence: run the listed layers and record `YYYY-MM-DD <command> → pass (commit <hash>)` in `evidence` (`pnpm harness:verify` writes it).
- Context anxiety: if you are running low on context, do not rush to finish. Stop, update `PROGRESS.md`, commit a clean checkpoint, and leave the next step written down.
- Escalate instead of guessing: unclear requirements → the feature's ticket, [docs/plan.md](docs/plan.md) and [docs/api-access-research.md](docs/api-access-research.md), then ask; stack questions → [docs/tech-stack.md](docs/tech-stack.md); architecture → [docs/architecture.md](docs/architecture.md) + [docs/DECISIONS.md](docs/DECISIONS.md), then ask; repeated failures → record in `PROGRESS.md` and flag for review. In a driver-run session (`HARNESS_LOOP=1`) nobody can answer: pick the simplest reading, record it, or block the feature.

## Definition of done

A feature is done only when all of these are true:

- [ ] The `user_visible_behavior` is implemented.
- [ ] Every listed verification layer actually ran, in order, and passed.
- [ ] Evidence is recorded in `feature_list.json` and the status is `passing`.
- [ ] `PROGRESS.md` is updated (Current Verified State, session entry, Next Steps).
- [ ] Affected docs are updated in the same commit.
- [ ] The tree is committed and clean, and `FAST=1 ./init.sh` still exits 0.

## Clock-out (session end)

1. `pnpm harness:clean-state --allow-state-dirty`, then the judgement items of [docs/harness/clean-state-checklist.md](docs/harness/clean-state-checklist.md).
2. Update `PROGRESS.md`; `feature_list.json` is already updated by `pnpm harness:verify` (or `pnpm harness:feature block`); `pnpm harness:check`.
3. `pnpm check` (plus the feature's L2/L3).
4. Optional: score the diff with [docs/harness/evaluator-rubric.md](docs/harness/evaluator-rubric.md) (Claude Code: the `harness:evaluator` agent). Revise before committing if any category is below 2.
5. Commit; for long sessions also fill [docs/harness/session-handoff.md](docs/harness/session-handoff.md).
6. Leave a clean restart path: the next session must be able to run `./init.sh` immediately.

Cleanup is dual-mode: immediate at every clock-out, plus a periodic (monthly) sweep that prunes stale docs, archives old PROGRESS.md sessions and regrades [docs/harness/quality-document.md](docs/harness/quality-document.md).

Claude Code: `/harness:clock-out` walks these steps; `/harness:verify-feature F-NNN` runs a feature's layers and records evidence.

## Driver-run sessions

`pnpm harness:loop` runs the same loop unattended: one fresh session per ready feature in its own worktree, `pnpm harness:verify` as the gate, a fresh-context evaluator, then a PR. Inside such a session `HARNESS_LOOP=1` is set, questions cannot be asked, `manual:` steps are never waived and the driver (not the session) pushes. Everything about it: [docs/harness/README.md](docs/harness/README.md).

## State artefacts and further reading

- State: [PROGRESS.md](PROGRESS.md) · [feature_list.json](feature_list.json) · [docs/DECISIONS.md](docs/DECISIONS.md) · [docs/harness/](docs/harness/) (README, prompts, handoff, checklist, rubric, quality document).
- Product: [docs/plan.md](docs/plan.md) · [docs/tickets/](docs/tickets/README.md) · [docs/api-access-research.md](docs/api-access-research.md).
- Project: [README.md](README.md) · [docs/tech-stack.md](docs/tech-stack.md) · [docs/architecture.md](docs/architecture.md).
- Tools: the harness CLI and the Claude Code plugin (skills, hooks, evaluator agent) come from the shared harness (`@eemelinen/harness`, configured in [harness.config.json](harness.config.json)); permissions live in `.claude/settings.json`. Both are described in [CLAUDE.md](CLAUDE.md).

## Framework notes

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
