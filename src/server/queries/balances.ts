import type { IsoDate } from "@/server/providers/types";
import { pickDisplayBalance } from "@/server/sync/balance-types";
import { addDays } from "@/server/sync/transaction-merge";

// The pure part of the dashboard's balance read model (F-016): an account's
// balance on a given day from its stored snapshots. `dashboard.ts` loads the
// snapshots and the clock.

export interface SnapshotLike {
  /** `YYYY-MM-DD`. */
  date: IsoDate;
  amountMinor: number;
  currency: string;
  balanceType: string;
}

/**
 * The account's balance on `day`: of the snapshots of the latest day on or
 * before it, the display balance type (`pickDisplayBalance()`, D-009). The
 * last known balance carries over days without a sync, and an older
 * snapshot of a preferred type never beats a newer one of another type
 * (a bank that stops reporting `ITAV` does not freeze the balance).
 * Undefined before the first snapshot.
 */
export function balanceOn<T extends SnapshotLike>(
  snapshots: readonly T[],
  day: IsoDate,
  preference?: readonly string[],
): T | undefined {
  let latest: IsoDate | undefined;
  for (const snapshot of snapshots) {
    if (
      snapshot.date <= day &&
      (latest === undefined || snapshot.date > latest)
    ) {
      latest = snapshot.date;
    }
  }
  if (latest === undefined) return undefined;
  return pickDisplayBalance(
    snapshots.filter((snapshot) => snapshot.date === latest),
    preference,
  );
}

export interface DailyBalance {
  date: IsoDate;
  /** Null on days before the account's first snapshot. */
  amountMinor: number | null;
}

/** `days` consecutive days ending with `lastDay`, oldest first. */
export function dayRange(lastDay: IsoDate, days: number): IsoDate[] {
  return Array.from({ length: days }, (_, index) =>
    addDays(lastDay, index - days + 1),
  );
}

/** `balanceOn()` for each day of `days`. */
export function dailyBalances(
  snapshots: readonly SnapshotLike[],
  days: readonly IsoDate[],
  preference?: readonly string[],
): DailyBalance[] {
  return days.map((date) => ({
    date,
    amountMinor: balanceOn(snapshots, date, preference)?.amountMinor ?? null,
  }));
}
