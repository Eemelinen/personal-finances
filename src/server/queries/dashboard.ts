import { and, asc, desc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import {
  accounts,
  balanceSnapshots,
  connections,
  institutions,
} from "@/server/db/schema";
import { getEnv } from "@/server/env";
import type { IsoDate } from "@/server/providers/types";
import { balanceTypePreference } from "@/server/sync/balance-types";
import { addDays, localDate } from "@/server/sync/transaction-merge";
import {
  balanceOn,
  dailyBalances,
  dayRange,
  type DailyBalance,
  type SnapshotLike,
} from "./balances";

// Read model of the dashboard overview (F-016): totals, accounts by bank
// with a sparkline, and connection health. Only EUR balances are summed;
// other currencies would need exchange rates.

export const TOTALS_CURRENCY = "EUR";
/** The totals' change compares today with this many days ago. */
export const CHANGE_DAYS = 30;
/** Days in an account's sparkline, today included. */
export const SPARKLINE_DAYS = 90;
/** A consent this close to its expiry is shown as expiring (as in FIN-011). */
export const CONSENT_WARNING_DAYS = 14;

const DAY_MS = 86_400_000;

type AccountType = (typeof accounts.$inferSelect)["type"];
type ConnectionStatus = (typeof connections.$inferSelect)["status"];

const ACCOUNT_TYPE_ORDER: readonly AccountType[] = [
  "checking",
  "savings",
  "brokerage",
  "crypto",
];

export interface Total {
  amountMinor: number;
  /**
   * Today minus `CHANGE_DAYS` ago, over the accounts that had a balance
   * then (an account added since does not count as a gain). Null when none
   * had.
   */
  changeMinor: number | null;
}

export interface DashboardTotals {
  currency: string;
  netWorth: Total;
  checking: Total;
  savings: Total;
}

export interface AccountSummary {
  id: string;
  name: string;
  type: AccountType;
  iban: string | null;
  currency: string;
  /** The display balance today; null before the first snapshot. */
  balance: { amountMinor: number; date: IsoDate; balanceType: string } | null;
  /** No bank connection: filled by CSV imports only. */
  manual: boolean;
  /** The connection's last successful sync; null for manual accounts. */
  lastSyncedAt: Date | null;
  /** `SPARKLINE_DAYS` daily balances ending today, oldest first. */
  sparkline: DailyBalance[];
}

export interface BankGroup {
  /** The institution name; synced and imported accounts of a bank share it. */
  name: string;
  accounts: AccountSummary[];
}

export type ConnectionHealth = "ok" | "expiring" | "expired";

export interface ConnectionSummary {
  id: string;
  institution: string;
  health: ConnectionHealth;
  consentExpiresAt: Date | null;
  lastSyncedAt: Date | null;
}

export interface DashboardOverview {
  today: IsoDate;
  totals: DashboardTotals;
  banks: BankGroup[];
  connections: ConnectionSummary[];
  /** No accounts yet: the page guides to connect a bank or import a CSV. */
  empty: boolean;
}

/**
 * OK, expiring (consent ends within `CONSENT_WARNING_DAYS`) or expired
 * (consent ended, or the connection is `expired` / `revoked` and needs a
 * new authorisation).
 */
export function connectionHealth(
  connection: { status: ConnectionStatus; consentExpiresAt: Date | null },
  now: Date,
): ConnectionHealth {
  if (connection.status !== "active") return "expired";
  const expiresAt = connection.consentExpiresAt?.getTime();
  if (expiresAt === undefined) return "ok";
  if (expiresAt <= now.getTime()) return "expired";
  if (expiresAt - now.getTime() <= CONSENT_WARNING_DAYS * DAY_MS) {
    return "expiring";
  }
  return "ok";
}

interface AccountBalances {
  type: AccountType;
  currency: string;
  today: number | undefined;
  before: number | undefined;
}

/** Sums the EUR accounts' balances today and `CHANGE_DAYS` ago. */
export function sumTotals(
  balances: readonly AccountBalances[],
): DashboardTotals {
  const total = (include: (type: AccountType) => boolean): Total => {
    let amountMinor = 0;
    let changeMinor: number | null = null;
    for (const account of balances) {
      if (account.currency !== TOTALS_CURRENCY || !include(account.type)) {
        continue;
      }
      if (account.today === undefined) continue;
      amountMinor += account.today;
      if (account.before !== undefined) {
        changeMinor = (changeMinor ?? 0) + account.today - account.before;
      }
    }
    return { amountMinor, changeMinor };
  };
  return {
    currency: TOTALS_CURRENCY,
    netWorth: total(() => true),
    checking: total((type) => type === "checking"),
    savings: total((type) => type === "savings"),
  };
}

export interface DashboardOptions {
  db?: Db;
  /** The current time; defaults to the clock. */
  now?: Date;
  /** Whose calendar day "today" is; `APP_TIMEZONE`. */
  timeZone?: string;
}

export async function getDashboardOverview(
  options: DashboardOptions = {},
): Promise<DashboardOverview> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const today = localDate(now, options.timeZone ?? getEnv().APP_TIMEZONE);
  const days = dayRange(today, SPARKLINE_DAYS);
  const windowStart = addDays(
    today,
    -Math.max(SPARKLINE_DAYS - 1, CHANGE_DAYS),
  );

  const accountRows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      iban: accounts.iban,
      currency: accounts.currency,
      connectionId: accounts.connectionId,
      institution: institutions.name,
      institutionRef: institutions.providerRef,
      lastSyncedAt: connections.lastSyncedAt,
    })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .leftJoin(connections, eq(accounts.connectionId, connections.id))
    .where(eq(accounts.archived, false))
    .orderBy(asc(institutions.name), asc(accounts.name), asc(accounts.id));

  const connectionRows = await db
    .select({
      id: connections.id,
      institution: institutions.name,
      status: connections.status,
      consentExpiresAt: connections.consentExpiresAt,
      lastSyncedAt: connections.lastSyncedAt,
    })
    .from(connections)
    .innerJoin(institutions, eq(connections.institutionId, institutions.id))
    .where(ne(connections.status, "archived"))
    .orderBy(asc(institutions.name), asc(connections.createdAt));

  const snapshots = await loadSnapshots(
    db,
    accountRows.map((account) => account.id),
    windowStart,
  );

  const balances: AccountBalances[] = [];
  const groups = new Map<string, AccountSummary[]>();
  for (const row of accountRows) {
    const own = snapshots.get(row.id) ?? [];
    const preference = balanceTypePreference(row.institutionRef);
    const current = balanceOn(own, today, preference);
    balances.push({
      type: row.type,
      currency: row.currency,
      today: current?.amountMinor,
      before: balanceOn(own, addDays(today, -CHANGE_DAYS), preference)
        ?.amountMinor,
    });
    const summary: AccountSummary = {
      id: row.id,
      name: row.name,
      type: row.type,
      iban: row.iban,
      currency: row.currency,
      balance: current
        ? {
            amountMinor: current.amountMinor,
            date: current.date,
            balanceType: current.balanceType,
          }
        : null,
      manual: row.connectionId === null,
      lastSyncedAt: row.lastSyncedAt,
      sparkline: dailyBalances(own, days, preference),
    };
    const group = groups.get(row.institution);
    if (group) group.push(summary);
    else groups.set(row.institution, [summary]);
  }

  const banks = [...groups].map(([name, list]) => ({
    name,
    // Stable within a type: the rows come ordered by name.
    accounts: list.sort(
      (a, b) =>
        ACCOUNT_TYPE_ORDER.indexOf(a.type) - ACCOUNT_TYPE_ORDER.indexOf(b.type),
    ),
  }));

  return {
    today,
    totals: sumTotals(balances),
    banks,
    connections: connectionRows.map(({ status, ...row }) => ({
      ...row,
      health: connectionHealth(
        { status, consentExpiresAt: row.consentExpiresAt },
        now,
      ),
    })),
    empty: accountRows.length === 0,
  };
}

