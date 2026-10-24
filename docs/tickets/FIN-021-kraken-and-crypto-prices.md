# FIN-021: Kraken holdings and crypto prices

**Feature:** F-021 · **Milestone:** M4 Investments · **Area:** investments · **Depends on:** [F-019](FIN-019-investment-data-model.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-021`. This ticket is the spec the session reads first.

## Goal

`KrakenProvider` signs private REST calls (HMAC-SHA512 with a nonce) with a read-only key from `KRAKEN_API_KEY` / `KRAKEN_API_SECRET`, maps `BalanceEx` to holdings and `Ledgers` to investment transactions (deposits, withdrawals, trades, staking); manual holdings cover wallets without an API; CoinGecko prices are added to the price-update job; crypto appears on `/investments` and in net worth.

## Acceptance criteria

- Key needs only Query Funds, Query Open/Closed Orders & Trades and Query Ledger Entries; never trading, deposit or withdrawal
- Stored keys encrypted with `src/server/crypto.ts`

## Tests (what the verification proves)

- **L1** `tests/unit/investments/kraken.test.ts`: signature against Kraken's documented example; BalanceEx and Ledgers mapping from fixtures
- **L2** `tests/integration/crypto-holdings.int.test.ts`: holdings and prices stored; a manual holding is valued
- **L3** `tests/e2e/investments.spec.ts`: a manual crypto holding saved through the form is valued and counted in net worth (added in session 016)

## Notes

- Replaces old FIN-024. See [research: Kraken](../api-access-research.md#3-kraken-crypto).
- Implemented in session 016 (D-018). Choices made without a human: the env key pair is stored as one encrypted `kraken` connection (re-encrypted when the key changes); the client can only call `BalanceEx` and `Ledgers`; holdings come from `BalanceEx` (staked balances folded in), the ledger fills `investment_transactions`; Kraken syncs every 6 hours (`kraken-sync`), crypto prices run in the daily `price-update`; CoinGecko without a key by default (`COINGECKO_API_KEY` optional); manual holdings are a form on `/investments` with one `crypto` account per wallet under the `manual` institution.
- Deviation: verification gained an L3 step (`tests/e2e/investments.spec.ts`: the manual-holding form, valued and in net worth), because the form crosses UI and server (AGENTS.md → Verification layers). Non-EUR fiat on Kraken is not tracked, and coins outside `src/server/investments/coins.ts` stay unpriced (D-018 → Known limits).
- The fixtures under `tests/fixtures/kraken/` are synthetic, built from Kraken's documented response shapes; a real account may show ledger types or asset codes the mapping skips.
