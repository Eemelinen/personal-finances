import { addDays, dayNumber } from "@/server/dates";
import type { IsoDate } from "@/server/providers/types";
import { balanceOn, type SnapshotLike } from "@/server/queries/balances";
import { addMonths, lastDay, monthOf } from "./period";

// The pure part of the balance history (F-018): the ranges of the range
// selector and an account's daily balance over a range. From the first
// snapshot on, a day's balance is the last known one (`balanceOn()`, D-013);
// before it the balance is reconstructed backwards from the transactions
// and marked estimated. `queries/balance-history.ts` loads the rows.

export const BALANCE_RANGES = [
  { id: "3m", label: "3 months", months: 3 },
  { id: "6m", label: "6 months", months: 6 },
  { id: "1y", label: "1 year", months: 12 },
  { id: "all", label: "All", months: null },
] as const;

export type BalanceRangeId = (typeof BALANCE_RANGES)[number]["id"];

export const DEFAULT_BALANCE_RANGE: BalanceRangeId = "3m";

/** A known range id, else the default. */
export function parseBalanceRange(value: string | undefined): BalanceRangeId {
  return (
    BALANCE_RANGES.find((range) => range.id === value)?.id ??
    DEFAULT_BALANCE_RANGE
  );
}

/** `day` moved by whole months, its day of month clamped (31.3. → 28.2.). */
export function addMonthsToDay(day: IsoDate, months: number): IsoDate {
  const month = addMonths(monthOf(day), months);
  const last = lastDay(month);
  const dayOfMonth = day.slice(8);
  return dayOfMonth > last.slice(8) ? last : `${month}-${dayOfMonth}`;
}

/**
 * The first day of `range` ending `today`: the day after the same day
 * `months` earlier, so a year is 365 or 366 days; for `all` the earliest
 * day with any data (`earliest`), or today without data.
 */
export function rangeStart(
  range: BalanceRangeId,
  today: IsoDate,
  earliest: IsoDate | null,
): IsoDate {
  const months = BALANCE_RANGES.find((item) => item.id === range)?.months;
  if (months) return addDays(addMonthsToDay(today, -months), 1);
  return earliest !== null && earliest < today ? earliest : today;
}

/** Consecutive days from `from` to `to`, both included. */
export function daysBetween(from: IsoDate, to: IsoDate): IsoDate[] {
  const days: IsoDate[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

export interface DayFlow {
  /** The booking day. */
  date: IsoDate;
  /** Net of the account's transactions that day, signed. */
  amountMinor: number;
}

export interface AccountHistoryInput {
  snapshots: readonly SnapshotLike[];
  /**
   * Daily net transaction amounts, at least for the days from the range's
   * first day to the first snapshot.
   */
  flows: readonly DayFlow[];
  /** The account's first booking day; estimates do not go back before it. */
  firstTransactionDate: IsoDate | null;
  preference?: readonly string[];
}

export interface BalancePoint {
  /** End-of-day balance; null when nothing is known about the day. */
  amountMinor: number | null;
  /** Reconstructed from transactions, before the first snapshot. */
  estimated: boolean;
}

const UNKNOWN: BalancePoint = { amountMinor: null, estimated: false };

/**
 * The account's balance on each of `days` (consecutive, oldest first).
 * Snapshots after the last day are ignored. From the first snapshot day on
 * it is `balanceOn()`. Before it, back to the first transaction, it is the
 * first snapshot's balance minus the transactions booked after the day up to
 * the snapshot day (a day's closing balance includes that day's
 * transactions), marked estimated. Before both it is unknown.
 */
export function accountSeries(
  input: AccountHistoryInput,
  days: readonly IsoDate[],
): BalancePoint[] {
  const lastDayOfRange = days.at(-1);
  if (lastDayOfRange === undefined) return [];
  const snapshots = input.snapshots.filter(
    (snapshot) => snapshot.date <= lastDayOfRange,
  );
  let first: IsoDate | undefined;
  for (const snapshot of snapshots) {
    if (first === undefined || snapshot.date < first) first = snapshot.date;
  }
  if (first === undefined) return days.map(() => UNKNOWN);

  const points = days.map((day): BalancePoint => {
    if (day < first) return UNKNOWN;
    const balance = balanceOn(snapshots, day, input.preference);
    return { amountMinor: balance?.amountMinor ?? null, estimated: false };
  });

  const firstTransaction = input.firstTransactionDate;
  if (firstTransaction === null || first <= days[0]) return points;
  const flowOn = new Map<IsoDate, number>();
  for (const flow of input.flows) {
    flowOn.set(flow.date, (flowOn.get(flow.date) ?? 0) + flow.amountMinor);
  }
  // Walk back from the first snapshot: the balance at the end of a day is
  // the next day's minus what was booked on the next day.
  let balance = balanceOn(snapshots, first, input.preference)!.amountMinor;
  const firstIndex = dayNumber(first) - dayNumber(days[0]);
  for (let index = firstIndex - 1; index >= 0; index--) {
    const day = days[index];
    if (day < firstTransaction) break;
    balance -= flowOn.get(addDays(day, 1)) ?? 0;
    points[index] = { amountMinor: balance, estimated: true };
  }
  return points;
}

export interface NetWorthPoint extends BalancePoint {
  /**
   * Some account has no balance yet that day, so the sum covers only the
   * accounts that do (an account added later is not a gain).
   */
  partial: boolean;
}

/**
 * The sum of the accounts' known balances per day; null on a day none is
 * known, estimated when any part of it is, partial when an account is
 * missing from it.
 */
export function sumSeries(
  series: readonly (readonly BalancePoint[])[],
  dayCount: number,
): NetWorthPoint[] {
  return Array.from({ length: dayCount }, (_, index) => {
    let amountMinor: number | null = null;
    let estimated = false;
    let missing = false;
    for (const points of series) {
      const point = points[index];
      if (point?.amountMinor == null) {
        missing = true;
        continue;
      }
      amountMinor = (amountMinor ?? 0) + point.amountMinor;
      estimated ||= point.estimated;
    }
    return { amountMinor, estimated, partial: amountMinor !== null && missing };
  });
}

/**
 * The change of the sum from day `from` to day `to` (indexes) over the
 * accounts known on both, as the dashboard's change (D-013): an account
 * whose history starts in between does not count as a gain. Null when no
 * account is known on both days.
 */
export function likeForLikeChange(
  series: readonly (readonly BalancePoint[])[],
  from: number,
  to: number,
): number | null {
  let change: number | null = null;
  for (const points of series) {
    const start = points[from]?.amountMinor;
    const end = points[to]?.amountMinor;
    if (start == null || end == null) continue;
    change = (change ?? 0) + end - start;
  }
  return change;
}
