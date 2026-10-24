import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { addDays, localDate } from "@/server/dates";
import { getDb, type Db } from "@/server/db/client";
import {
  connections,
  institutions,
  notifications,
  syncRuns,
} from "@/server/db/schema";
import type { Env } from "@/server/env";
import { BANK_PROVIDER_IDS } from "@/server/providers/types";
import {
  createNotifier,
  type Issue,
  type NotificationStore,
  type NotifyResult,
} from "./notifier";

// What the worker's `notifications` job notifies about (F-024), checked
// against the database each run:
//
// - `sync-failing:<id>`: an active connection's last `failedSyncs` syncs
//   failed. A sync fails in exactly one run (balances, or the transactions /
//   holdings after them), so the count is the failed runs since the last
//   succeeded final step (`transactions` or `holdings`; untyped runs from
//   before F-010 count as complete syncs).
// - `consent-expiring:<id>`: a bank connection's consent ends within
//   `CONSENT_NOTICE_DAYS`.
// - `consent-expired:<id>`: the consent has ended, or the bank stopped
//   accepting it (`expired` / `revoked`), as in the consent banner (F-011).
//
// Archived connections are never synced and so never notify. Each key is
// sent at most once a day (notifier.ts), so a lasting issue repeats daily
// until it is fixed.

/** How close to its end a consent notifies (the banner warns earlier). */
export const CONSENT_NOTICE_DAYS = 7;

const DAY_MS = 86_400_000;

/** Days of sent notifications kept; older rows are pruned. */
const NOTIFICATION_HISTORY_DAYS = 30;

/** `d.m.yyyy` of `instant` in `timeZone`. */
function finnishDay(instant: Date, timeZone: string): string {
  const [year, month, day] = localDate(instant, timeZone).split("-");
  return `${Number(day)}.${Number(month)}.${year}`;
}

export interface FindIssuesOptions {
  db?: Db;
  now?: () => Date;
  timeZone: string;
  /** Failed syncs in a row that make an issue (`NOTIFY_FAILED_SYNCS`). */
  failedSyncs: number;
}

/** Every current issue, failing syncs first. */
export async function findIssues(options: FindIssuesOptions): Promise<Issue[]> {
  const db = options.db ?? getDb();
  const now = (options.now ?? (() => new Date()))();
  return [
    ...(await failingSyncIssues(db, options.failedSyncs)),
    ...(await consentIssues(db, now, options.timeZone)),
  ];
}

async function failingSyncIssues(
  db: Db,
  failedSyncs: number,
): Promise<Issue[]> {
  const lastComplete = db
    .select({
      connectionId: syncRuns.connectionId,
      at: sql<Date>`max(${syncRuns.startedAt})`.as("at"),
    })
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.status, "succeeded"),
        or(
          inArray(syncRuns.kind, ["transactions", "holdings"]),
          isNull(syncRuns.kind),
        ),
      ),
    )
    .groupBy(syncRuns.connectionId)
    .as("last_complete");

  const rows = await db
    .select({
      connectionId: connections.id,
      institution: institutions.name,
      failed: sql<number>`count(*)::int`,
      lastError: sql<
        string | null
      >`(array_agg(${syncRuns.error} order by ${syncRuns.startedAt} desc))[1]`,
    })
    .from(syncRuns)
    .innerJoin(connections, eq(connections.id, syncRuns.connectionId))
    .innerJoin(institutions, eq(institutions.id, connections.institutionId))
    .leftJoin(
      lastComplete,
      eq(lastComplete.connectionId, syncRuns.connectionId),
    )
    .where(
      and(
        eq(connections.status, "active"),
        eq(syncRuns.status, "failed"),
        or(
          isNull(lastComplete.at),
          sql`${syncRuns.startedAt} > ${lastComplete.at}`,
        ),
      ),
    )
    .groupBy(connections.id, institutions.name)
    .orderBy(institutions.name, connections.id);

  return rows
    .filter((row) => row.failed >= failedSyncs)
    .map((row) => ({
      key: `sync-failing:${row.connectionId}`,
      title: `${row.institution}: sync failing`,
      message: `The last ${row.failed} syncs of ${row.institution} failed. Latest error: ${row.lastError ?? "unknown"}. See the sync log on Connections.`,
      priority: "high",
      tags: ["warning"],
    }));
}

