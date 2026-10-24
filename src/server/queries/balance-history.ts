import { and, asc, eq, gte, inArray, lte, min, sql } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import {
  accounts,
  balanceSnapshots,
  institutions,
  transactions,
} from "@/server/db/schema";
import { localDate } from "@/server/dates";
import { getEnv } from "@/server/env";
import type { IsoDate } from "@/server/providers/types";
import {
  accountSeries,
  daysBetween,
  likeForLikeChange,
  rangeStart,
  sumSeries,
  type BalancePoint,
  type BalanceRangeId,
  type DayFlow,
  type NetWorthPoint,
} from "@/server/reports/balance-series";
import { balanceTypePreference } from "@/server/sync/balance-types";
import { loadSnapshots, TOTALS_CURRENCY } from "./dashboard";

// Read model of the balance history (F-018): each account's daily balance
// over the chosen range and their sum, the net worth. Like the dashboard's
// totals (D-013) it covers the non-archived EUR accounts. An account counts
// from its first balance snapshot; before it the balance is reconstructed
// from its transactions (booked and pending, transfers included: they all
// moved money) and marked estimated. An account without any snapshot (only
// CSV imports) has no balance to start from and is left out. A day on which
// some account has no balance yet sums the others and is marked partial.

type AccountType = (typeof accounts.$inferSelect)["type"];

export interface BalanceHistoryAccount {
  id: string;
  name: string;
  institution: string;
  type: AccountType;
  /** One point per day of `days`. */
  points: BalancePoint[];
}

export interface BalanceHistory {
  range: BalanceRangeId;
  currency: string;
  /** The range's days, oldest first; the last one is today. */
  days: IsoDate[];
  accounts: BalanceHistoryAccount[];
  /** The sum of the accounts' balances per day. */
  netWorth: NetWorthPoint[];
  /**
   * Net worth today minus on the range's first day, over the accounts that
   * had a balance on both; null when none had.
   */
  netWorthChange: number | null;
  /** Non-archived accounts not drawn: no snapshot yet, or not in EUR. */
  omitted: { withoutBalance: number; otherCurrency: number };
  /** No account has a balance yet. */
  empty: boolean;
}

export interface BalanceHistoryOptions {
  db?: Db;
  /** The current time; defaults to the clock. */
  now?: Date;
  /** Whose calendar day "today" is; `APP_TIMEZONE`. */
  timeZone?: string;
  range: BalanceRangeId;
}

export async function getBalanceHistory(
  options: BalanceHistoryOptions,
): Promise<BalanceHistory> {
  const db = options.db ?? getDb();
  const today = localDate(
    options.now ?? new Date(),
    options.timeZone ?? getEnv().APP_TIMEZONE,
  );

  const accountRows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      currency: accounts.currency,
      institution: institutions.name,
      institutionRef: institutions.providerRef,
    })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(accounts.archived, false))
    .orderBy(asc(institutions.name), asc(accounts.name), asc(accounts.id));
  const eur = accountRows.filter((row) => row.currency === TOTALS_CURRENCY);
  const eurIds = eur.map((row) => row.id);

  const [firstSnapshots, firstTransactions] = eurIds.length
    ? await Promise.all([
        db
          .select({
            accountId: balanceSnapshots.accountId,
            date: min(balanceSnapshots.date),
          })
          .from(balanceSnapshots)
          .where(inArray(balanceSnapshots.accountId, eurIds))
          .groupBy(balanceSnapshots.accountId),
        db
          .select({
            accountId: transactions.accountId,
            date: min(transactions.bookingDate),
          })
          .from(transactions)
          .where(
            and(
              inArray(transactions.accountId, eurIds),
              eq(transactions.currency, TOTALS_CURRENCY),
            ),
          )
          .groupBy(transactions.accountId),
      ])
    : [[], []];
  const firstSnapshot = new Map(
    firstSnapshots.map((row) => [row.accountId, row.date]),
  );
  const firstTransaction = new Map(
    firstTransactions.map((row) => [row.accountId, row.date]),
  );
  const included = eur.filter((row) => firstSnapshot.get(row.id) != null);
  const ids = included.map((row) => row.id);

  // The oldest day with data: a first snapshot, or a transaction before one.
  let earliest: IsoDate | null = null;
  for (const id of ids) {
    for (const date of [firstSnapshot.get(id), firstTransaction.get(id)]) {
      if (date != null && (earliest === null || date < earliest)) {
        earliest = date;
      }
    }
  }
  const days = daysBetween(rangeStart(options.range, today, earliest), today);

  const [snapshots, flowRows] = await Promise.all([
    loadSnapshots(db, ids, days[0]),
    ids.length
      ? db
          .select({
            accountId: transactions.accountId,
            date: transactions.bookingDate,
            amountMinor: sql<number>`sum(${transactions.amountMinor})`.mapWith(
              Number,
            ),
          })
          .from(transactions)
          .where(
            and(
              inArray(transactions.accountId, ids),
              eq(transactions.currency, TOTALS_CURRENCY),
              gte(transactions.bookingDate, days[0]),
              lte(transactions.bookingDate, today),
            ),
          )
          .groupBy(transactions.accountId, transactions.bookingDate)
      : [],
  ]);
  const flows = new Map<string, DayFlow[]>();
  for (const { accountId, ...flow } of flowRows) {
    const list = flows.get(accountId);
    if (list) list.push(flow);
    else flows.set(accountId, [flow]);
  }

  const series = included.map((row) => ({
    id: row.id,
    name: row.name,
    institution: row.institution,
    type: row.type,
    points: accountSeries(
      {
        snapshots: snapshots.get(row.id) ?? [],
        flows: flows.get(row.id) ?? [],
        firstTransactionDate: firstTransaction.get(row.id) ?? null,
        preference: balanceTypePreference(row.institutionRef),
      },
      days,
    ),
  }));

  const points = series.map((account) => account.points);
  return {
    range: options.range,
    currency: TOTALS_CURRENCY,
    days,
    accounts: series,
    netWorth: sumSeries(points, days.length),
    netWorthChange: likeForLikeChange(points, 0, days.length - 1),
    omitted: {
      withoutBalance: eur.length - included.length,
      otherCurrency: accountRows.length - eur.length,
    },
    empty: included.length === 0,
  };
}
