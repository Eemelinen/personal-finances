import { formatDay } from "@/lib/format";
import type { BalanceRangeId } from "@/server/reports/balance-series";
import {
  PERIOD_PRESETS,
  type DayRange,
  type Period,
  type PeriodId,
} from "@/server/reports/period";

// URLs and labels of the report pages (F-017, F-018). The period, the
// drilled category and the balance range live in the query string, so every view can be linked to.

export const SPENDING_PATH = "/reports/spending";
export const CASH_FLOW_PATH = "/reports/cash-flow";
export const BALANCES_PATH = "/reports/balances";

/** The balance history over `range` (F-018). */
export function balancesHref(range: BalanceRangeId): string {
  return `${BALANCES_PATH}?${new URLSearchParams({ range })}`;
}

/** The spending report for `period`, drilled into `category` if given. */
export function spendingHref(
  period: Pick<Period, "id" | "from" | "to">,
  category?: string,
): string {
  const params = new URLSearchParams({ period: period.id });
  if (period.id === "custom") {
    params.set("from", period.from);
    params.set("to", period.to);
  }
  if (category) params.set("category", category);
  return `${SPENDING_PATH}?${params}`;
}

/** The preset's name, or "Custom" for a chosen range. */
export function periodName(id: PeriodId): string {
  return PERIOD_PRESETS.find((preset) => preset.id === id)?.label ?? "Custom";
}

/** `1.10.2026 – 31.10.2026`. */
export function formatRange(range: DayRange): string {
  return range.from === range.to
    ? formatDay(range.from)
    : `${formatDay(range.from)} – ${formatDay(range.to)}`;
}

/** First-value text for a query-string param that may repeat. */
export function single(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
