# FIN-035: Name-variant suggestions in Settings → Household

**Feature:** F-035 · **Milestone:** M6 Data correctness · **Area:** categorization · **Depends on:** [F-030](FIN-030-own-names-and-household.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-035`. This ticket is the spec the session reads first.

## Goal

Banks write the same person's name in many ways: in full, surname first, or with initials (`M MEIKÄLÄINEN`, `M.M. Meikäläinen`), and a joint account under both holders' names. F-030 matches only whole names, by design, so every spelling has to be typed into Settings → Household before it counts as an own transfer or a household row. Until it is, those transfers count as income or spending. Settings → Household lists the counterparties that look like a saved name with initials, or like a joint name of two saved names, and adds one to the right person with a click. Nothing is matched automatically: a relative with the same surname is never caught by mistake.

## Acceptance criteria

- A pure function in `src/server/categorization/names.ts`, next to `normalizeName()`, says whether a counterparty is an initials variant of a saved name: the same surname (a word of the saved name), in either word order; each other word is one of the saved name's other words or its initial, with or without a dot (`M.M.` is two initials); at least one such word; and it is not already the saved name itself (whole-name matching covers that). Which word is the surname is not known, so any word of the saved name may play that part. Accents are kept as in `normalizeName()`
- A joint-holder name counts when it splits on a connector into two parts and each part is a saved name or an initials variant of one; connectors: `ja`, `och`, `and`, `&`, `/`, `+` and `CJ` (seen in real S-Pankki data on a joint account)
- A query returns the suggestions: distinct counterparties of transactions that are not manual, not in a transfer group and not `household`, which are an initials variant or joint name of an own name or of a household member's name, each with the person it belongs to, the number of rows and their credit and debit sums, largest first
- `/settings/household` shows them under "Possible name variants" (hidden when there are none). Each has "Add to your names" or "Add to <member's first name>"; its Server Action (behind `verifySession()`) appends the counterparty as typed to that list and saves through `saveHousehold()` (`src/server/categorization/household.ts`), which re-runs categorisation, and the page reports what changed as the household form does. A joint name of two own names goes to your names; one that involves a member goes to the member
- A name that differs from every saved name in a given name (`Maija Meikäläinen` against `Matti Meikäläinen`) is never suggested; neither is a counterparty that only contains a saved name (`Meikäläinen Oy`, `Matti Meikäläinen Tmi`)
- `README.md` mentions the suggestions; FIN-030's notes point here

## Tests (what the verification proves)

- **L1** `tests/unit/categorization/names.test.ts`: initials with and without dots, surname first and last, two initials, a joint name with each connector, a relative with the same surname and another given name, a company with the surname, the saved name itself (not suggested)
- **L2** `tests/integration/household.int.test.ts`: the suggestion query leaves out manual, grouped and household rows and returns the right person, count and sums
- **L3** `tests/e2e/household-settings.spec.ts`: a suggested initials variant is added with its button and its transactions then show as Transfers

## Notes

- Found with real data on 2026-10-25: with both partners' full names saved as own names, 36 rows written with initials (`<initial> <SURNAME>`, `<initials>. <Surname>`) or under the joint account's name (`<initials>. <Surname> CJ <initial>. <Surname>`) were still uncategorised and counted as about €58k of income. Use synthetic names in fixtures.
- Implemented in session 2026-10-25 (D-033 amended). Choices beyond the criteria:
  - `nameVariantParts()` returns, per part, every saved name it fits, so a variant that fits two people (`M Meikäläinen` for Matti and Maija) gets a button for each.
  - A saved name's other words may also be left out, not only shortened (`Matti Meikäläinen` for `Matti Mikael Meikäläinen`). The surname is any one word of the saved name, kept whole.
  - Spellings with the same words (`M MEIKÄLÄINEN`, `M. Meikäläinen`) are one suggestion under the most frequent spelling, since one variant covers them all. Sums count EUR rows only.
  - A joint name that involves members goes to each member involved, usually one.
  - The member button reads "Add to <the member's first name variant>", for example "Add to Liisa Virtanen", rather than the first word: a name written surname first would give the surname.
  - The suggestions sit between the toggle and the lists. After a suggestion is added, the lists form shows the saved lists, so saving it cannot drop the variant again; it does the same after its own save, showing the lists as stored.
