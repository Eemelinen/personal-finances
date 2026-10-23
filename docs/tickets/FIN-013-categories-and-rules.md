# FIN-013: Categories & rule engine

**Milestone:** M2 Categorization · **Status:** Todo · **Depends on:** FIN-009

## Description

Assign every transaction a category automatically, so spending can be broken down. Rules first, manual overrides always win.

## Acceptance criteria

- [ ] Seeded default categories (two levels), e.g. Housing (rent, electricity), Groceries, Restaurants & cafés, Transport (public transport, fuel), Shopping, Health, Subscriptions, Travel, Entertainment, Income (salary, other), Savings & investments, Transfers, Uncategorized
- [ ] Rule engine: match on `counterparty` or `description` (`contains`, `equals`, `regex`) and optionally amount sign or range. Rules apply in `priority` order, first match wins.
- [ ] Seeded rules for common Finnish merchants (S-Market, Prisma, K-Market, Lidl, Alepa, HSL, VR, Wolt, Foodora, ...)
- [ ] Runs on new transactions after sync, and "re-apply rules" can run on demand for all non-manual transactions
- [ ] `category_source` is `rule`, `manual` or `none`. Manual is never overwritten.
- [ ] `/settings/categories`: manage categories and rules (create, edit, reorder, delete)
- [ ] Unit tests for rule matching and priority
