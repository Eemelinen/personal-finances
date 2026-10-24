import {
  boolean,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./banking";
import { categories } from "./categories";
import { amountMinor, currency, timestamps } from "./columns";

export const transactionStatus = pgEnum("transaction_status", [
  "booked",
  "pending",
]);

export const categorySource = pgEnum("category_source", [
  "none",
  "rule",
  "manual",
]);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** The provider's transaction id, when it has a stable one. */
    providerTxnRef: text(),
    /** `dedupeHash()` from `src/server/dedupe-hash.ts`; the fallback identity. */
    dedupeHash: text().notNull(),
    bookingDate: date({ mode: "string" }).notNull(),
    valueDate: date({ mode: "string" }),
    /** Signed: negative is money out. */
    amountMinor: amountMinor().notNull(),
    currency: currency().notNull(),
    counterparty: text(),
    /** The counterparty's IBAN, normalised, when the bank gives it (F-028). */
    counterpartyIban: text(),
    description: text(),
    status: transactionStatus().notNull().default("booked"),
    categoryId: uuid().references(() => categories.id, {
      onDelete: "set null",
    }),
    categorySource: categorySource().notNull().default("none"),
    /** The user's own note (F-015); syncs and imports never write it. */
    note: text(),
    /** Shared by the two legs of a transfer between own accounts (F-014). */
    transferGroupId: uuid(),
    /**
     * The counterparty is a household member (F-030): left out of the
     * reports while `ignoreHouseholdTransfers` is on. Categorisation sets it.
     */
    household: boolean().notNull().default(false),
    ...timestamps,
  },
  // Idempotency: a re-sync or re-import of the same transaction is rejected
  // (or upserted) per account. NULL provider refs do not collide.
  (t) => [
    unique("transactions_account_id_provider_txn_ref_unique").on(
      t.accountId,
      t.providerTxnRef,
    ),
    unique("transactions_account_id_dedupe_hash_unique").on(
      t.accountId,
      t.dedupeHash,
    ),
    index().on(t.accountId, t.bookingDate),
    index().on(t.categoryId),
    index().on(t.transferGroupId),
  ],
);
