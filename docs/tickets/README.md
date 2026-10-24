# Feature tickets

Each ticket is the spec for exactly one harness feature: `FIN-NNN` ↔ `F-NNN` in [feature_list.json](../../feature_list.json). The feature list owns **status, verification commands and evidence**, and only the harness scripts change it (`pnpm harness:feature`, `pnpm harness:verify`). Tickets carry no status, so the two can never disagree.

- Current status: `pnpm harness:feature list` (or `pnpm harness:check` for the summary)
- Next ready feature: `pnpm harness:feature next` (add `--include-manual` to include human-only ones)
- How a feature is worked on: [AGENTS.md](../../AGENTS.md) and [docs/harness/README.md](../harness/README.md)

**Sizing rule:** a feature fits in one agent session (about 100 turns). If it does not, split it in `feature_list.json` (and here) before starting. **Human-only** features have `manual:` verification steps (real credentials, network or a person); the unattended loop skips them.

## M0: Foundation

| Ticket                                            | Feature | Title                                                     | Depends on | Layers    | Runs       |
| ------------------------------------------------- | ------- | --------------------------------------------------------- | ---------- | --------- | ---------- |
| [FIN-000](FIN-000-scaffold-and-harness.md)        | F-000   | Project scaffold and agent harness bootstrap              | —          | L1        | unattended |
| [FIN-001](FIN-001-enable-banking-access-spike.md) | F-001   | Enable Banking access spike and sandbox fixtures          | F-000      | L1 manual | human-only |
| [FIN-002](FIN-002-database-schema.md)             | F-002   | Database schema, first migration and L2 integration layer | F-000      | L1 L2     | unattended |
| [FIN-003](FIN-003-app-shell-and-e2e-layer.md)     | F-003   | App shell and L3 end-to-end layer                         | F-000      | L1 L3     | unattended |
| [FIN-004](FIN-004-single-user-auth.md)            | F-004   | Single-user authentication                                | F-003      | L1 L3     | unattended |

## M1: Bank data

| Ticket                                           | Feature | Title                                                 | Depends on   | Layers    | Runs       |
| ------------------------------------------------ | ------- | ----------------------------------------------------- | ------------ | --------- | ---------- |
| [FIN-005](FIN-005-provider-contract.md)          | F-005   | Provider contract, fake provider and token encryption | F-002        | L1        | unattended |
| [FIN-006](FIN-006-enable-banking-client.md)      | F-006   | Enable Banking client and provider                    | F-001, F-005 | L1        | unattended |
| [FIN-007](FIN-007-connect-bank-flow.md)          | F-007   | Connect-bank flow                                     | F-004, F-006 | L1 L2 L3  | unattended |
| [FIN-008](FIN-008-sync-accounts-and-balances.md) | F-008   | Sync accounts and balances                            | F-002, F-005 | L1 L2     | unattended |
| [FIN-009](FIN-009-sync-transactions.md)          | F-009   | Sync transactions                                     | F-008        | L1 L2     | unattended |
| [FIN-010](FIN-010-scheduled-sync.md)             | F-010   | Scheduled sync, Sync now and sync log                 | F-007, F-009 | L1 L2 L3  | unattended |
| [FIN-011](FIN-011-consent-expiry-and-renewal.md) | F-011   | Consent expiry and renewal                            | F-007        | L1 L2 L3  | unattended |
| [FIN-012](FIN-012-csv-import.md)                 | F-012   | CSV import for Nordea and S-Pankki exports            | F-004, F-009 | L1 L2 L3  | unattended |
| [FIN-013](FIN-013-live-bank-acceptance.md)       | F-013   | Live bank acceptance with real accounts               | F-010, F-011 | L1 manual | human-only |
| [FIN-025](FIN-025-nordea-card-history.md)        | F-025   | Nordea card transactions without a 540-day date_from  | F-006        | L1        | unattended |

## M2: Categorization

| Ticket                                      | Feature | Title                                            | Depends on   | Layers | Runs       |
| ------------------------------------------- | ------- | ------------------------------------------------ | ------------ | ------ | ---------- |
| [FIN-014](FIN-014-categorization-engine.md) | F-014   | Categorization engine and own-transfer detection | F-009        | L1 L2  | unattended |
| [FIN-015](FIN-015-transactions-view.md)     | F-015   | Transactions view and category management        | F-004, F-014 | L1 L3  | unattended |

## M3: Dashboard

| Ticket                                               | Feature | Title                          | Depends on   | Layers   | Runs       |
| ---------------------------------------------------- | ------- | ------------------------------ | ------------ | -------- | ---------- |
| [FIN-016](FIN-016-dashboard-overview.md)             | F-016   | Dashboard overview             | F-004, F-008 | L1 L2 L3 | unattended |
| [FIN-017](FIN-017-spending-and-cash-flow-reports.md) | F-017   | Spending and cash-flow reports | F-014, F-016 | L1 L2 L3 | unattended |
| [FIN-018](FIN-018-balance-history.md)                | F-018   | Balance and net-worth history  | F-016        | L1 L2 L3 | unattended |

## M4: Investments

| Ticket                                                | Feature | Title                                          | Depends on          | Layers    | Runs       |
| ----------------------------------------------------- | ------- | ---------------------------------------------- | ------------------- | --------- | ---------- |
| [FIN-019](FIN-019-investment-data-model.md)           | F-019   | Investment data model and valuation            | F-002               | L1 L2     | unattended |
| [FIN-020](FIN-020-nordnet-import-and-stock-prices.md) | F-020   | Nordnet import and stock prices                | F-004, F-019        | L1 L2 L3  | unattended |
| [FIN-021](FIN-021-kraken-and-crypto-prices.md)        | F-021   | Kraken holdings and crypto prices              | F-019               | L1 L2     | unattended |
| [FIN-022](FIN-022-net-worth-with-investments.md)      | F-022   | Net worth and allocation including investments | F-018, F-020, F-021 | L1 L2 L3  | unattended |
| [FIN-023](FIN-023-live-investments-acceptance.md)     | F-023   | Live investments acceptance                    | F-022               | L1 manual | human-only |

## M5: Operations

| Ticket                                          | Feature | Title                     | Depends on   | Layers | Runs       |
| ----------------------------------------------- | ------- | ------------------------- | ------------ | ------ | ---------- |
| [FIN-024](FIN-024-backups-and-notifications.md) | F-024   | Backups and notifications | F-010, F-011 | L1 L2  | unattended |

## Backlog (not in the feature list yet)

- Monthly budgets per category with progress and suggested amounts (was FIN-021)
- Recurring payment and subscription detection (was part of FIN-020)
- Weekly summary notification (was part of FIN-027)

Add a backlog item by appending a feature to `feature_list.json` and a matching ticket here.
