import type { IsoDate } from "@/server/providers/types";

// Calendar-day arithmetic on `YYYY-MM-DD` strings, shared by the sync, the
// dashboard and the reports. Days carry no time zone; `localDate()` is the
// one place an instant becomes a day.

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 (UTC), for differences between two days. */
export function dayNumber(date: IsoDate): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

/** `date` moved by `days` calendar days. */
export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** The calendar day of `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): IsoDate {
  // `en-CA` formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
