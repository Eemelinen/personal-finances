# API access research: banks, Nordnet and Kraken

_Researched 2026-10-23. Provider terms change often, so recheck before relying on anything below. Items marked **(unverified)** come from third-party sources only._

## Summary

| Source                    | Free API access for personal use?                        | Recommended route                                                  | Ticket(s)         |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ | ----------------- |
| **Nordea** (FI)           | Yes, via Enable Banking restricted production mode       | Enable Banking (PSD2 AIS), with CSV import as fallback             | FIN-001, 006, 012 |
| **S-Pankki**              | Yes, via Enable Banking restricted production mode       | Enable Banking (PSD2 AIS), with CSV import as fallback             | FIN-001, 006, 012 |
| **Nordnet** (investments) | No. The official API is not onboarding new customers.    | CSV export of transactions → import. Prices from a free price API. | FIN-020           |
| **Kraken** (crypto)       | Yes. The official REST API is free, with read-only keys. | Kraken REST API, using a key limited to query permissions          | FIN-021           |

## 1. Banks: Nordea and S-Pankki

### Why an aggregator is needed

Nordea and S-Pankki expose PSD2 APIs, but production access is only for **licensed third-party providers** (AISPs). An individual can use Nordea's developer portal sandbox, but cannot get production access to their own accounts directly. The practical route is an aggregator that holds the license and lets you connect your own accounts.

### Options compared

| Provider                                   | Free?                          | What's free                                                                                                                             | Nordea FI / S-Pankki | Verdict                                  |
| ------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------- |
| **Enable Banking**                         | **Yes**, for your own accounts | Sandbox, plus **restricted production**: real data, but only for accounts you link yourself in their control panel. No contract needed. | ✅ / ✅              | **Use this.**                            |
| GoCardless Bank Account Data (ex-Nordigen) | Was free                       | Was a generous free tier of real data                                                                                                   | ✅ / ✅              | ❌ Closed to new signups since July 2025 |
| Tink (Visa)                                | No                             | Sandbox only. Production is usage-based and sold to businesses.                                                                         | ✅ / ✅              | ❌ Business contract needed              |
| Yapily                                     | No                             | Sandbox only (test data). Production is sales-led.                                                                                      | partial              | ❌                                       |
| Salt Edge                                  | No                             | Test mode. Production is quoted per customer.                                                                                           | ✅                   | ❌                                       |
| TrueLayer                                  | No                             | Sandbox. Production is sales-led.                                                                                                       | limited              | ❌                                       |
| Nordea Open Banking (direct)               | Sandbox only                   | Sandbox APIs. Production needs a TPP license.                                                                                           | Nordea only          | ❌ for production                        |
| **Bank CSV export**                        | **Yes**                        | Manual export from netbank                                                                                                              | ✅ / ✅              | ✅ Fallback, and for older history       |

### Enable Banking details