/**
 * The accounts' snapshots from `windowStart` on, plus each balance type's
 * last one before it, which carries over into the window.
 */
async function loadSnapshots(
  db: Db,
  accountIds: string[],
  windowStart: IsoDate,
): Promise<Map<string, SnapshotLike[]>> {
  const byAccount = new Map<string, SnapshotLike[]>();
  if (accountIds.length === 0) return byAccount;
  const columns = {
    accountId: balanceSnapshots.accountId,
    date: balanceSnapshots.date,
    amountMinor: balanceSnapshots.amountMinor,
    currency: balanceSnapshots.currency,
    balanceType: balanceSnapshots.balanceType,
  };
  const [inWindow, carried] = await Promise.all([
    db
      .select(columns)
      .from(balanceSnapshots)
      .where(
        and(
          inArray(balanceSnapshots.accountId, accountIds),
          gte(balanceSnapshots.date, windowStart),
        ),
      ),
    db
      .selectDistinctOn(
        [balanceSnapshots.accountId, balanceSnapshots.balanceType],
        columns,
      )
      .from(balanceSnapshots)
      .where(
        and(
          inArray(balanceSnapshots.accountId, accountIds),
          lt(balanceSnapshots.date, windowStart),
        ),
      )
      .orderBy(
        balanceSnapshots.accountId,
        balanceSnapshots.balanceType,
        desc(balanceSnapshots.date),
      ),
  ]);
  for (const { accountId, ...snapshot } of [...carried, ...inWindow]) {
    const list = byAccount.get(accountId);
    if (list) list.push(snapshot);
    else byAccount.set(accountId, [snapshot]);
  }
  return byAccount;
}
