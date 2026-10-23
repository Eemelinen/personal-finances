# Feature tickets

Each ticket is one Markdown file with a description, acceptance criteria, dependencies and notes. Update the **Status** in the ticket file and in this table when work starts or finishes.

Status values: `Todo` · `In progress` · `Done`

## M0: Foundation

| ID                                                | Title                                | Status | Depends on |
| ------------------------------------------------- | ------------------------------------ | ------ | ---------- |
| [FIN-001](FIN-001-spike-enable-banking-access.md) | Spike: confirm Enable Banking access | Todo   | none       |
| [FIN-002](FIN-002-project-scaffold.md)            | Project scaffold                     | Done   | none       |
| [FIN-003](FIN-003-database-schema.md)             | Database schema & migrations         | Todo   | FIN-002    |
| [FIN-004](FIN-004-single-user-auth.md)            | Single-user authentication           | Todo   | FIN-002    |

## M1: Bank data ingestion

| ID                                                 | Title                                  | Status | Depends on       |
| -------------------------------------------------- | -------------------------------------- | ------ | ---------------- |
| [FIN-005](FIN-005-provider-interface.md)           | FinancialProvider interface & registry | Todo   | FIN-003          |
| [FIN-006](FIN-006-enable-banking-client.md)        | Enable Banking API client              | Todo   | FIN-001, FIN-005 |
| [FIN-007](FIN-007-connect-bank-flow.md)            | "Connect bank" flow                    | Todo   | FIN-004, FIN-006 |
| [FIN-008](FIN-008-sync-accounts-and-balances.md)   | Sync accounts & balances               | Todo   | FIN-007          |
| [FIN-009](FIN-009-sync-transactions.md)            | Sync transactions                      | Todo   | FIN-008          |
| [FIN-010](FIN-010-scheduled-sync-worker.md)        | Scheduled sync, "Sync now" & sync log  | Todo   | FIN-009          |
| [FIN-011](FIN-011-consent-expiry-and-reconsent.md) | Consent expiry tracking & re-consent   | Todo   | FIN-007          |
| [FIN-012](FIN-012-csv-import.md)                   | CSV import (Nordea, S-Pankki)          | Todo   | FIN-005          |

## M2: Categorization

| ID                                         | Title                                 | Status | Depends on |
| ------------------------------------------ | ------------------------------------- | ------ | ---------- |
| [FIN-013](FIN-013-categories-and-rules.md) | Categories & rule engine              | Todo   | FIN-009    |
| [FIN-014](FIN-014-transfer-detection.md)   | Detect transfers between own accounts | Todo   | FIN-009    |
| [FIN-015](FIN-015-transactions-view.md)    | Transactions view                     | Todo   | FIN-013    |

## M3: Dashboard & graphs

| ID                                            | Title                                    | Status | Depends on       |
| --------------------------------------------- | ---------------------------------------- | ------ | ---------------- |
| [FIN-016](FIN-016-dashboard-overview.md)      | Dashboard overview (net worth, balances) | Todo   | FIN-008          |
| [FIN-017](FIN-017-spending-by-category.md)    | Spending by category                     | Todo   | FIN-013, FIN-014 |
| [FIN-018](FIN-018-income-vs-expenses.md)      | Income vs expenses & cash flow           | Todo   | FIN-014          |
| [FIN-019](FIN-019-balance-history.md)         | Balance & net worth history              | Todo   | FIN-008          |
| [FIN-020](FIN-020-merchants-and-recurring.md) | Top merchants & recurring payments       | Todo   | FIN-013          |
| [FIN-021](FIN-021-budgets.md)                 | Monthly budgets (optional)               | Todo   | FIN-017          |

## M4: Investments (later)

| ID                                               | Title                                        | Status | Depends on                |
| ------------------------------------------------ | -------------------------------------------- | ------ | ------------------------- |
| [FIN-022](FIN-022-investment-data-model.md)      | Investment data model                        | Todo   | FIN-003                   |
| [FIN-023](FIN-023-stocks-and-funds.md)           | Stocks & funds holdings + prices             | Todo   | FIN-022                   |
| [FIN-024](FIN-024-crypto-holdings.md)            | Crypto holdings + prices                     | Todo   | FIN-022                   |
| [FIN-025](FIN-025-net-worth-with-investments.md) | Net worth & allocation including investments | Todo   | FIN-019, FIN-023, FIN-024 |

## M5: Operations

| ID                                     | Title                                             | Status | Depends on       |
| -------------------------------------- | ------------------------------------------------- | ------ | ---------------- |
| [FIN-026](FIN-026-database-backups.md) | Automated database backups                        | Todo   | FIN-002          |
| [FIN-027](FIN-027-notifications.md)    | Notifications for failed syncs & expiring consent | Todo   | FIN-010, FIN-011 |

## MVP order

FIN-001 → FIN-002 ✅ → FIN-003 → FIN-004 → FIN-005 → FIN-006 → FIN-007 → FIN-008 → FIN-009 → FIN-016 → FIN-013 → FIN-014 → FIN-017 → FIN-018 → FIN-010

FIN-012 (CSV import) can be pulled forward right after FIN-005 if API access is delayed.

## Ticket template

```md
# FIN-0XX: Title

**Milestone:** … · **Status:** Todo · **Depends on:** …

## Description

## Acceptance criteria

- [ ] …

## Notes
```
