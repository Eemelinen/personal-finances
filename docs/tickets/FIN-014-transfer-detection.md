# FIN-014: Detect transfers between own accounts

**Milestone:** M2 Categorization · **Status:** Todo · **Depends on:** FIN-009

## Description

Moving money from checking to savings, or from Nordea to S-Pankki, is neither spending nor income. Such transfers must be detected and excluded from spending and income reports.

## Acceptance criteria

- [ ] Pair detection: a debit on one own account matched with a credit of the same absolute amount on another own account within ±3 days, or a counterparty IBAN that matches one of my accounts
- [ ] Matched pairs share a `transfer_group_id` and get the `Transfers` category
- [ ] One-sided transfers (e.g. to a savings account that isn't connected) can be marked manually as a transfer
- [ ] Reports in M3 exclude transfers by default
- [ ] Manual "unlink" for false positives
- [ ] Unit tests: same-day, cross-bank delay, identical amounts that are not transfers
