# Session handoff

Compact handoff for the next session. Fill it in at clock-out when the session was long or
touched several areas; for a short single-feature session the `PROGRESS.md` entry is enough.
Copy the template below into the top of this file (newest first) and fill every line.

### Handoff — 2026-10-23 · session 001 (harness bootstrap, F-000) → next: F-001 (human) or F-002 (unattended)

#### Verified now

- What is currently working: the scaffold (Next.js app, worker, Postgres, migrations, Docker Compose, `/api/health`), `pnpm check` (lint, typecheck, format, unit tests incl. `tests/unit/harness/`), `pnpm harness:check`, `pnpm harness:feature`, `pnpm harness:verify`, `scripts/clean-state-check.sh`, `pnpm harness:loop --dry-run --no-docker`, the guard / session-start hooks and the commit gates.
- What verification actually ran: see the `PROGRESS.md` Session 001 entry and the F-000 evidence in `feature_list.json`.

#### Changed this session

- Code or behaviour added: none beyond the scaffold; `console.log` → `console.info` in the worker and migration runner.
- Infrastructure or harness changes: pnpm instead of npm (D-003); the whole harness (D-001, D-002); tickets re-sliced into 25 features.

#### Broken or unverified

- Known defect: none known.
- Unverified path: a real `pnpm harness:loop --once` run (needs `gh` and `claude` on PATH, `gh auth login` and the GitHub settings in docs/harness/README.md § 4); the evaluator session; CI on GitHub (never pushed yet).
- Risk for the next session: verification lines name test files that do not exist yet (by design: the feature's session creates them). F-002 and F-003 must each introduce their layer (scripts, config, AGENTS.md, CI) together with the first tests.

#### Next best step

- Highest-priority unfinished feature: F-001 (human-only: Enable Banking sandbox + fixtures); the first unattended one is F-002 (DB schema + L2).
- Why it is next: F-006 (Enable Banking client) needs F-001's fixtures; F-002 unblocks most of M1.
- What counts as passing: the feature's `verification[]` via `pnpm harness:verify`, plus an evaluator Accept and a merged PR for driver-run features.
- What must not change during that step: `harness.config.json` caps and allowlist; tune them only after reading a trace.

#### Commands

- Startup: `./init.sh` (`FAST=1` to skip the baseline)
- Verification: `pnpm check` · `pnpm harness:verify F-NNN`
- Focused debug command: `pnpm harness:loop --dry-run --no-docker` · `pnpm harness:feature list` · `pnpm harness:report`

---

### Handoff — YYYY-MM-DD · session NNN (<feature or topic>) → next: <next step>

#### Verified now

- What is currently working:
- What verification actually ran:

#### Changed this session

- Code or behaviour added:
- Infrastructure or harness changes:

#### Broken or unverified

- Known defect:
- Unverified path:
- Risk for the next session:

#### Next best step

- Highest-priority unfinished feature:
- Why it is next:
- What counts as passing:
- What must not change during that step:

#### Commands

- Startup: `./init.sh` (`FAST=1` to skip the baseline)
- Verification: `pnpm check` · `pnpm harness:verify F-NNN`
- Focused debug command:
