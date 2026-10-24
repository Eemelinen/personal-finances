import { formatDay } from "@/lib/format";
import type { BalanceRangeId } from "@/server/reports/balance-series";
import {
  PERIOD_PRESETS,
  type DayRange,
  type Period,
  type PeriodId,
} from "@/server/reports/period";

// URLs and labels of the report pages (F-017, F-018, F-022). The period, the
// drilled category and the balance range live in the query string, so every view can be linked to.

export const SPENDING_PATH = "/reports/spending";
export const CASH_FLOW_PATH = "/reports/cash-flow";
export const BALANCES_PATH = "/reports/balances";
export const ALLOCATION_PATH = "/reports/allocation";
export const REPORT_SETTINGS_PATH = "/settings/reports";

/** Credits that are not income while the setting says so (F-026). */
export const OTHER_IN_LABEL = "Other money in (not income)";

/** The balance history over `range` (F-018). */
export function balancesHref(range: BalanceRangeId): string {
  return `${BALANCES_PATH}?${new URLSearchParams({ range })}`;
}

/**
 * The allocation report with the performance over `range`, of one
 * investment account or (without `account`) of all (F-022).
 */
export function allocationHref(
  range: BalanceRangeId,
  account?: string | null,
): string {
  const params = new URLSearchParams({ range });
  if (account) params.set("account", account);
  return `${ALLOCATION_PATH}?${params}`;
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
