# FIN-015: Transactions view and category management

**Feature:** F-015 · **Milestone:** M2 Categorization · **Area:** categorization · **Depends on:** [F-004](FIN-004-single-user-auth.md), [F-014](FIN-014-categorization-engine.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-015`. This ticket is the spec the session reads first.

## Goal

`/transactions` lists all transactions (date, account, counterparty or description, category, signed amount, pending badge) with filters kept in the URL (date range, accounts, category, text, income or expense, transfers), pagination that works with 10k+ rows and totals for the filter; I can change a category inline (marked manual), add a note, mark or unlink a transfer and create a rule from a transaction, optionally applying it to similar past ones. `/settings/categories` manages categories and rules.

## Acceptance criteria

- One-sided transfers (to an unconnected account) can be marked manually

## Tests (what the verification proves)

- **L3** `tests/e2e/transactions.spec.ts`: filters via the URL, inline category change persists, create rule from a transaction
- **L3** `tests/e2e/categories-settings.spec.ts`: create, reorder and delete a rule

## Notes

- Replaces old FIN-015 plus the `/settings/categories` UI from old FIN-013.
- Implemented in session 019 (unattended, D-020). Choices made without a human:
  - Filters only in the URL (`from`, `to`, `account` repeated, `category` id or `none`, `q`, `type`, `transfers`, `page`); invalid values are ignored; a top-level category includes its subcategories; the text also searches the note.
  - Pagination is LIMIT/OFFSET with 50 rows a page (no keyset, no new index); totals are count, income, expenses and net per currency for the whole filter.
  - Every edit is `manual` (D-012): inline category, "Mark as transfer" (one-sided only; pairing two chosen transactions by hand is not built), "Unlink transfer" (all legs, each gets its rule category or none, `manual`). "Automatic (rules)" hands a transaction back to the engine.
  - New rules run first; "apply to similar past ones" re-applies every rule (`reapplyRules()`). Reorder = move before/after a neighbour and renumber all rules by 10; it can be done within one category's rules. Rules are created and deleted, not edited.
  - Categories: two levels, subcategory kind = parent's; delete cascades to subcategories and rules and resets their transactions to no category (`none`); Transfers cannot be renamed or deleted.
  - Not in the listed layers but added: L1 `tests/unit/queries/transaction-filter.test.ts` and `tests/unit/categorization/rule-input.test.ts`, L2 `tests/integration/transactions-view.int.test.ts`. The L3 server seeds the default categories and rules and a fixture account with a pending transaction (for the pending badge).
  - After the review: categorisation is serialised by an advisory lock (`lockCategorization()`, also taken by the sync) and the engine's updates re-check `manual`; deleting a category gives transfer legs Transfers back.
  - After the second review: every user edit of a category or transfer group (inline category, mark, unlink, delete category) takes the same lock first, so a concurrent re-apply or sync cannot relink or overwrite the row between the edit's read and write; `/settings/categories` shows "Used by transfer detection" instead of Rename and Delete for the top-level Transfers category (`CategoryUsage.protected`), which the server refuses to rename or delete anyway.
