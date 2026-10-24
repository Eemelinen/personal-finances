# Personal Finances

A self-hosted personal finance dashboard. It syncs balances and transactions from **Nordea** and **S-Pankki** through open banking APIs, shows what money is spent on, and is built to add **stocks and crypto** holdings later.

> **Status:** scaffold and agent harness are in place (F-000). Features are built one per session from [feature_list.json](feature_list.json); current state is in [PROGRESS.md](PROGRESS.md).

## Documentation

| Doc                                                | What's in it                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| [Project plan](docs/plan.md)                       | Goals, scope, bank API access strategy, milestones, MVP order       |
| [Feature tickets](docs/tickets/README.md)          | One ticket per harness feature, by milestone, with dependencies     |
| [AGENTS.md](AGENTS.md)                             | Agent operating manual: session loop, verification layers, rules    |
| [PROGRESS.md](PROGRESS.md)                         | Current verified state, next steps, session log                     |
| [Agent harness](docs/harness/README.md)            | How sessions and the unattended loop work                           |
| [Decisions](docs/DECISIONS.md)                     | Decision log                                                        |
| [API access research](docs/api-access-research.md) | Free API options for Nordea, S-Pankki, Nordnet and Kraken           |
| [Architecture](docs/architecture.md)               | Services, directory layout, sync data flow, data model, conventions |
| [Tech stack](docs/tech-stack.md)                   | Technologies and versions, and why they were chosen                 |

## Quick start

Requirements: Node.js 24 LTS (`nvm use`), pnpm via corepack (`corepack enable`) and Docker Desktop.

```sh
cp .env.example .env        # then set POSTGRES_PASSWORD and DATABASE_URL
pnpm install
pnpm auth:hash              # paste the printed AUTH_PASSWORD_HASH line into .env
openssl rand -base64 32     # use as SESSION_SECRET in .env
openssl rand -base64 32     # a second one as ENCRYPTION_KEY (keep it: it decrypts stored bank sessions)
```

Every page asks for that password at `/login` (one user, no accounts); the session lasts 30 days from the last visit.

Optional: a free [Twelve Data](https://twelvedata.com/) key as `PRICE_API_KEY` gives the worker daily closing prices for the holdings imported from Nordnet on `/investments`; without it holdings are valued at their last trade price (exchange rates come from the ECB either way).

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
pnpm db:up
pnpm db:migrate
pnpm dev          # Next.js on http://localhost:3000
pnpm worker:dev   # in another terminal: scheduled jobs
```

## Working on it with the agent harness

```sh
./init.sh                  # install, tooling checks, L1 baseline
pnpm harness:feature next  # next ready feature
```

In Claude Code: `/harness:clock-in`, implement, `/harness:verify-feature F-NNN`, `/harness:clock-out` (skills from the shared harness plugin, [Eemelinen/harness](https://github.com/Eemelinen/harness)). Unattended: `pnpm harness:loop --once` (see [docs/harness/README.md](docs/harness/README.md) for prerequisites).

## Scripts

| Script                               | Description                                   |
| ------------------------------------ | --------------------------------------------- |
| `pnpm dev`                           | Next.js dev server                            |
| `pnpm build` / `pnpm start`          | Production build / start                      |
| `pnpm worker` / `pnpm worker:dev`    | Run the background worker (with watch in dev) |
| `pnpm db:generate`                   | Generate a SQL migration from schema changes  |
| `pnpm db:migrate`                    | Apply migrations, seed the default categories |
| `pnpm db:studio`                     | Browse the database with Drizzle Studio       |
| `pnpm auth:hash`                     | Print `AUTH_PASSWORD_HASH` for a password     |
| `pnpm test:unit` / `pnpm test:watch` | Unit tests (Vitest project `unit`)            |
| `pnpm test:integration`              | L2: Vitest + Testcontainers Postgres 18       |
| `pnpm test:e2e`                      | L3: Playwright against the production build   |
| `pnpm check`                         | L1: lint, typecheck, format check, unit tests |
| `pnpm check:full`                    | `check` + L2 + L3 (builds the app)            |
| `pnpm db:up` / `pnpm db:down`        | Start / stop the dev database (Docker)        |
| `pnpm harness:feature list`          | Feature queue with ready markers              |
| `pnpm harness:verify F-NNN`          | Run a feature's layers, record evidence       |
| `pnpm harness:loop`                  | Unattended loop: one session + PR per feature |
| `pnpm lint` / `pnpm typecheck`       | ESLint / TypeScript checks                    |
| `pnpm format` / `pnpm format:check`  | Prettier                                      |

## Project structure

```
src/app/        Next.js pages and route handlers; (app)/ holds the pages inside the app shell, login/ the login page
src/proxy.ts    Redirects requests without a session to /login
src/lib/        App helpers; lib/auth is the server-only session data access layer
src/components/ App shell, dashboard widgets, report charts, shared components and shadcn/ui primitives (components/ui)
src/server/     Domain code shared by the app and the worker (env, db, providers, sync, CSV import, investments and prices, dashboard and report queries)
src/worker/     Background worker entrypoint and job registry
drizzle/        Generated SQL migrations
secrets/        Private keys, gitignored
tests/          Unit (L1), integration (L2) and end-to-end (L3) tests
scripts/        Agent harness scripts
.claude/        Claude Code settings, hooks, skills, evaluator
docs/           Plan, architecture, tech stack, tickets, decisions, harness docs
```

See [docs/architecture.md](docs/architecture.md) for details.
