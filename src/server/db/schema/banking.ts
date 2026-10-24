import {
  boolean,
  char,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { amountMinor, currency, timestamps, timestamptz } from "./columns";

// Institutions, the connections authorised to them, their accounts and the
// daily balance history. `provider` columns hold the provider id
// (`enable_banking`, `csv`, later `kraken`, …) as open text, so a new provider
// needs no migration; F-005 types the ids.

export const connectionStatus = pgEnum("connection_status", [
  "active",
  "expired",
  "revoked",
  "archived",
]);

export const accountType = pgEnum("account_type", [
  "checking",
  "savings",
  "brokerage",
  "crypto",
]);

export const institutions = pgTable(
  "institutions",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    /** ISO-3166 alpha-2, e.g. `FI`. */
    country: char({ length: 2 }).notNull(),
    provider: text().notNull(),
    /** The institution's id at the provider (e.g. the ASPSP name). */
    providerRef: text(),
    ...timestamps,
  },
  (t) => [
    unique("institutions_provider_provider_ref_unique").on(
      t.provider,
      t.providerRef,
    ),
  ],
);

export const connections = pgTable(
  "connections",
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: uuid()
      .notNull()
      .references(() => institutions.id, { onDelete: "restrict" }),
    provider: text().notNull(),
    /** Provider session id, encrypted at rest (F-005 `crypto.ts`). */
    sessionRef: text(),
    status: connectionStatus().notNull().default("active"),
    consentExpiresAt: timestamptz(),
    lastSyncedAt: timestamptz(),
    ...timestamps,
  },
  (t) => [index().on(t.institutionId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Null for manual accounts (CSV import) and after a connection is removed. */
    connectionId: uuid().references(() => connections.id, {
      onDelete: "set null",
    }),
    institutionId: uuid()
      .notNull()
      .references(() => institutions.id, { onDelete: "restrict" }),
    type: accountType().notNull(),
    name: text().notNull(),
    iban: text(),
    currency: currency().notNull(),
    /** The account id at the provider; null for manual accounts. */
    providerAccountRef: text(),
    archived: boolean().notNull().default(false),
    /**
     * When the account's transactions were last synced successfully; the
     * next sync starts 7 days before it (F-009). Null: not synced yet, so
     * the next sync backfills.
     */
    transactionsSyncedAt: timestamptz(),
    ...timestamps,
  },
  (t) => [index().on(t.connectionId), index().on(t.institutionId)],
);

export const balanceSnapshots = pgTable(
  "balance_snapshots",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Calendar day of the balance (`APP_TIMEZONE`), not a timestamp. */
    date: date({ mode: "string" }).notNull(),
    amountMinor: amountMinor().notNull(),
    currency: currency().notNull(),
    /** ISO 20022 balance type as reported by the provider, e.g. `CLBD`, `ITAV`. */
    balanceType: text().notNull(),
    ...timestamps,
  },
  // One snapshot per account, day and balance type: syncs upsert on this key.
  (t) => [
    unique("balance_snapshots_account_id_date_balance_type_unique").on(
      t.accountId,
      t.date,
      t.balanceType,
    ),
  ],
);

/**
 * A bank authorisation the user has started but not finished (F-007): the
 * `state` sent to the bank, as its SHA-256 (the state itself is never
 * stored), and the bank it was sent to. The callback deletes the row it
 * matches, so a state works once; rows past `expires_at` are refused and
 * pruned when the next authorisation starts.
 */
export const bankAuthorizations = pgTable(
  "bank_authorizations",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Hex SHA-256 of the state. */
    stateHash: text().notNull(),
    provider: text().notNull(),
    /** The bank's name at the provider (the ASPSP name, e.g. `Nordea`). */
    aspspName: text().notNull(),
    aspspCountry: char({ length: 2 }).notNull(),
    expiresAt: timestamptz().notNull(),
    ...timestamps,
  },
  (t) => [unique("bank_authorizations_state_hash_unique").on(t.stateHash)],
);