- **Restricted production mode.** Create a production application in the Enable Banking control panel and **link your own accounts there**. The API then only returns those linked accounts. It is free and needs no contract, but it is limited to **personal, non-commercial use**, so it can't be offered to other users. This app is single-user and self-hosted, which fits.
- **Full production** (other users' accounts) needs a contract, KYB and a quote. We don't need it.
- **Coverage.** Its Finland page lists all major Finnish banks: OP, Nordea, S-Pankki, Danske Bank, Säästöpankki and Aktia. Personal accounts are supported for both of our banks, and both have sandboxes.
- **Authentication.** Your application signs a JWT (RS256) with its private key. The bank's own authentication happens in its app: Nordea asks for your 8-digit user ID and then the **Nordea ID** app; S-Pankki uses its own app or credentials.
- **Consent length.** Up to each bank's `maximum_consent_validity`, about **180 days** for most banks **(unverified)**. Renewal is needed after that (FIN-011).
- **Fetch limits.** Background (unattended) fetches are reportedly limited to about **4 per day per bank** **(unverified)**. The default 6-hour sync schedule in FIN-010 fits within that.
- **To confirm in FIN-001:** exact limits, transaction history depth per bank, and whether pending transactions are returned.

## 2. Nordnet (stocks, funds, osakesäästötili)

| Route                                | Status                                                                                                                                                                                                                                               | Verdict                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Official Nordnet External API v2** | Nordnet's own docs say the API is **not onboarding new customers** at the moment. Where access exists, it is tied to one account chosen at application time. A key reportedly gives **full trading access with no read-only mode** **(unverified)**. | ❌ Not available now, and risky if it were |
| **PSD2 via aggregator**              | Nordnet Bank AB Suomen sivuliike is listed as a PSD2 bank, with Tink as an aggregator **(unverified)**. Enable Banking support is not confirmed. PSD2 only covers the **cash account**, not securities holdings.                                     | ❌ Doesn't give holdings                   |
| **CSV export → import**              | In Nordnet: _Sivuni → Tapahtumat ja laskelmat_, choose the date range, then **Vie CSV-tiedostoon**. Tools like Sharesight, Snowball and Portfolio Performance import this format. Later imports can cover only the period since the last upload.     | ✅ **Recommended**                         |
| Unofficial / scraped web API         | Needs login credentials and breaks without warning. May violate the terms of service.                                                                                                                                                                | ❌ Not recommended                         |

**Plan for FIN-020:** import Nordnet transaction CSVs (buys, sells, dividends, fees, deposits), compute holdings from the transactions, and value them with daily prices from a free price API (e.g. Twelve Data or Alpha Vantage free tier). Recheck the Nordnet API status when the ticket starts.

## 3. Kraken (crypto)

The **official Kraken REST API is free** to use with any Kraken account.

- **Create a dedicated read-only key** (_Settings → API_) with only these permissions:

  | Permission                   | Endpoints it unlocks                                                         |
  | ---------------------------- | ---------------------------------------------------------------------------- |
  | Query Funds                  | `Balance`, `BalanceEx`, `TradeBalance`                                       |
  | Query Open Orders & Trades   | `OpenOrders`, `QueryOrders`, `TradesHistory`, `QueryTrades`, `OpenPositions` |
  | Query Closed Orders & Trades | `ClosedOrders`                                                               |
  | Query Ledger Entries         | `Ledgers`, `QueryLedgers` (deposits, withdrawals, trades, staking rewards)   |

  **Never enable** Create & Modify Orders, Cancel/Close Orders, Deposit Funds or Withdraw Funds.

- **Extra hardening.** Kraken supports **IP whitelisting** per key, so restrict the key to your home IP. Store it encrypted at rest, like bank sessions.
- **Rate limits.** There is a per-key counter that decays over time. Ledger and trade-history calls cost more (reportedly 2 points vs 1) **(unverified figures)**. A sync every few hours is far below the limit.
- **Prices.** Kraken's public `Ticker` endpoint (no key needed) or CoinGecko, both free.

**Plan for FIN-021:** a `KrakenProvider` implementing `getHoldings()` from `BalanceEx`, with ledger history from `Ledgers` for cost basis and performance.

## Sources

- [Enable Banking: Open Banking specifics in Finland](https://enablebanking.com/docs/markets/fi/)
- [Enable Banking: S-Pankki API availability](https://enablebanking.com/open-banking-apis/FI25573083)
- [Open Banking Tracker: Free & indie open banking APIs (2026)](https://www.openbankingtracker.com/guides/free-open-banking-apis)
- [DEV: Building a personal finance app with open banking APIs in 2026](https://dev.to/johnfrandsen/building-a-personal-finance-app-with-open-banking-apis-in-2026-no-certificates-required-31fh)
- [DEV: Free signup vs production access, what self-serve PSD2 providers gate](https://dev.to/johnfrandsen/free-signup-vs-production-access-what-self-serve-psd2-providers-actually-gate-306p)
- [DEV: GoCardless Bank Account Data alternatives](https://dev.to/johnfrandsen/gocardless-bank-account-data-alternatives-what-to-use-when-signups-are-disabled-326d)
- [Actual Budget docs: GoCardless bank sync (signups stopped July 2025)](https://actualbudget.org/docs/advanced/bank-sync/gocardless/)
- [GitHub: banks-cli, read-only balances via Enable Banking](https://github.com/jgalea/banks-cli)
- [GitHub: TrackMyWealth spike on Enable Banking for own accounts](https://github.com/hugiFreezy0815/TrackMyWealth/issues/263)
- [Nordnet External API: Getting started](https://www.nordnet.se/externalapi/docs/getting_started)
- [GitHub: StockApp broker API roadmap (Nordnet API v2 notes)](https://github.com/NicoSik/StockApp/pull/6)
- [Open Banking Tracker: Nordnet Bank](https://openbankingtracker.com/provider/nordnet-bank)
- [Sharesight: Nordnet import](https://www.sharesight.com/partners/nordnet/)
- [Snowball Analytics: Import from Nordnet](https://help.snowball-analytics.com/import-nordnet/)
- [Kraken: API keys guide (permissions)](https://docs.kraken.com/exchange/guides/rest/api-keys)
- [rotki: Kraken integration (read-only key setup)](https://rotki.com/integrations/kraken)
- [Mesh: Does Kraken have an API? (rate limits)](https://www.meshconnect.com/blog/does-kraken-have-an-api)
