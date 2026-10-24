import { describe, expect, it } from "vitest";
import { backupFileName, parseBackupFileName } from "@/server/ops/backup";
import { BACKUP_RETENTION, backupsToKeep } from "@/server/ops/retention";

// Which backups the nightly backup keeps (F-024): the newest of each of the
// last 7 days, 4 weeks (Monday to Sunday) and 12 months, by calendar day in
// APP_TIMEZONE.

const TZ = "Europe/Helsinki";

interface Backup {
  takenAt: Date;
}

/** One backup a night at 03:30 Helsinki (00:30 UTC in summer). */
function nightly(from: string, days: number): Backup[] {
  const start = Date.parse(`${from}T00:30:00Z`);
  return Array.from({ length: days }, (_, i) => ({
    takenAt: new Date(start + i * 86_400_000),
  }));
}

function keptDays(backups: Backup[], policy = BACKUP_RETENTION): string[] {
  return [...backupsToKeep(backups, policy, TZ)]
    .map((backup) => backup.takenAt.toISOString().slice(0, 10))
    .sort();
}

describe("backupsToKeep", () => {
  it("keeps 7 daily, 4 weekly and 12 monthly backups", () => {
    expect(BACKUP_RETENTION).toEqual({ daily: 7, weekly: 4, monthly: 12 });
  });

  it("keeps everything while there are fewer backups than days", () => {
    const backups = nightly("2026-10-20", 5);
    expect(backupsToKeep(backups, BACKUP_RETENTION, TZ).size).toBe(5);
    expect(backupsToKeep([], BACKUP_RETENTION, TZ).size).toBe(0);
  });

  it("keeps the last 7 days, the newest of the last 4 weeks and of the last 12 months", () => {
    // 2025-01-01 … 2026-10-24 (a Saturday), every night.
    const backups = nightly("2025-01-01", 662);
    expect(backups.at(-1)!.takenAt.toISOString()).toBe(
      "2026-10-24T00:30:00.000Z",
    );

    expect(keptDays(backups)).toEqual([
      // Monthly: the last backup of each month, Nov 2025 … Sep 2026 (Oct
      // 2026's newest is today's).
      "2025-11-30",
      "2025-12-31",
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
      "2026-07-31",
      "2026-08-31",
      "2026-09-30",
      // Weekly: the Sundays of the three weeks before this one.
      "2026-10-04",
      "2026-10-11",
      // Daily: the last 7 days (this week's newest and 2026-10-18 are both
      // daily and weekly).
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
    ]);
  });

  it("keeps the newest backup of a day when there are several", () => {
    const morning = { takenAt: new Date("2026-10-24T05:00:00Z") };
    const evening = { takenAt: new Date("2026-10-24T18:00:00Z") };
    const yesterday = { takenAt: new Date("2026-10-23T18:00:00Z") };
    const kept = backupsToKeep(
      [morning, evening, yesterday],
      { daily: 2, weekly: 0, monthly: 0 },
      TZ,
    );
    expect(kept).toEqual(new Set([evening, yesterday]));
  });

  it("counts days with a backup, not calendar days, after a gap", () => {
    // Nothing for two weeks: the last 7 backups are still kept.
    const backups = [...nightly("2026-09-20", 7), ...nightly("2026-10-20", 2)];
    expect(keptDays(backups, { daily: 7, weekly: 0, monthly: 0 })).toEqual([
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-10-20",
      "2026-10-21",
    ]);
  });

  it("buckets by the day in APP_TIMEZONE, not in UTC", () => {
    // 23:30 UTC on 31 Oct is 01:30 on 1 Nov in Helsinki (winter time).
    const late = { takenAt: new Date("2026-10-31T23:30:00Z") };
    const earlier = { takenAt: new Date("2026-10-31T10:00:00Z") };
    const kept = backupsToKeep(
      [late, earlier],
      { daily: 0, weekly: 0, monthly: 2 },
      TZ,
    );
    expect(kept).toEqual(new Set([late, earlier]));
    expect(
      backupsToKeep(
        [late, earlier],
        { daily: 0, weekly: 0, monthly: 2 },
        "UTC",
      ),
    ).toEqual(new Set([late]));
  });

  it("starts a week on Monday", () => {
    const sunday = { takenAt: new Date("2026-10-18T10:00:00Z") };
    const monday = { takenAt: new Date("2026-10-19T10:00:00Z") };
    const kept = backupsToKeep(
      [sunday, monday],
      { daily: 0, weekly: 2, monthly: 0 },
      TZ,
    );
    expect(kept).toEqual(new Set([sunday, monday]));
  });
});

describe("backup file names", () => {
  it("round-trip the time the backup was taken, in UTC", () => {
    const takenAt = new Date("2026-10-24T00:30:05.123Z");
    const name = backupFileName(takenAt);
    expect(name).toBe("finances-20261024T003005Z.dump.age");
    expect(parseBackupFileName(name)).toEqual(new Date("2026-10-24T00:30:05Z"));
  });

  it("are not confused with other files", () => {
    for (const name of [
      "finances-20261024T003005Z.dump.age.partial",
      "finances-20261024T003005Z.dump",
      "notes.txt",
      "finances-20261399T003005Z.dump.age",
    ]) {
      expect(parseBackupFileName(name)).toBeNull();
    }
  });
});
