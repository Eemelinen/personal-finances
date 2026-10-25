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
| [Operations](docs/operations.md)                   | Backups, restoring one, notifications                               |
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

Bank sync (Nordea, S-Pankki) goes through an [Enable Banking](https://enablebanking.com/) application: put its RSA private key in `secrets/enable-banking.pem` and set `ENABLE_BANKING_APP_ID`, `ENABLE_BANKING_REDIRECT_URL` (as registered for the application) and `ENABLE_BANKING_ENV` (`sandbox` or `production`) in `.env`. Compose mounts `secrets/` read-only into the app and the worker. Without them the app runs, but bank connections fail. Connect a bank on `/connections` (FIN-007): the bank redirects back to `ENABLE_BANKING_REDIRECT_URL`, which must be `<app URL>/connections/callback`; the app also needs `ENCRYPTION_KEY` to store the session. A new connection is synced right away; after that the worker syncs every active connection on `SYNC_CRON` (every 6 hours by default, the four unattended fetches a day PSD2 allows), and **Sync now** on the dashboard or a connection's card syncs on demand. Each connection's sync log (status, duration, counts, errors) is on `/connections`. A consent lasts at most 180 days: from 14 days before it ends every page shows a warning, after it an error, and syncs skip the connection; **Renew** (in the banner or on the connection's card) logs in at the bank again and keeps the same connection, accounts and history (FIN-011). Connecting the bank again instead would create a second connection with new accounts.

Optional: a free [Twelve Data](https://twelvedata.com/) key as `PRICE_API_KEY` gives the worker daily closing prices for the holdings imported from Nordnet on `/investments`; without it holdings are valued at their last trade price (exchange rates come from the ECB either way).

Optional: a **read-only** Kraken API key as `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` lets the worker sync Kraken balances and ledger every six hours (it stores the key encrypted with `ENCRYPTION_KEY`). Create it under Kraken → Settings → API with only _Query Funds_, _Query Open Orders & Trades_, _Query Closed Orders & Trades_ and _Query Ledger Entries_; never enable trading, deposit or withdrawal permissions, and restrict it to your IP. To stop the sync, revoke the key on Kraken: the stored copy keeps being used after the variables are removed. Wallets without an API are added by hand on `/investments`. Crypto prices come from CoinGecko daily without a key; a free demo key as `COINGECKO_API_KEY` raises its rate limit.

Net worth on the dashboard and under Reports → Balances counts the investments at each day's prices; Reports → Allocation breaks it down by asset class and by account and splits the investments' value into contributions and market gain. A Nordnet account's cash is worked out from its imported transactions, so import the export from the account's opening.

Income on the dashboard and under Reports → Cash flow includes every incoming payment without a category by default. If loan drawdowns or transfers from your own accounts inflate it, turn off **Count credits without a category as income** under Settings → Reports: then only credits in an income category (for example Income › Salary through a rule) are income, and the rest are shown as "Other money in (not income)".

Payments into investments are not spending, and money taken out of them is not income. Only Nordnet has a built-in rule; to recognise other brokers, crypto exchanges (also by their legal entity, such as Payward for Kraken), fund companies and fund subscriptions or redemptions (`MERKINTÄ`, `LUNASTUS`, …), turn on **Leave investments out of spending and income** under Settings → Reports (off by default). Saving puts every recognised transaction that no rule categorises into Savings & investments › Investments and says how many changed; your rules and manual categories always win, so a shop that shares a broker's name gets its real category from a rule. On `/transactions` they show under "Not counted" as investments.

To leave a single transaction out of every report without deleting it (a loan drawdown, a home purchase, a bank correction), open its **Details** on the Transactions page and choose **Exclude from reports**. It moves to the Excluded category, stays in the list with an "Excluded" badge (the Excluded filter shows or hides such rows), and no longer counts in spending, cash flow, the dashboard tiles, top merchants, averages or transfer detection; balances do not change. **Include again** hands it back to the rules. A rule can also target the Excluded category.

Synced transactions keep the other party's account number (IBAN) when the bank gives one; it is shown in the transaction's **Details**, and a payment to or from the IBAN of another own account counts as a transfer even when the other leg is missing or differs. Transactions synced before this was stored get it with **Re-read history** on the connection's card under Connections: it fetches the whole history the bank still has again and updates the stored rows in place, without duplicates.

A netbank CSV export can also be imported into an account the bank already syncs (on `/import`, for history older than the bank API gives): rows the app already has are recognised by the bank's id, by an earlier import of the file, or by the same amount within 3 days, even though the export words them differently, and only the rest are added. After the preview, step 3 says how many of the file's rows the chosen account already has.

Own accounts that no connection shows (a savings account the bank consent does not cover, an account at another bank) go under **Settings → Accounts** (also linked from Connections): bank, name, IBAN, checking or savings and optionally a balance on a date. Saving re-runs the categorisation over every transaction, so payments to and from that IBAN become own transfers instead of income or spending (the page says how many were linked), and the balance counts in net worth and the balance history from its day until you give a newer one. An IBAN can belong to one account only. Accounts created by a CSV import are listed there too, so you can give them their IBAN. Archiving an account takes it off the dashboard and net worth; its IBAN still marks own transfers.

Under **Settings → Household** you list your own name variants (as banks write them, for example "Matti Meikäläinen" and "M Meikäläinen") and the people you share costs with (names and IBANs). Names match as whole names, ignoring case, punctuation and word order, so a company or a relative with your surname does not match. A member's IBAN also matches when the bank gives no account number and writes it only in the payment's message. Banks often write a name with initials ("M MEIKÄLÄINEN", "M.M. Meikäläinen") or a joint account under both holders' names: under **Possible name variants** the page lists such counterparties that nothing has claimed yet, with their number of transactions and sums, and **Add to your names** (or **Add to** a member) saves the variant with one click. Nothing is matched without that click, so a relative with your initials is never caught by mistake. A payment from or to one of your own names (money from your account at a bank the app does not know) becomes an own transfer; a payment with a household member gets a "Household" badge on the Transactions page (the Household filter shows or hides such rows) and keeps its category. Turn on **Ignore transfers with household members** (off by default) to leave those payments out of income and spending in both directions, for example a spouse's monthly contributions to shared costs; card purchases on a joint account still count, because their counterparty is the shop. Saving the names re-runs the categorisation and says how many transactions changed.

The **Income**, **Expenses** and **Net** above the Transactions list count the filtered transactions like Reports → Cash flow and the dashboard: own transfers, excluded transactions, transactions with household members (while ignored) and amounts in other currencies than EUR are left out, a refund in a spending category lowers Expenses, and a credit without a category is income or, with the income setting off, **Other money in**. With only a date range set they equal the cash-flow report for those days. A **Not counted** line under them gives how many transactions were left out, their money in and out and why, and links to them (for example to the list filtered to own transfers). The **Money in or out** filter goes by the sign of the amount only.

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
| `pnpm backup`                        | Take an encrypted backup now (needs pg_dump)  |
| `pnpm backup:decrypt <file> <key>`   | Decrypt a backup to stdout, for pg_restore    |
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
src/server/     Domain code shared by the app and the worker (env, db, providers, sync, CSV import, categorisation, investments and prices, read models, dashboard and report queries)
src/worker/     Background worker entrypoint and job registry
drizzle/        Generated SQL migrations
secrets/        Private keys, gitignored
tests/          Unit (L1), integration (L2) and end-to-end (L3) tests
scripts/        Agent harness scripts
.claude/        Claude Code settings, hooks, skills, evaluator
docs/           Plan, architecture, tech stack, tickets, decisions, harness docs
```

See [docs/architecture.md](docs/architecture.md) for details.
