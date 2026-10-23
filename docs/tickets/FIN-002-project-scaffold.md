# FIN-002: Project scaffold

**Milestone:** M0 Foundation · **Status:** Done · **Depends on:** none

## Description

Set up the project skeleton and infrastructure that every feature builds on. This ticket adds no features.

## Acceptance criteria

- [x] Next.js 16 (App Router, TypeScript strict, Tailwind 4, `src/` dir, `@/` alias) with `output: "standalone"`
- [x] Node 24 LTS pinned (`.nvmrc`, `engines`), Docker images on `node:24-alpine`
- [x] Typed env validation with zod (`src/server/env.ts`) and an `.env.example` documenting all variables
- [x] Drizzle ORM + postgres.js client (`src/server/db/client.ts`), drizzle-kit config, migration runner (`src/server/db/migrate.ts`)
- [x] Worker process (`src/worker`) with a job registry, node-cron scheduling in `APP_TIMEZONE` and graceful shutdown. It has a heartbeat job only.
- [x] `GET /api/health` reports DB connectivity
- [x] Docker Compose with `db` (Postgres 18), `migrate` (one-shot), `app` and `worker`. Ports are bound to `127.0.0.1`.
- [x] Vitest, ESLint and Prettier set up, with npm scripts for each
- [x] `secrets/` folder gitignored for private keys
- [x] README and docs (plan, architecture, tech stack, tickets)

## Notes

- Verified: `npm run typecheck`, `lint`, `test`, `build` pass. `docker compose up --build` starts all services, and `/api/health` returns `{"status":"ok","db":"ok"}`.
- The Postgres host port defaults to **5434** because 5432 and 5433 are used by other local projects.
