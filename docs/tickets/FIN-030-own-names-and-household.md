# FIN-030: Own names and household members

**Feature:** F-030 · **Milestone:** M6 Data correctness · **Area:** categorization · **Depends on:** [F-026](FIN-026-income-from-income-categories.md), [F-028](FIN-028-counterparty-account-numbers.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-030`. This ticket is the spec the session reads first.

## Goal

Money the user moves from an account the app does not know, under their own name, is an own transfer; money exchanged with a household member (a spouse) can be left out of income and spending with one toggle. Settings → "Household" holds the user's own name variants and the household members' names and account numbers, and the toggle "Ignore transfers with household members".

## Acceptance criteria

- Settings → Household (linked from `/settings`): a list of own name variants; household members, each with name variants and IBANs; the toggle (setting `ignoreHouseholdTransfers`, F-026's store, default off). Lists are stored in `app_settings` or own tables, validated (IBANs as in F-029)
- Names compare normalised: case, accents kept, punctuation and repeated spaces ignored, word order ignored (`MEIKÄLÄINEN MATTI` = `Matti Meikäläinen`, `M. Meikäläinen` = `M Meikäläinen`); a variant matches the whole counterparty, never a substring, so a merchant or a relative with the same surname does not match
- Categorisation (`categorize()` in `src/server/categorization/categorize.ts`), after the rules and the pairing: a free leg whose counterparty is an own name and whose `counterparty_iban` is not a household member's or another person's known IBAN becomes a one-sided own transfer (Transfers category, own group); a manually categorised transaction is never touched, as everywhere in categorisation
- A leg whose counterparty name or `counterparty_iban` belongs to a household member gets `transactions.household = true` (new boolean column, default false, migration); it keeps its category
- Reports and dashboard (`counted` in `flowParts()`) skip `household` rows while the toggle is on, so switching it needs no recategorisation; card purchases are unaffected because their counterparty is the merchant, not the cardholder
- Saving the lists re-runs categorisation over all transactions and reports how many rows changed; the transaction list shows a "Household" badge and filter
- `docs/DECISIONS.md` decision entry; `README.md` updated

## Tests (what the verification proves)

- **L1** `tests/unit/categorization/names.test.ts`: normalising and word-order-insensitive whole-name matching, no substring matches
- **L2** `tests/integration/household.int.test.ts`: an own-name credit becomes a one-sided transfer; household transfers in both directions leave the cash-flow totals with the toggle on and count with it off; a joint account's card purchase by the household member still counts as spending
- **L3** `tests/e2e/household-settings.spec.ts`: add a member, flip the toggle, see the dashboard's income change

## Notes

- Found with real data on 2026-10-24: deposits named only by the user's own name (no IBAN in the bank data) and a spouse's monthly contributions to shared costs were reported as income. Use synthetic names in fixtures.
- Implemented in session 033 (D-033). Choices beyond the criteria: the lists and the toggle are `app_settings` keys (no new tables); "another person's known IBAN" is read as a household member's IBAN; only the counterparty name is compared, not the description (a member's IBAN in the description counts since F-036, [FIN-036](FIN-036-household-ibans-in-texts.md)); the `household` mark is set on manual transactions too (it changes no category); removing an own name does not unlink the transfers it linked; a name that is both an own name and a member's is refused; the toggle is saved separately from the lists and needs no re-run.
