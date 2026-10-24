import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { timestamps } from "./columns";

/**
 * App-wide preferences (F-026), one row per setting. `key` is a setting
 * name from `src/server/settings.ts`, which owns each value's type and
 * default; a missing row means the default.
 */
export const appSettings = pgTable("app_settings", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  ...timestamps,
});
