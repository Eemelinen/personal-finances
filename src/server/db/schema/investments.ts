import {
  char,
  check,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./banking";
import { amountMinor, currency, timestamps } from "./columns";

// Investments (F-019, D-016): the assets held, per-account quantity
// snapshots, investment transactions, daily prices and ECB exchange rates.
// Brokerage and crypto accounts are rows in `accounts` (type `brokerage` /
// `crypto`), so net worth spans every account type.

/**
 * Exact decimals for quantities, unit prices and FX rates: 18 decimals
 * (crypto amounts go to 18), 20 integer digits. Read and written as strings,
 * never as JS numbers.
 */
export const decimal = () => numeric({ precision: 38, scale: 18 });

export const assetClass = pgEnum("asset_class", [
  "stock",
  "etf",
  "fund",
  "crypto",
  "other",
]);

export const investmentTransactionType = pgEnum("investment_transaction_type", [
  "buy",
  "sell",
  "dividend",
  "fee",
  "transfer",
]);

export const assets = pgTable(
  "assets",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Ticker or coin symbol as shown, e.g. `NOKIA`, `IWDA`, `BTC`. */
    symbol: text().notNull(),
    name: text(),
    /** Securities; null for crypto. */
    isin: char({ length: 12 }),
    /** Crypto price feed id, e.g. `bitcoin`; null for securities. */
    coingeckoId: text(),
    assetClass: assetClass().notNull(),
    /** The currency the asset is quoted in. */
    currency: currency().notNull(),
    ...timestamps,
  },
  // NULLs never collide, so many assets can lack an ISIN or CoinGecko id.
  (t) => [
    unique("assets_isin_unique").on(t.isin),
    unique("assets_coingecko_id_unique").on(t.coingeckoId),
    index().on(t.symbol),
  ],
);

export const holdings = pgTable(
  "holdings",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    assetId: uuid()
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    /** Calendar day the quantity was observed or derived for. */
    date: date({ mode: "string" }).notNull(),
    /** Units held at the end of `date`; 0 once sold out. */
    quantity: decimal().notNull(),
    ...timestamps,
  },
  // One quantity per account, asset and day: imports and syncs upsert on it.
  // The quantity holds until the account's next snapshot of the asset.
  (t) => [
    unique("holdings_account_id_asset_id_date_unique").on(
      t.accountId,
      t.assetId,
      t.date,
    ),
    index().on(t.assetId),
    check("holdings_quantity_not_negative", sql`${t.quantity} >= 0`),
  ],
);

export const investmentTransactions = pgTable(
  "investment_transactions",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Null for cash-only rows (a deposit or an account fee). */
    assetId: uuid().references(() => assets.id, { onDelete: "restrict" }),
    type: investmentTransactionType().notNull(),
    /** The provider's id when it has a stable one (Kraken ledger id). */
    providerTxnRef: text(),
    /** Fallback identity for imports, as `transactions.dedupe_hash`. */
    dedupeHash: text().notNull(),
    tradeDate: date({ mode: "string" }).notNull(),
    /** Signed change in units held: + bought or received, − sold or sent. */
    quantity: decimal(),
    /** Signed cash effect in integer minor units: − paid, + received. */
    amountMinor: amountMinor().notNull(),
    currency: currency().notNull(),
    description: text(),
    ...timestamps,
  },
  (t) => [
    unique("investment_transactions_account_id_provider_txn_ref_unique").on(
      t.accountId,
      t.providerTxnRef,
    ),
    unique("investment_transactions_account_id_dedupe_hash_unique").on(
      t.accountId,
      t.dedupeHash,
    ),
    index().on(t.accountId, t.tradeDate),
    index().on(t.assetId),
  ],
);

export const prices = pgTable(
  "prices",
  {
    id: uuid().primaryKey().defaultRandom(),
    assetId: uuid()
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    date: date({ mode: "string" }).notNull(),
    /**
     * Closing price of one unit in minor units of `currency`. A decimal, not
     * an integer: unit prices (a fund share, a small coin) go below a cent.
     */
    priceMinor: decimal().notNull(),
    currency: currency().notNull(),
    /** Where the price came from, e.g. `twelve_data`, `coingecko`, `manual`. */
    source: text().notNull(),
    ...timestamps,
  },
  (t) => [
    unique("prices_asset_id_date_unique").on(t.assetId, t.date),
    check("prices_price_minor_not_negative", sql`${t.priceMinor} >= 0`),
  ],
);

export const fxRates = pgTable(
  "fx_rates",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** ECB reference day (working days only). */
    date: date({ mode: "string" }).notNull(),
    /** The quoted currency; the base is always EUR. */
    currency: currency().notNull(),
    /** Units of `currency` per 1 EUR, as the ECB publishes it. */
    rate: decimal().notNull(),
    ...timestamps,
  },
  (t) => [
    unique("fx_rates_date_currency_unique").on(t.date, t.currency),
    check("fx_rates_rate_positive", sql`${t.rate} > 0`),
  ],
);
