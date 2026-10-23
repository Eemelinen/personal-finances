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

- Stocks, funds and crypto holdings, with price feeds and net worth including investments
- Budgets, recurring payment detection, notifications

**Out of scope**

- Making payments or moving money. The app is read-only towards the banks.
- Multiple users, or public hosting

## Key constraint: bank API access

Nordea and S-Pankki only give production API access to licensed third-party providers under PSD2, not to individuals. The app therefore connects through an **open banking aggregator** that holds the license.

**The full comparison of free options is in [API access research](api-access-research.md).** It covers banks, Nordnet and Kraken. In short:

| Source                      | Route                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Nordea, S-Pankki**        | **Enable Banking** in free _restricted production_ mode: real data for accounts you link yourself, personal use only. To be confirmed hands-on in [FIN-001](tickets/FIN-001-spike-enable-banking-access.md). |
| Nordea, S-Pankki (fallback) | **CSV import** of netbank exports ([FIN-012](tickets/FIN-012-csv-import.md))                                                                                                                                 |
| **Nordnet** (investments)   | No API available (not onboarding new customers), so **CSV export → import** ([FIN-023](tickets/FIN-023-stocks-and-funds.md))                                                                                 |
| **Kraken** (crypto)         | Official REST API, free, with a **read-only key** ([FIN-024](tickets/FIN-024-crypto-holdings.md))                                                                                                            |

GoCardless Bank Account Data (ex-Nordigen) stopped accepting new signups in July 2025. Tink, Yapily, Salt Edge and TrueLayer only offer sandboxes for free, and production needs a business contract.

Consequences built into the plan:

- **Consent expires.** Users must re-authorize access periodically, typically after 90–180 days. The app tracks expiry and offers a re-consent flow ([FIN-011](tickets/FIN-011-consent-expiry-and-reconsent.md)).
- **Data access is behind an interface.** All data sources implement a common `FinancialProvider` interface, so changing aggregator, or adding a broker or crypto exchange, doesn't touch the rest of the app.

## Milestones

| Milestone                   | Tickets           | Result                                                        |
| --------------------------- | ----------------- | ------------------------------------------------------------- |
| **M0: Foundation**          | FIN-001 – FIN-004 | Running app skeleton, DB schema, login, bank access confirmed |
| **M1: Bank data**           | FIN-005 – FIN-012 | Accounts, balances and transactions syncing automatically     |
| **M2: Categorization**      | FIN-013 – FIN-015 | Transactions categorized, own transfers excluded              |
| **M3: Dashboard**           | FIN-016 – FIN-021 | Graphs for spending, cash flow and balances                   |
| **M4: Investments** (later) | FIN-022 – FIN-025 | Stocks and crypto included in net worth                       |
| **M5: Operations**          | FIN-026 – FIN-027 | Backups and failure notifications                             |

Recommended order for a first usable version (MVP):

FIN-001 → FIN-002 → FIN-003 → FIN-004 → FIN-005 → FIN-006 → FIN-007 → FIN-008 → FIN-009 → FIN-016 → FIN-013 → FIN-014 → FIN-017 → FIN-018 → FIN-010

All tickets, with status and dependencies, are listed in the [ticket index](tickets/README.md).

## Related docs

- [API access research](api-access-research.md): free API options for Nordea, S-Pankki, Nordnet and Kraken
- [Architecture](architecture.md): components, data model and data flow
- [Tech stack](tech-stack.md): chosen technologies and why
