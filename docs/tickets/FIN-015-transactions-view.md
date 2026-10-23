# FIN-015: Transactions view

**Milestone:** M2 Categorization · **Status:** Todo · **Depends on:** FIN-013

## Description

A fast, filterable list of all transactions, where categories can be fixed and new rules created directly from a transaction.

## Acceptance criteria

- [ ] `/transactions`: table with date, account, counterparty or description, category, amount (colored by sign) and a pending badge
- [ ] Filters: date range, account(s), category, text search, income or expense, include or exclude transfers. Filters live in the URL search params, so a filtered view can be shared or bookmarked.
- [ ] Pagination or infinite scroll (works with 10k+ rows)
- [ ] Inline category change (sets `category_source = manual`)
- [ ] "Create rule from this transaction": prefilled with the counterparty, and offers to apply the rule to similar past transactions
- [ ] Optional note on a transaction
- [ ] Totals for the current filter (sum in and out)
- [ ] shadcn/ui set up (first UI-heavy ticket)
