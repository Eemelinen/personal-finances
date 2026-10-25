# FIN-036: Household IBANs found in description text

**Feature:** F-036 · **Milestone:** M6 Data correctness · **Area:** categorization · **Depends on:** [F-030](FIN-030-own-names-and-household.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-036`. This ticket is the spec the session reads first.

## Goal

Some bank rows carry no counterparty name and no `counterparty_iban`, only the other account's IBAN in the description. Own-transfer detection already finds an own account's IBAN in the counterparty or description text (`findTransfers()` in `src/server/categorization/transfers.ts`), but household matching (F-030) looks only at the counterparty name and `counterparty_iban`. So a transfer with a household member's account written only in the text is neither marked `household` nor left out of the reports. Household matching finds member IBANs in the texts the same way.

## Acceptance criteria

- The text search in `findTransfers()` (the normalised `counterparty|description` contains an IBAN of at least `MIN_IBAN_LENGTH` characters) moves to one exported helper that both transfer detection and household matching use; transfer behaviour is unchanged
- `householdMatcher()` (`src/server/categorization/names.ts`): `isHousehold` is true when the counterparty name is a member's, when `counterpartyIban` is a member's IBAN, or, when `counterpartyIban` is null, when the counterparty or description text contains a member's IBAN. A `counterpartyIban` that belongs to someone else wins over an IBAN in the text, as in transfer detection
- `isOwnName` uses the same `isHousehold`, so an own-name leg whose text names a member's IBAN is a household row, not an own transfer
- `HouseholdLeg` gets `description`, and the categorisation scope `markHousehold()` / `linkOwnNames()` read in `categorize.ts` selects it
- FIN-030's notes, the comment at the top of `names.ts` and `README.md` are updated

## Tests (what the verification proves)

- **L1** `tests/unit/categorization/names.test.ts`: a member IBAN in the description, written with spaces or lower case; a `counterpartyIban` of another person wins over a member IBAN in the text; an IBAN shorter than `MIN_IBAN_LENGTH` is not searched for
- **L1** `tests/unit/categorization/transfers.test.ts`: the existing text cases still pass through the shared helper
- **L2** `tests/integration/household.int.test.ts`: saving a member whose IBAN appears only in a stored row's description marks that row `household`, and it leaves the cash-flow totals while the toggle is on

## Notes

- Found with real data on 2026-10-25: 72 rows on a connected checking account had an empty counterparty and only the other account's IBAN in the description. They were the user's own account and are handled by F-029, but a household member's account written the same way would not be found. Use synthetic IBANs (valid check digits) in fixtures.
