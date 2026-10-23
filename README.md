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

Requirements: Node.js 24 LTS (`nvm use`) and Docker Desktop.

```sh
cp .env.example .env        # then set POSTGRES_PASSWORD and DATABASE_URL
npm install
```

**Option A: everything in Docker**

```sh
docker compose up --build -d
# app:    http://localhost:3000
# health: http://localhost:3000/api/health
```

**Option B: database in Docker, app and worker on the host (best for development)**

```sh
docker compose up -d db
npm run db:migrate
npm run dev          # Next.js on http://localhost:3000
npm run worker:dev   # in another terminal: scheduled jobs
```

## Scripts

| Script                                    | Description                                   |
| ----------------------------------------- | --------------------------------------------- |
| `npm run dev`                             | Next.js dev server                            |
| `npm run build` / `npm start`             | Production build / start                      |
| `npm run worker` / `npm run worker:dev`   | Run the background worker (with watch in dev) |
| `npm run db:generate`                     | Generate a SQL migration from schema changes  |
| `npm run db:migrate`                      | Apply migrations                              |
| `npm run db:studio`                       | Browse the database with Drizzle Studio       |
| `npm test` / `npm run test:watch`         | Unit tests (Vitest)                           |
| `npm run lint` / `npm run typecheck`      | ESLint / TypeScript checks                    |
| `npm run format` / `npm run format:check` | Prettier                                      |

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
