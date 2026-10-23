# Progress log

Repository-local session log. Read it at clock-in, update it at clock-out (AGENTS.md).

## Current Verified State

- Repository root: `personal-finances/` (this directory; contains `AGENTS.md`, `feature_list.json`, `init.sh`, `harness.config.json`).
- Standard startup path: `./init.sh` (`FAST=1` skips the baseline; `RUN_START_COMMAND=1` also starts the dev database, applies migrations and runs `pnpm dev`). The full stack runs with `docker compose up --build -d` (Postgres on host port 5434; `/api/health`).
- Standard verification path: L1 `pnpm check`. L2 (`pnpm test:integration`) is added by F-002 and L3 (`pnpm test:e2e`) by F-003. Per feature: `pnpm harness:verify F-NNN`.
- Session 001 (harness bootstrap): scaffold from before plus the agent harness ported from Metsävahti (D-001, D-002), pnpm 10.15 via corepack instead of npm (D-003), unit tests under `tests/unit/` (Vitest project `unit`), 27 tickets re-sliced into 25 features `F-000` – `F-024` with tickets `FIN-000` – `FIN-024` in `docs/tickets/`.
- Last verified commit: `6577dd4` + the F-000 evidence commit — `pnpm check` (27 unit tests incl. the harness tests) and `pnpm harness:check` green on 2026-10-23 (F-000 evidence in `feature_list.json`).
- Queue: `pnpm harness:feature list`. F-000 is `passing`; ready now: F-001 (human-only: Enable Banking sandbox and fixtures), F-002 (DB schema + L2) and F-003 (app shell + L3) — both unattended.
- Current blocker: none. The unattended loop additionally needs `gh` and `claude` on `PATH`, `gh auth login`, and the GitHub settings in docs/harness/README.md § 4.

## Next Steps

1. Do F-001 interactively (`/clock-in F-001`): create the Enable Banking sandbox application, record anonymised fixtures under `tests/fixtures/enable-banking/`, fill the Findings in `docs/tickets/FIN-001-enable-banking-access-spike.md`.
2. In parallel, run the loop for the unattended foundation: `pnpm harness:loop --once` (F-002), then F-003. Read the first traces and evaluator verdicts and record a row in the rubric's tuning log.
3. After branch protection with the required `Verify` check exists, set `"merge": "auto"` in `harness.config.json`.

## Session Log

### Session 001 — 2026-10-23 (interactive: harness bootstrap, F-000)

- Goal: port the Metsävahti agent harness (tag `harness-reference`) following its porting guide, and adapt the plan and tickets so the harness can execute them.
- Completed: pnpm switch (lockfile via `pnpm import`, `packageManager` pnpm@10.15.0, `pnpm.onlyBuiltDependencies`, Dockerfile via corepack); unit tests moved to `tests/unit/` with a Vitest projects root; harness files copied/adapted/written per the guide (scripts, `.claude/` settings, hooks, skills, evaluator, prompts, rubric, checklist, handoff, quality document, `init.sh`, `AGENTS.md`, `CLAUDE.md`, `harness.config.json`, CI, husky + lint-staged + commitlint); tickets re-sliced (27 → 25 features, 3 human-only) and the plan updated.
- Choices made without a human: (1) pnpm 10.15.0 instead of 12: pnpm 12 failed to create directory symlinks on Windows. (2) L2/L3 are not invented at bootstrap; F-002 and F-003 introduce them with their first tests. (3) A Prettier override keeps COPY files byte-identical to the reference. (4) `merge: "wait"` until branch protection exists. (5) `pnpm add` allowed unattended (D-003).
- Environment notes: `pnpm` resolves to `~/bin/pnpm` (`exec corepack pnpm`), a shim a Metsävahti session created after the global Node version switched to 24.22.1; `corepack enable` would install proper shims. `gh` (`C:\Program Files\GitHub CLI`) and `claude` (`~/.local/bin`) are installed but not on this shell's `PATH`. Postgres for this project is on host port 5434 (5432/5433 belong to other projects).
- Verification run: `pnpm harness:verify F-000` (L1 `pnpm check`, `pnpm harness:check`). Porting-guide § 8 acceptance checks 1–9: (1) `pnpm install` runs `prepare` → husky active (`core.hooksPath=.husky/_`); (2) `pnpm harness:check` OK; (3) `pnpm check` green, 4 files / 27 tests incl. `tests/unit/harness/`; (4) `./init.sh` and `FAST=1 ./init.sh` exit 0; (5) `scripts/clean-state-check.sh` all `[ok]`; (6) session-start hook prints the state; `guard.sh` blocks npm and bare vitest, denies the lockfile (Windows backslash path) and `next-env.d.ts`, asks for `drizzle/**`, and with `HARNESS_LOOP=1` denies a Write outside the repo and blocks `mkdir -p ~/x`, `git push`, `pnpm db:up` (13/13 decisions); (7) commitlint rejects "bad message", the commit-msg hook rejects an AI attribution trailer, lint-staged rejects a `feature_list.json` with `passing` and no evidence; (8) `pnpm harness:feature next` → F-002 (F-001 is human-only), `pnpm harness:loop --dry-run --no-docker` passes preflight and prints the worktree and `claude` commands; (9) a fresh worktree passes `FAST=1 ./init.sh` and `pnpm check` — after fixing a real failure it found: `tsc` could not resolve Next's generated `LayoutProps`, because `next-env.d.ts` / `.next/types` are gitignored; `typecheck` now runs `next typegen` first (`6577dd4`). Also: `next dev`'s `writeAgentFiles()` leaves `AGENTS.md` unchanged; Docker images rebuilt with pnpm, `/api/health` → ok.
- Known risk: the unattended loop has not run for real yet; CI has not run on GitHub yet (nothing pushed).
- Next best step: F-001 (human) and F-002 (unattended), see Next Steps.
