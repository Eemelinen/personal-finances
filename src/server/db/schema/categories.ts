import {
  type AnyPgColumn,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { amountMinor, timestamps } from "./columns";

// Spending/income categories (two levels) and the rules that assign them.

export const categoryKind = pgEnum("category_kind", [
  "expense",
  "income",
  "transfer",
  "excluded",
]);

export const ruleMatchField = pgEnum("rule_match_field", [
  "counterparty",
  "description",
]);

export const ruleMatchType = pgEnum("rule_match_type", [
  "contains",
  "equals",
  "regex",
]);

/** Which way the money moves: `debit` is out (negative), `credit` in. */
export const ruleAmountSign = pgEnum("rule_amount_sign", ["debit", "credit"]);

export const categories = pgTable(
  "categories",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    parentId: uuid().references((): AnyPgColumn => categories.id, {
      onDelete: "cascade",
    }),
    kind: categoryKind().notNull(),
    /** CSS colour, e.g. `#4f46e5`. */
    color: text(),
    ...timestamps,
  },
  // NULLS NOT DISTINCT: top-level names are unique too, so seeding can upsert.
  (t) => [
    unique("categories_parent_id_name_unique")
      .on(t.parentId, t.name)
      .nullsNotDistinct(),
  ],
);

export const categoryRules = pgTable(
  "category_rules",
  {
    id: uuid().primaryKey().defaultRandom(),
    categoryId: uuid()
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    matchField: ruleMatchField().notNull(),
    matchType: ruleMatchType().notNull(),
    pattern: text().notNull(),
    /** Optional: only debits or only credits. */
    amountSign: ruleAmountSign(),
    /** Optional inclusive bounds on the absolute amount, in minor units. */
    amountMinMinor: amountMinor(),
    amountMaxMinor: amountMinor(),
    /** Lower runs first; the first matching rule wins (F-014). */
    priority: integer().notNull().default(100),
    ...timestamps,
  },
  (t) => [index().on(t.categoryId), index().on(t.priority)],
);
