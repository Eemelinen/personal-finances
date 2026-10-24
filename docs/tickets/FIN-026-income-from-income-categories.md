# FIN-026: App settings and income only from income categories

**Feature:** F-026 · **Milestone:** M6 Data correctness · **Area:** reports · **Depends on:** [F-017](FIN-017-spending-and-cash-flow-reports.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-026`. This ticket is the spec the session reads first.

## Goal

The user decides what counts as income. A new Settings → Reports page has the setting "Count credits without a category as income" (on by default, which is today's behaviour). When it is off, only credits in a category of kind `income` (for example Income/Salary through a rule) are income; every other credit that is not a transfer and not in an expense category is shown on its own as "Other money in (not income)" on the cash-flow report and the dashboard, so nothing disappears unseen. The app gets a small settings store that later features (F-030) reuse.

## Acceptance criteria

- An `app_settings` table (key text primary key, value jsonb, timestamps) with a migration made by `pnpm db:generate`; `src/server/settings.ts` reads and writes typed settings with defaults, so a database without rows behaves as before
- Setting `uncategorizedCreditsAsIncome` (boolean, default `true`); Settings → Reports shows it with a short explanation, saves through a Server Action behind `verifySession()`, and is linked from `/settings`
- Off: in `flowParts()` (`src/server/queries/reports.ts`) a credit without a category is not income; `getCashFlowReport()` and `getMonthCashFlow()` return `otherInMinor` per month and for the year to date, and the cash-flow page and the dashboard's month tiles show it (hidden when zero). Savings rate and net use income only
- Credits in an expense category still net against it as refunds; debits are unaffected; the spending report is unchanged
- A transaction the user put in the top-level Uncategorized category is treated exactly like one without a category (today a credit there is negative spending, D-014's known asymmetry): with the setting on it is income, with it off it is "other money in"
- `docs/DECISIONS.md` gets a decision entry amending D-014; the comment at the top of `reports.ts` is updated

## Tests (what the verification proves)

- **L1** `tests/unit/settings/app-settings.test.ts`: defaults when no row exists, value parsing and rejection of a wrong type
- **L2** `tests/integration/report-queries.int.test.ts`: with the setting on the totals match today's; off, an uncategorised credit moves from income to other-in, an Income/Salary credit stays income, a refund in an expense category still nets, a credit in Uncategorized behaves like one without a category
- **L3** `tests/e2e/settings-reports.spec.ts`: turning the setting off changes the dashboard's income tile and shows "Other money in"

## Notes

- Found with real data on 2026-10-24: a loan drawdown and many transfers from own accounts that are not connected were counted as income, so the reported income was about eight times the salary. F-027, F-029 and F-030 remove those rows from the reports; this setting is the safety net for whatever no rule has classified yet.
- Keep the setting generic (no bank or employer names in code); the user's own rule (counterparty contains the employer's name → Income/Salary) is data, created through the existing rules UI.
