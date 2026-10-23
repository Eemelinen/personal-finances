# Personal Finances

A self-hosted personal finance dashboard. It syncs balances and transactions from **Nordea** and **S-Pankki** through open banking APIs, shows what money is spent on, and is built to add **stocks and crypto** holdings later.

> **Status:** the project scaffold is done (FIN-002). Features are next, ticket by ticket.

## Documentation

| Doc                                                | What's in it                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| [Project plan](docs/plan.md)                       | Goals, scope, bank API access strategy, milestones, MVP order       |
| [Feature tickets](docs/tickets/README.md)          | All tickets by milestone, with status and dependencies              |
| [API access research](docs/api-access-research.md) | Free API options for Nordea, S-Pankki, Nordnet and Kraken           |
| [Architecture](docs/architecture.md)               | Services, directory layout, sync data flow, data model, conventions |
| [Tech stack](docs/tech-stack.md)                   | Technologies and versions, and why they were chosen                 |

## Quick start

Requirements: Node.js 24 LTS (`nvm use`), pnpm via corepack (`corepack enable`) and Docker Desktop.

```sh
cp .env.example .env        # then set POSTGRES_PASSWORD and DATABASE_URL
pnpm install
```

Notes:

- Postgres is published on host port **5434** (not 5432) to avoid clashing with other local projects. Change `POSTGRES_PORT` and `DATABASE_URL` in `.env` if needed.
- pnpm (pinned via `packageManager`, run through corepack) only runs install scripts for packages listed in `pnpm.onlyBuiltDependencies` in `package.json` (esbuild, unrs-resolver). `pnpm approve-builds` adds new ones.

**Option A: everything in Docker**

```sh
docker compose up --build -d
# app:    http://localhost:3000
# health: http://localhost:3000/api/health
```

**Option B: database in Docker, app and worker on the host (best for development)**

```sh
docker compose up -d db
pnpm db:migrate
pnpm dev          # Next.js on http://localhost:3000
pnpm worker:dev   # in another terminal: scheduled jobs
```

## Scripts

| Script                              | Description                                   |
| ----------------------------------- | --------------------------------------------- |
| `pnpm dev`                          | Next.js dev server                            |
| `pnpm build` / `pnpm start`         | Production build / start                      |
| `pnpm worker` / `pnpm worker:dev`   | Run the background worker (with watch in dev) |
| `pnpm db:generate`                  | Generate a SQL migration from schema changes  |
| `pnpm db:migrate`                   | Apply migrations                              |
| `pnpm db:studio`                    | Browse the database with Drizzle Studio       |
| `pnpm test` / `pnpm test:watch`     | Unit tests (Vitest)                           |
| `pnpm lint` / `pnpm typecheck`      | ESLint / TypeScript checks                    |
| `pnpm format` / `pnpm format:check` | Prettier                                      |

## Project structure

```
src/app/        Next.js pages and route handlers
src/server/     Domain code shared by the app and the worker (env, db, providers, sync)
src/worker/     Background worker entrypoint and job registry
drizzle/        Generated SQL migrations
secrets/        Private keys, gitignored
docs/           Plan, architecture, tech stack, tickets
```

See [docs/architecture.md](docs/architecture.md) for details.
