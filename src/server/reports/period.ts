import type { IsoDate } from "@/server/providers/types";
import { addDays } from "@/server/dates";

// Report periods (F-017): the presets of the period selector and custom
// ranges, as inclusive calendar days. Pure, so the pages and the tests share
// it. "Today" is the caller's `APP_TIMEZONE` day.

/** A calendar month as `YYYY-MM`. */
export type IsoMonth = string;

export const PERIOD_PRESETS = [
  { id: "this-month", label: "This month", months: 1, offset: 0 },
  { id: "last-month", label: "Last month", months: 1, offset: 1 },
  { id: "3m", label: "Last 3 months", months: 3, offset: 0 },
  { id: "6m", label: "Last 6 months", months: 6, offset: 0 },
  { id: "12m", label: "Last 12 months", months: 12, offset: 0 },
] as const;

export type PeriodPresetId = (typeof PERIOD_PRESETS)[number]["id"];
export type PeriodId = PeriodPresetId | "custom";

export interface DayRange {
  /** First day, inclusive. */
  from: IsoDate;
  /** Last day, inclusive. */
  to: IsoDate;
}

export interface Period extends DayRange {
  id: PeriodId;
}

/** Months the 6-month average looks back over, before the period. */
export const AVERAGE_MONTHS = 6;

/** Longest custom range, so a typo cannot ask for centuries. */
export const MAX_CUSTOM_DAYS = 366 * 10;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function monthOf(day: IsoDate): IsoMonth {
  return day.slice(0, 7);
}

export function addMonths(month: IsoMonth, months: number): IsoMonth {
  const [year, monthNumber] = month.split("-").map(Number);
  const index = year * 12 + (monthNumber - 1) + months;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

export function firstDay(month: IsoMonth): IsoDate {
  return `${month}-01`;
}

export function lastDay(month: IsoMonth): IsoDate {
  return addDays(firstDay(addMonths(month, 1)), -1);
}

/** `count` months ending with `last`, oldest first. */
export function monthsEnding(last: IsoMonth, count: number): IsoMonth[] {
  return Array.from({ length: count }, (_, i) =>
    addMonths(last, i - count + 1),
  );
}

/** Whether `day` is a real `YYYY-MM-DD` calendar day. */
export function isIsoDate(day: string): day is IsoDate {
  if (!ISO_DATE.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString() === `${day}T00:00:00.000Z`
  );
}

function daysBetween(range: DayRange): number {
  return (
    (Date.parse(`${range.to}T00:00:00Z`) -
      Date.parse(`${range.from}T00:00:00Z`)) /
      86_400_000 +
    1
  );
}

/** The months a range covers when it is whole months, else undefined. */
function wholeMonths(range: DayRange): number | undefined {
  if (!range.from.endsWith("-01")) return undefined;
  if (lastDay(monthOf(range.to)) !== range.to) return undefined;
  const [fromYear, fromMonth] = range.from.split("-").map(Number);
  const [toYear, toMonth] = range.to.split("-").map(Number);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
}

/**
 * The period the URL asks for. Presets are whole calendar months ending with
 * the current one (or the previous one for `last-month`), so "this month"
 * runs to the month's last day. `custom` needs a valid `from` ≤ `to`; any
 * other input falls back to this month.
 */
export function resolvePeriod(
  params: { period?: string; from?: string; to?: string },
  today: IsoDate,
): Period {
  if (params.period === "custom") {
    const { from, to } = params;
    if (from && to && isIsoDate(from) && isIsoDate(to) && from <= to) {
      if (daysBetween({ from, to }) <= MAX_CUSTOM_DAYS) {
        return { id: "custom", from, to };
      }
    }
  }
  const preset =
    PERIOD_PRESETS.find((candidate) => candidate.id === params.period) ??
    PERIOD_PRESETS[0];
  const last = addMonths(monthOf(today), -preset.offset);
  return {
    id: preset.id,
    from: firstDay(addMonths(last, 1 - preset.months)),
    to: lastDay(last),
  };
}

/**
 * The same length right before `range`: as many whole months before a
 * whole-month range, otherwise as many days.
 */
export function previousRange(range: DayRange): DayRange {
  const months = wholeMonths(range);
  if (months !== undefined) {
    const start = addMonths(monthOf(range.from), -months);
    return {
      from: firstDay(start),
      to: lastDay(addMonths(start, months - 1)),
    };
  }
  const days = daysBetween(range);
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

/** The `AVERAGE_MONTHS` whole months before the month `range` starts in. */
export function averageRange(range: DayRange): DayRange {
  const start = monthOf(range.from);
  return {
    from: firstDay(addMonths(start, -AVERAGE_MONTHS)),
    to: lastDay(addMonths(start, -1)),
  };
}
