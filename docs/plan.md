# Project plan

## Goal

A personal, self-hosted app that shows where my money is and where it goes:

- **Bank accounts:** balances and transactions for my personal (checking) and savings accounts at **Nordea** and **S-Pankki**, fetched automatically through APIs.
- **Spending insight:** what I spend money on, by category and merchant, with graphs over time.
- **Extensible:** stocks/funds and crypto holdings can be added to the same dashboard later, without redesigning the data model.

It is single-user, runs locally with Docker Compose, and keeps all financial data on my own machine.

## Scope

**In scope for the MVP**

- Connecting Nordea and S-Pankki accounts and syncing them automatically on a schedule
- Account balances, balance history and net worth
- Transaction list with categories (rule-based, with manual overrides)
- Dashboard graphs: spending by category, income vs expenses, cash flow, balance history
- CSV import as a fallback when the API is unavailable

**Later**

- Stocks, funds and crypto holdings, with price feeds and net worth including investments (M4)
- Backups and failure notifications (M5)
- Budgets and recurring-payment detection ([backlog](tickets/README.md#backlog-not-in-the-feature-list-yet))

**Out of scope**

- Making payments or moving money. The app is read-only towards the banks.
- Multiple users, or public hosting

## Decisions

| Decision        | Choice                                                                           | Details                                       |
| --------------- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| Tech stack      | TypeScript full-stack: Next.js, PostgreSQL, Drizzle                              | [Tech stack](tech-stack.md)                   |
| Hosting         | Local, with Docker Compose. Data never leaves my machine.                        | [Architecture](architecture.md)               |
| Runtime         | Node.js 24 LTS, pnpm 10 via corepack                                             | [Tech stack](tech-stack.md)                   |
| Bank access     | Enable Banking (free restricted production), CSV as fallback                     | [API access research](api-access-research.md) |
| Investments     | Nordnet via CSV import, Kraken via its read-only REST API                        | [API access research](api-access-research.md) |
| How work is run | Agent harness: one feature per session, evidence-gated, optional unattended loop | [Decisions](DECISIONS.md) D-001 – D-003       |

## Status

Status is not kept in this document, so it cannot go stale:

- **Current state and next steps:** [PROGRESS.md](../PROGRESS.md)
- **Per-feature status and evidence:** [feature_list.json](../feature_list.json), or `pnpm harness:feature list`

## Key constraint: bank API access

Nordea and S-Pankki only give production API access to licensed third-party providers under PSD2, not to individuals. The app therefore connects through an **open banking aggregator** that holds the license.

**The full comparison of free options is in [API access research](api-access-research.md).** It covers banks, Nordnet and Kraken. In short:

| Source                      | Route                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Nordea, S-Pankki**        | **Enable Banking** in free _restricted production_ mode: real data for accounts you link yourself, personal use only. Confirmed hands-on in [FIN-001](tickets/FIN-001-enable-banking-access-spike.md). |
| Nordea, S-Pankki (fallback) | **CSV import** of netbank exports ([FIN-012](tickets/FIN-012-csv-import.md))                                                                                                                           |
| **Nordnet** (investments)   | No API available (not onboarding new customers), so **CSV export → import** ([FIN-020](tickets/FIN-020-nordnet-import-and-stock-prices.md))                                                            |
| **Kraken** (crypto)         | Official REST API, free, with a **read-only key** ([FIN-021](tickets/FIN-021-kraken-and-crypto-prices.md))                                                                                             |

GoCardless Bank Account Data (ex-Nordigen) stopped accepting new signups in July 2025. Tink, Yapily, Salt Edge and TrueLayer only offer sandboxes for free, and production needs a business contract.

Consequences built into the plan:

- **Consent expires.** Users must re-authorize access periodically, typically after 90–180 days. The app tracks expiry and offers a renewal flow ([FIN-011](tickets/FIN-011-consent-expiry-and-renewal.md)).
- **Data access is behind an interface.** All data sources implement a common `FinancialProvider` interface, so changing aggregator, or adding a broker or crypto exchange, doesn't touch the rest of the app.
- **Code never needs real credentials.** Every code feature is verified against a fake provider and anonymised recorded fixtures, so it can be built unattended. Real accounts are only touched in three small human-only acceptance features (F-001, F-013, F-023).

## How the work is executed: the agent harness

The project is built with the agent harness ported from Metsävahti ([docs/harness/README.md](harness/README.md), [AGENTS.md](../AGENTS.md)):

1. **The queue** is [feature_list.json](../feature_list.json): 25 features (F-000 – F-024), each one session in size, with `depends_on` and exact verification commands per layer (L1 `pnpm check`, L2 integration, L3 end-to-end, `manual:` for human-only steps). Each feature's spec is its ticket in [docs/tickets/](tickets/README.md) (`FIN-NNN` ↔ `F-NNN`).
2. **A session** clocks in (reads PROGRESS.md, picks the next ready feature, runs `./init.sh`), implements exactly one feature, runs `pnpm harness:verify F-NNN` (which records evidence and sets `passing`), and clocks out (clean-state check, PROGRESS.md, commit). Status only changes through the harness scripts.
3. **Unattended:** `pnpm harness:loop` runs that same session per ready feature in its own git worktree, re-checks the result, has a separate evaluator session review it, and opens one PR per feature. It skips human-only features; those are done interactively (`/harness:clock-in F-001`).
4. **Layers grow with the code:** L1 exists now; F-002 adds L2 (Testcontainers Postgres) and F-003 adds L3 (Playwright).

## Milestones

| Milestone                   | Features      | Result                                                                            | Human-only |
| --------------------------- | ------------- | --------------------------------------------------------------------------------- | ---------- |
| **M0: Foundation**          | F-000 – F-004 | Scaffold + harness, bank access confirmed, DB schema + L2, app shell + L3, login  | F-001      |
| **M1: Bank data**           | F-005 – F-013 | Accounts, balances and transactions syncing automatically; CSV import; live check | F-013      |
| **M2: Categorization**      | F-014 – F-015 | Transactions categorized, own transfers excluded, transactions view               | —          |
| **M3: Dashboard**           | F-016 – F-018 | Overview, spending and cash-flow reports, balance history                         | —          |
| **M4: Investments** (later) | F-019 – F-023 | Nordnet and Kraken holdings, prices, net worth including investments              | F-023      |
| **M5: Operations**          | F-024         | Encrypted backups and failure notifications                                       | —          |

**MVP** = M0 – M3 passing (F-000 – F-018). The harness works through the queue in `priority` order whenever dependencies allow, so there is no separate ordering to maintain. The critical path is F-001 (human) → F-006 → F-007 → F-010 → F-013 (human); everything that doesn't need Enable Banking (F-002 – F-005, F-008, F-009, F-012, F-014) can proceed unattended before F-001 is done.

All features with their dependencies are listed in the [ticket index](tickets/README.md).

## Related docs

- [API access research](api-access-research.md): free API options for Nordea, S-Pankki, Nordnet and Kraken
- [Architecture](architecture.md): components, data model and data flow
- [Tech stack](tech-stack.md): chosen technologies and why
- [Decisions](DECISIONS.md): decision log
- [Agent harness](harness/README.md): how sessions and the unattended loop work
