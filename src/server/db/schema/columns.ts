import { bigint, char, timestamp } from "drizzle-orm/pg-core";

// Shared column builders. Column names come from the TS keys via
// `casing: "snake_case"` (drizzle.config.ts and client.ts).

/** Money: integer minor units (cents). Pair it with `currency()`, never use floats. */
export const amountMinor = () => bigint({ mode: "number" });

/** ISO-4217 currency code, e.g. `EUR`. */
export const currency = () => char({ length: 3 });

/** A point in time, always `timestamptz`. */
export const timestamptz = () => timestamp({ withTimezone: true });

/** `created_at` / `updated_at` for mutable tables. */
export const timestamps = {
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
