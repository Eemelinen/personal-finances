# Tech stack

TypeScript end to end, running locally in Docker Compose.

## Runtime & framework

| Layer         | Choice                      | Version | Why                                                                                               |
| ------------- | --------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| Runtime       | **Node.js** (LTS "Krypton") | 24.x    | Current LTS. Pinned via `.nvmrc` and `engines`, and used in the Docker images (`node:24-alpine`). |
| Language      | **TypeScript** (strict)     | 5.9     | One language for UI, API, worker and scripts.                                                     |
| Web framework | **Next.js** (App Router)    | 16.4    | UI and backend (route handlers, server actions) in one app. Standalone output for Docker.         |
| UI library    | **React**                   | 19.3    | Comes with Next.js.                                                                               |
| Styling       | **Tailwind CSS**            | 4.3     | Fast utility-first styling, no CSS files to maintain.                                             |
| UI components | **shadcn/ui** (Radix, Nova) | 4.22    | Accessible Radix primitives copied into `src/components/ui`; `lucide-react` icons.                |

## Data

| Layer      | Choice                     | Version | Why                                                                                        |
| ---------- | -------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| Database   | **PostgreSQL**             | 18      | Reliable, strong date and aggregate queries for reports, `numeric` and `bigint` for money. |
| ORM        | **Drizzle ORM**            | 0.45    | Type-safe SQL-like queries, schema written in TS, no heavy runtime.                        |
| Migrations | **drizzle-kit**            | 0.31    | Generates SQL migrations from the schema. Migrations are committed in `drizzle/`.          |
| DB driver  | **postgres** (postgres.js) | 3.4     | Fast, pure JS, works in both Next.js and the worker.                                       |
| Validation | **zod**                    | 4.6     | Environment validation now; later API payloads, CSV rows and forms.                        |

## Background jobs

| Layer        | Choice        | Version | Why                                                                                 |
| ------------ | ------------- | ------- | ----------------------------------------------------------------------------------- |
| Scheduler    | **node-cron** | 4.6     | Simple in-process cron with time zones and overlap protection. Enough for one user. |
| TS execution | **tsx**       | 4.23    | Runs the worker and scripts directly from TypeScript, with `@/` path aliases.       |

## Tooling

| Purpose         | Choice                                              | Version |
| --------------- | --------------------------------------------------- | ------- |
| Package manager | **pnpm** (pinned in `packageManager`, via corepack) | 10.15   |
| Tests           | **Vitest**                                          | 5.0     |
| L2 database     | **Testcontainers** (`@testcontainers/postgresql`)   | 12.2    |
| L3 browser      | **Playwright** (`@playwright/test`, Chromium)       | 1.63    |
| Linting         | **ESLint** with `eslint-config-next`                | 9.39    |
| Formatting      | **Prettier** + `prettier-plugin-tailwindcss`        | 3.9     |
| Containers      | **Docker Compose**                                  | v2+     |

## Planned additions (added by the ticket that needs them)

| Purpose                                | Candidate                               | Ticket            |
| -------------------------------------- | --------------------------------------- | ----------------- |
| Charts                                 | Recharts                                | FIN-016 – FIN-018 |
| Sessions                               | iron-session (encrypted cookie)         | FIN-004           |
| Password hashing                       | `@node-rs/argon2`                       | FIN-004           |
| JWT signing (RS256) for Enable Banking | jose                                    | FIN-006           |
| CSV parsing                            | papaparse                               | FIN-012           |
| Stock prices                           | Twelve Data / Alpha Vantage (free tier) | FIN-020           |
| Crypto prices                          | CoinGecko API                           | FIN-021           |
| Notifications                          | ntfy (self-hostable push)               | FIN-024           |

## External services

| Service                                      | Used for                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [Enable Banking](https://enablebanking.com/) | PSD2 account information for Nordea and S-Pankki, free restricted production mode (FIN-001, FIN-006) |
| [Kraken REST API](https://docs.kraken.com/)  | Crypto balances and ledger, free, read-only key (FIN-021)                                            |
| Twelve Data / Alpha Vantage (free tier)      | Stock and fund prices (FIN-020)                                                                      |
| CoinGecko API (free tier)                    | Crypto prices (FIN-021)                                                                              |

Why these were chosen, and which free alternatives were ruled out: [API access research](api-access-research.md).

## Alternatives considered

- **Python (FastAPI) backend + React.** Good for data analysis, but it means two languages and two toolchains for a one-person project.
- **SQLite.** Simpler, but Postgres has better date and aggregate functions and handles the app and worker writing at the same time. It costs nothing extra in Docker.
- **Prisma.** Heavier runtime and generated client. Drizzle stays closer to SQL, which suits reporting queries.
- **A separate queue (BullMQ + Redis) for jobs.** Unnecessary for a few scheduled jobs for one user. node-cron in a dedicated worker process is enough.
- **GoCardless Bank Account Data, Tink, Yapily, Salt Edge, TrueLayer.** Either closed to new signups (GoCardless) or free for the sandbox only. See [API access research](api-access-research.md#options-compared).
