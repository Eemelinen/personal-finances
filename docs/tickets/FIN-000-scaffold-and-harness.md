# FIN-000: Project scaffold and agent harness bootstrap

**Feature:** F-000 · **Milestone:** M0 Foundation · **Area:** harness · **Depends on:** none · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-000`. This ticket is the spec the session reads first.

## Goal

A fresh agent session can answer what the repo does, how to start it, how to verify it, what is unfinished and what to do next, using only AGENTS.md, PROGRESS.md and this file; `./init.sh` installs and runs the L1 baseline, and `pnpm harness:loop --dry-run` passes preflight.

## Acceptance criteria

- Next.js 16 (App Router, TypeScript strict, Tailwind 4, `src/`, `@/` alias, `output: "standalone"`), Node 24 LTS, pnpm via corepack
- Typed env (`src/server/env.ts`), Drizzle + postgres.js client, migration runner, worker with a job registry, `GET /api/health`
- Docker Compose: `db` (Postgres 18), `migrate`, `app`, `worker`, ports bound to `127.0.0.1`
- Agent harness ported from Metsävahti (tag `harness-reference`): AGENTS.md, PROGRESS.md, feature_list.json, init.sh, harness scripts, Claude Code hooks/skills/evaluator, loop driver, CI, commit gates

## Tests (what the verification proves)

- **L1** pnpm harness:check

## Notes

- Replaces old FIN-002 (project scaffold). Harness decisions: docs/DECISIONS.md D-001 – D-003.
