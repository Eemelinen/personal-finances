# FIN-037: Investments left out of spending

**Feature:** F-037 · **Milestone:** M6 Data correctness · **Area:** categorization · **Depends on:** [F-026](FIN-026-income-from-income-categories.md), [F-034](FIN-034-transactions-totals-like-reports.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-037`. This ticket is the spec the session reads first.

## Goal

Money put into investments is not spending, and money taken out of them is not income: it moves between the user's own cash and their own holdings. Today only the seeded rule "counterparty contains Nordnet" puts such payments into Savings & investments › Investments (kind `transfer`, left out of every report). Fund subscriptions, whose counterparty is the fund's name, and deposits to a crypto exchange, whose counterparty is the exchange's legal entity, stay uncategorised and count as spending. A setting in Settings → Reports, "Leave investments out of spending and income", recognises investments from a built-in list and puts them into Investments, so the user does not have to write a rule for every fund and exchange.

## Acceptance criteria

- Setting `excludeInvestments` (boolean, default `false`, which keeps today's behaviour) in `SETTINGS` in `src/server/settings.ts`. Settings → Reports (`/settings/reports`) shows it with a short explanation and the list of what is recognised. Saving it re-runs categorisation (`reapplyRules()`) and the page says how many transactions changed category
- A pure matcher in `src/server/categorization/investments.ts` says whether a transaction is an investment. Its built-in lists are exported constants, documented in the module:
  - brokers and crypto exchanges, by counterparty: at least Nordnet, Kraken and its legal entity Payward, Coinbase, Bitstamp, Binance, eToro, Degiro, Interactive Brokers, Lightyear and Trade Republic;
  - fund companies, by counterparty: at least Seligson, Evli, OP-Rahastoyhtiö, Danske Invest, Aktia Rahastoyhtiö, S-Pankki Rahastoyhtiö and Nordea Rahastot / Nordea Funds;
  - fund subscriptions and redemptions, by a whole word in the description: `MERKINTÄ`, `rahastomerkintä`, `LUNASTUS`, `rahastolunastus`.
  - Matching ignores case and needs whole words, so `Nordea Bank Oyj` (bank fees) and a counterparty that only contains one of the names inside a longer word never match.
- Categorisation (`src/server/categorization/categorize.ts`): while the setting is on, a transaction that is not manual, in no transfer group and matched by no user rule, and that the matcher calls an investment, gets the category Savings & investments › Investments with source `rule`.
  - A user rule always wins, because it is tried first.
  - The category is created on demand when it is missing, as `createTransfersCategory()` does for Transfers.
  - While the setting is off, categorisation is exactly as today. Turning it off and re-running gives those rows back their rule outcome.
  - Both directions are left out of income, spending, cash flow and the dashboard, since Investments is a transfer-kind category. Balances are unchanged.
- `/transactions` "Not counted" (F-034) names rows in a transfer-kind category other than Transfers, such as Investments, as "investments", separately from own transfers, through a new `leftOut` reason in `flowParts()` (`src/server/queries/reports.ts`).
- The sync and CSV import hook categorise new rows the same way, because they go through `categorizeTransactions()`.
- `docs/DECISIONS.md` gets a decision entry. `README.md` describes the setting.

## Tests (what the verification proves)

- **L1** `tests/unit/categorization/investments.test.ts`: each list matches (broker, exchange entity, fund company, a subscription word in the description); case is ignored; `Nordea Bank Oyj`, a longer word containing a name and an ordinary shop do not match
- **L1** `tests/unit/settings/app-settings.test.ts`: the new key's default and type
- **L2** `tests/integration/investments.int.test.ts`:
  - with the setting off, a fund subscription and an exchange deposit count as spending;
  - on, both are Investments and leave the cash-flow report's expenses, and a withdrawal from an exchange is not income;
  - a user rule targeting another category wins, and a manual category is untouched;
  - turning the setting off restores the rows;
  - `listTransactions()` reports them under the "investment" reason.
- **L3** `tests/e2e/settings-reports.spec.ts`: turning the setting on in Settings → Reports lowers this month's expenses by a seeded fund subscription and shows how many transactions changed. The spec restores the setting afterwards.

## Notes

- Found with real data on 2026-10-25: index-fund subscriptions (description `MERKINTÄ …`, counterparty the fund's name) and a deposit to a crypto exchange (counterparty its legal entity) counted as about €2,000 of 2026 spending. Use synthetic counterparties for anything that is not a public company's name.
- A restaurant or shop that happens to share a broker's name would be recognised as an investment while the setting is on. A user rule into its real category fixes that, because user rules win.
