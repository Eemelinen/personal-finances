import { date, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { timestamps } from "./columns";

/**
 * The notifications the worker has sent (F-024), one row per issue and
 * calendar day (`APP_TIMEZONE`): the notifier claims the row before it
 * sends, so an issue is sent at most once a day, also across restarts.
 * `issue` is the issue's key, e.g. `consent-expiring:<connection id>`;
 * `created_at` is when it was claimed.
 */
export const notifications = pgTable(
  "notifications",
  {
    issue: text().notNull(),
    day: date({ mode: "string" }).notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.issue, t.day] })],
);