async function consentIssues(
  db: Db,
  now: Date,
  timeZone: string,
): Promise<Issue[]> {
  const rows = await db
    .select({
      connectionId: connections.id,
      institution: institutions.name,
      status: connections.status,
      consentExpiresAt: connections.consentExpiresAt,
    })
    .from(connections)
    .innerJoin(institutions, eq(institutions.id, connections.institutionId))
    .where(
      and(
        inArray(connections.provider, [...BANK_PROVIDER_IDS]),
        inArray(connections.status, ["active", "expired", "revoked"]),
      ),
    )
    .orderBy(institutions.name, connections.id);

  const issues: Issue[] = [];
  for (const row of rows) {
    const endsAt = row.consentExpiresAt?.getTime();
    if (
      row.status !== "active" ||
      (endsAt !== undefined && endsAt <= now.getTime())
    ) {
      issues.push({
        key: `consent-expired:${row.connectionId}`,
        title: `${row.institution}: consent expired`,
        message: `The bank consent of ${row.institution} has ended, so it is no longer synced. Renew the connection on Connections.`,
        priority: "high",
        tags: ["rotating_light"],
      });
    } else if (
      endsAt !== undefined &&
      endsAt - now.getTime() <= CONSENT_NOTICE_DAYS * DAY_MS
    ) {
      issues.push({
        key: `consent-expiring:${row.connectionId}`,
        title: `${row.institution}: consent ending`,
        message: `The bank consent of ${row.institution} ends on ${finnishDay(row.consentExpiresAt!, timeZone)}. Renew the connection on Connections before then.`,
        tags: ["hourglass"],
      });
    }
  }
  return issues;
}

/** The sent notifications in the `notifications` table. */
export function dbNotificationStore(db: Db): NotificationStore {
  return {
    async claim(issue, day) {
      const inserted = await db
        .insert(notifications)
        .values({ issue, day })
        .onConflictDoNothing()
        .returning({ issue: notifications.issue });
      return inserted.length > 0;
    },
    async release(issue, day) {
      await db
        .delete(notifications)
        .where(and(eq(notifications.issue, issue), eq(notifications.day, day)));
    },
  };
}

export type NotificationsEnv = Pick<
  Env,
  "APP_TIMEZONE" | "NTFY_URL" | "NTFY_TOKEN" | "NOTIFY_FAILED_SYNCS"
>;

/**
 * Finds the current issues and sends the ones not sent today; null when
 * `NTFY_URL` is unset (nothing is checked).
 */
export async function sendNotifications(
  env: NotificationsEnv,
  options: { db?: Db; now?: () => Date; fetch?: typeof fetch } = {},
): Promise<NotifyResult | null> {
  const db = options.db ?? getDb();
  const now = options.now ?? (() => new Date());
  const notifier = createNotifier({
    url: env.NTFY_URL,
    token: env.NTFY_TOKEN,
    store: dbNotificationStore(db),
    timeZone: env.APP_TIMEZONE,
    now,
    fetch: options.fetch,
  });
  if (!notifier.enabled) return null;

  const today = localDate(now(), env.APP_TIMEZONE);
  await db
    .delete(notifications)
    .where(lt(notifications.day, addDays(today, -NOTIFICATION_HISTORY_DAYS)));
  const issues = await findIssues({
    db,
    now,
    timeZone: env.APP_TIMEZONE,
    failedSyncs: env.NOTIFY_FAILED_SYNCS,
  });
  return notifier.notify(issues);
}
