# FIN-020: Top merchants & recurring payments

**Milestone:** M3 Dashboard · **Status:** Todo · **Depends on:** FIN-013

## Description

See where money goes at merchant level, and find subscriptions and other recurring payments.

## Acceptance criteria

- [ ] Top merchants for a period: total, number of transactions, average amount. Counterparty names are normalized, e.g. "PRISMA KAMPPI 1234" → "Prisma".
- [ ] Recurring payment detection: the same counterparty with a similar amount at a regular interval (weekly, monthly, yearly), seen at least 3 times
- [ ] `/reports/recurring`: list of detected subscriptions with interval, last amount, next expected date and yearly cost
- [ ] Mark a detected item as "not recurring" to hide it
