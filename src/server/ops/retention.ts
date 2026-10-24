import { addDays, dayNumber, localDate } from "@/server/dates";
import type { IsoDate } from "@/server/providers/types";

// Which backups the nightly backup keeps (F-024): the newest backup of each
// of the last `daily` days that have one, of each of the last `weekly`
// weeks (Monday to Sunday) and of each of the last `monthly` months, the
// same rule as borg's and restic's `--keep-daily/-weekly/-monthly`. Days
// are calendar days in `APP_TIMEZONE`. A backup kept by one rule still
// counts for the others, so the newest backup is kept by all three.

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

/** 7 daily, 4 weekly and 12 monthly backups: about a year of history. */
export const BACKUP_RETENTION: RetentionPolicy = {
  daily: 7,
  weekly: 4,
  monthly: 12,
};

/** The Monday of `date`'s week. 1970-01-01 (day 0) was a Thursday. */
function weekOf(date: IsoDate): IsoDate {
  return addDays(date, -((dayNumber(date) + 3) % 7));
}

/** The backups to keep; the others can be deleted. */
export function backupsToKeep<T extends { takenAt: Date }>(
  backups: readonly T[],
  policy: RetentionPolicy,
  timeZone: string,
): Set<T> {
  const newestFirst = [...backups].sort(
    (a, b) => b.takenAt.getTime() - a.takenAt.getTime(),
  );
  const days = newestFirst.map((backup) => ({
    backup,
    day: localDate(backup.takenAt, timeZone),
  }));

  const keep = new Set<T>();
  const rules: [number, (day: IsoDate) => string][] = [
    [policy.daily, (day) => day],
    [policy.weekly, weekOf],
    [policy.monthly, (day) => day.slice(0, 7)],
  ];
  for (const [count, bucketOf] of rules) {
    const buckets = new Set<string>();
    for (const { backup, day } of days) {
      if (buckets.size >= count) break;
      const bucket = bucketOf(day);
      if (buckets.has(bucket)) continue;
      buckets.add(bucket);
      keep.add(backup);
    }
  }
  return keep;
}
