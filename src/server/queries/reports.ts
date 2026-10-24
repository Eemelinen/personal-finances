import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNull,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { accounts, categories, transactions } from "@/server/db/schema";
import { UNCATEGORIZED_CATEGORY } from "@/server/categorization/defaults";
import { getEnv } from "@/server/env";
import { getAppSettings } from "@/server/settings";
import type { IsoDate } from "@/server/providers/types";
import { localDate } from "@/server/dates";
import { merchantKey, merchantName } from "@/server/reports/merchant-name";
import {
  addMonths,
  averageRange,
  firstDay,
  lastDay,
  monthOf,
  monthsEnding,
  previousRange,
  type DayRange,
  type IsoMonth,
} from "@/server/reports/period";

// Read models of the spending and cash-flow reports and the dashboard's
// month tiles (F-017, D-014, D-029).
//
// What counts: EUR transactions, booked or pending, that are not own
// transfers (no `transfer_group_id`, category kind not `transfer`). A
// category's kind says whether it is spending or income, so a refund (a
// credit in an expense category) nets against that category. A
// transaction in the top-level Uncategorized category counts exactly like
// one without a category: a debit is spending, and a credit is income
// while the `uncategorizedCreditsAsIncome` setting is on (the default) or
// "other money in" (not income, not in net or the savings rate) while it
// is off. Both are reported as the Uncategorized category when one exists.
// Months are the `YYYY-MM` of `booking_date`, which is already the bank's
// calendar day; the caller's "today" is the `APP_TIMEZONE` day.

export const REPORT_CURRENCY = "EUR";
/** Months in the spending report's stacked bar chart. */
export const TREND_MONTHS = 12;
/** Series in the stacked chart; the rest fold into Other. */
export const MAX_TREND_SERIES = 7;
/** Merchants in the top-merchants list. */
export const TOP_MERCHANTS = 10;
/** Rows in a drill-down's transaction list. */
export const TRANSACTION_LIST_LIMIT = 200;
/** Colour of a category without one, and of Other. */
export const FALLBACK_COLOR = "#94a3b8";
export const OTHER_COLOR = "#cbd5e1";
/** The `category` URL value of transactions without a category. */
export const UNCATEGORIZED_PARAM = "uncategorized";

/** `other_in`: a credit without a category while it is not income. */
type Kind = "expense" | "income" | "other_in";

interface CategoryRow {
  id: string;
  name: string;
  parentId: string | null;
  kind: "expense" | "income" | "transfer";
  color: string | null;
}

/** Where a spending report looks: everything, one category or none. */
export type SpendingScope =
  | { level: "all" }
  | { level: "category"; category: CategoryRow }
  | { level: "subcategory"; category: CategoryRow; parent: CategoryRow }
  | { level: "uncategorized" };

export interface ReportCategory {
  /** The `category` URL value that drills into it. */
  param: string;
  name: string;
  color: string;
  /** 1 for the first series of a colour, lower for repeats (subcategories). */
  opacity: number;
  /** Spending in the period: debits minus refunds, in minor units. */
  amountMinor: number;
  /** Share of the period's total spending, 0…1; null when the total is ≤ 0. */
  share: number | null;
  previousMinor: number;
  /** Mean monthly spending over the `AVERAGE_MONTHS` before the period. */
  averageMinor: number | null;
  /** Whether it has subcategories to drill into. */
  hasChildren: boolean;
}

export interface TrendSeries {
  key: string;
  name: string;
  color: string;
  opacity: number;
}

export interface TrendMonth {
  month: IsoMonth;
  /** Spending per series key, in minor units. */
  values: Record<string, number>;
}

export interface Merchant {
  name: string;
  amountMinor: number;
  count: number;
}

export interface ReportTransaction {
  id: string;
  bookingDate: IsoDate;
  account: string;
  counterparty: string | null;
  description: string | null;
  category: string | null;
  amountMinor: number;
  pending: boolean;
}

export interface SpendingReport {
  currency: string;
  period: DayRange;
  previous: DayRange;
  average: DayRange;
  scope: SpendingScope;
  /** No transaction at all yet. */
  empty: boolean;
  totalMinor: number;
  previousTotalMinor: number;
  averageTotalMinor: number | null;
  /** Categories (or subcategories) with spending in the three windows. */
  categories: ReportCategory[];
  trend: { series: TrendSeries[]; months: TrendMonth[] };
  merchants: Merchant[];
  /** The period's transactions of a drilled-into category, newest first. */
  transactions: { rows: ReportTransaction[]; total: number } | null;
}

export interface SpendingOptions {
  db?: Db;
  period: DayRange;
  /** A category id or `UNCATEGORIZED_PARAM`; anything unknown means all. */
  category?: string;
}

const num = (value: string | number | null | undefined) => Number(value ?? 0);

async function loadCategories(db: Db): Promise<CategoryRow[]> {
  return db
    .select({
      id: categories.id,
      name: categories.name,
      parentId: categories.parentId,
      kind: categories.kind,
      color: categories.color,
    })
    .from(categories)
    .orderBy(asc(categories.name), asc(categories.id));
}

/** The top-level Uncategorized category, which stands in for "none". */
function uncategorizedCategory(list: readonly CategoryRow[]) {
  return list.find(
    (category) =>
      category.parentId === null && category.name === UNCATEGORIZED_CATEGORY,
  );
}

export function resolveScope(
  param: string | undefined,
  list: readonly CategoryRow[],
): SpendingScope {
  if (param === UNCATEGORIZED_PARAM) {
    const stand = uncategorizedCategory(list);
    return stand
      ? { level: "category", category: stand }
      : { level: "uncategorized" };
  }
  const category = list.find((candidate) => candidate.id === param);
  if (!category || category.kind !== "expense") return { level: "all" };
  if (category.parentId === null) return { level: "category", category };
  const parent = list.find((candidate) => candidate.id === category.parentId);
  return parent
    ? { level: "subcategory", category, parent }
    : { level: "category", category };
}

/**
 * The parts of every report query: transactions joined to their category
 * (Uncategorized for none), the counted ones, and each one's kind. A row
 * in Uncategorized gets the kind of a row without a category.
 */
function flowParts(
  uncategorizedId: string | null,
  { uncategorizedCreditsAsIncome = true } = {},
) {
  const join = sql`${categories.id} = coalesce(${transactions.categoryId}, ${uncategorizedId}::uuid)`;
  const none = sql`(${transactions.categoryId} is null or ${transactions.categoryId} = ${uncategorizedId}::uuid)`;
  const credit = sql.raw(
    uncategorizedCreditsAsIncome ? "'income'" : "'other_in'",
  );
  const kind = sql<Kind>`case when ${none} then (case when ${transactions.amountMinor} < 0 then 'expense' else ${credit} end) else ${categories.kind}::text end`;
  const counted = and(
    eq(transactions.currency, REPORT_CURRENCY),
    isNull(transactions.transferGroupId),
    sql`(${transactions.categoryId} is null or ${categories.kind} <> 'transfer')`,
  )!;
  return { join, kind, counted };
}

function inRange(range: DayRange): SQL {
  return and(
    gte(transactions.bookingDate, range.from),
    lte(transactions.bookingDate, range.to),
  )!;
}

/** `sum(-amount)` over the rows in `range`: spending is money out. */
function spentIn(range: DayRange) {
  return sql<string>`coalesce(sum(-${transactions.amountMinor}) filter (where ${inRange(range)}), 0)`;
}

/** The first EUR transaction's day (transfers too), or null without any. */
async function firstTransactionDay(db: Db): Promise<IsoDate | null> {
  const [row] = await db
    .select({ first: sql<string | null>`min(${transactions.bookingDate})` })
    .from(transactions)
    .where(eq(transactions.currency, REPORT_CURRENCY));
  return row?.first ?? null;
}

/** Months of `range` on or after the data's first month (for averages). */
function monthsWithData(range: DayRange, first: IsoDate | null): number {
  if (first === null) return 0;
  const start =
    monthOf(range.from) > monthOf(first) ? monthOf(range.from) : monthOf(first);
  let count = 0;
  for (
    let month = start;
    month <= monthOf(range.to);
    month = addMonths(month, 1)
  ) {
    count += 1;
  }
  return count;
}

/** Colours per series: a colour seen before gets a lighter step. */
function shade<T extends { color: string | null }>(
  items: readonly T[],
): (T & { color: string; opacity: number })[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const color = item.color ?? FALLBACK_COLOR;
    const repeat = seen.get(color) ?? 0;
    seen.set(color, repeat + 1);
    return { ...item, color, opacity: Math.max(0.35, 1 - repeat * 0.2) };
  });
}

export async function getSpendingReport(
  options: SpendingOptions,
): Promise<SpendingReport> {
  const db = options.db ?? getDb();
  const { period } = options;
  const previous = previousRange(period);
  const average = averageRange(period);
  const trendLast = monthOf(period.to);
  const trendMonths = monthsEnding(trendLast, TREND_MONTHS);
  const trendRange = {
    from: firstDay(trendMonths[0]),
    to: lastDay(trendLast),
  };

  const [list, first] = await Promise.all([
    loadCategories(db),
    firstTransactionDay(db),
  ]);
  const byId = new Map(list.map((category) => [category.id, category]));
  const stand = uncategorizedCategory(list);
  const scope = resolveScope(options.category, list);
  const { join, kind, counted } = flowParts(stand?.id ?? null);

  // The grouping key one level below the scope, and the scope's filter.
  const top = sql<
    string | null
  >`coalesce(${categories.parentId}, ${categories.id})`;
  let key: SQL<string | null>;
  let filter: SQL | undefined;
  switch (scope.level) {
    case "all":
      key = top;
      break;
    case "category":
      key = sql<string | null>`${categories.id}`;
      filter = sql`${top} = ${scope.category.id}`;
      break;
    case "subcategory":
      key = sql<string | null>`${categories.id}`;
      filter = eq(categories.id, scope.category.id);
      break;
    case "uncategorized":
      key = sql<string | null>`null::uuid`;
      filter = isNull(categories.id);
      break;
  }
  const spending = and(counted, sql`${kind} = 'expense'`, filter);

  const earliest = [period.from, previous.from, average.from].sort()[0];
  const [breakdownRows, trendRows, merchantRows] = await Promise.all([
    db
      .select({
        key,
        amount: spentIn(period),
        previous: spentIn(previous),
        average: spentIn(average),
      })
      .from(transactions)
      .leftJoin(categories, join)
      .where(and(spending, inRange({ from: earliest, to: period.to })))
      .groupBy(key),
    db
      .select({
        key,
        month: sql<string>`to_char(${transactions.bookingDate}, 'YYYY-MM')`,
        amount: sql<string>`sum(-${transactions.amountMinor})`,
      })
      .from(transactions)
      .leftJoin(categories, join)
      .where(and(spending, inRange(trendRange)))
      .groupBy(key, sql`2`),
    merchantTotals(db, join, and(spending, inRange(period))!),
  ]);

  const averageMonths = monthsWithData(average, first);
  const perMonth = (minor: number) =>
    averageMonths === 0 ? null : Math.round(minor / averageMonths);

  const labelOf = (id: string | null) => {
    const category = id === null ? undefined : byId.get(id);
    if (!category)
      return { name: UNCATEGORIZED_CATEGORY, color: FALLBACK_COLOR };
    const parent = category.parentId ? byId.get(category.parentId) : undefined;
    let name = category.name;
    if (
      scope.level === "category" &&
      category.id === scope.category.id &&
      list.some((child) => child.parentId === category.id)
    ) {
      name = `${category.name} (no subcategory)`;
    }
    return { name, color: category.color ?? parent?.color ?? null };
  };

  const totalMinor = breakdownRows.reduce(
    (sum, row) => sum + num(row.amount),
    0,
  );
  const rows = breakdownRows
    .map((row) => ({
      id: row.key,
      ...labelOf(row.key),
      amountMinor: num(row.amount),
      previousMinor: num(row.previous),
      averageRaw: num(row.average),
    }))
    .filter(
      (row) =>
        row.amountMinor !== 0 ||
        row.previousMinor !== 0 ||
        row.averageRaw !== 0,
    )
    .sort(
      (a, b) =>
        b.amountMinor - a.amountMinor ||
        b.previousMinor - a.previousMinor ||
        a.name.localeCompare(b.name, "fi-FI"),
    );

  const breakdown: ReportCategory[] = shade(rows).map((row) => ({
    param: row.id ?? UNCATEGORIZED_PARAM,
    name: row.name,
    color: row.color,
    opacity: row.opacity,
    amountMinor: row.amountMinor,
    share: totalMinor > 0 ? row.amountMinor / totalMinor : null,
    previousMinor: row.previousMinor,
    averageMinor: perMonth(row.averageRaw),
    hasChildren:
      scope.level === "all" &&
      row.id !== null &&
      list.some((category) => category.parentId === row.id),
  }));

  return {
    currency: REPORT_CURRENCY,
    period,
    previous,
    average,
    scope,
    empty: first === null,
    totalMinor,
    previousTotalMinor: rows.reduce((sum, row) => sum + row.previousMinor, 0),
    averageTotalMinor: perMonth(
      rows.reduce((sum, row) => sum + row.averageRaw, 0),
    ),
    categories: breakdown,
    trend: buildTrend(trendMonths, trendRows, labelOf),
    merchants: merchantRows,
    transactions:
      scope.level === "all"
        ? null
        : await listTransactions(db, join, and(spending, inRange(period))!),
  };
}

/**
 * The stacked chart: the `MAX_TREND_SERIES` largest over the months, the
 * rest as Other, each month's spending per series.
 */
function buildTrend(
  months: readonly IsoMonth[],
  rows: readonly { key: string | null; month: string; amount: string }[],
  labelOf: (id: string | null) => { name: string; color: string | null },
): SpendingReport["trend"] {
  const totals = new Map<string | null, number>();
  for (const row of rows) {
    totals.set(row.key, (totals.get(row.key) ?? 0) + num(row.amount));
  }
  const ranked = [...totals]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1]);
  const fold = ranked.length > MAX_TREND_SERIES;
  const kept = fold ? ranked.slice(0, MAX_TREND_SERIES - 1) : ranked;
  const keyOf = (id: string | null) => id ?? UNCATEGORIZED_PARAM;
  const keptKeys = new Set(kept.map(([id]) => id));

  const series: TrendSeries[] = shade(
    kept.map(([id]) => ({ key: keyOf(id), ...labelOf(id) })),
  );
  if (fold) {
    series.push({
      key: "other",
      name: "Other",
      color: OTHER_COLOR,
      opacity: 1,
    });
  }

  const byMonth = new Map(
    months.map((month) => [
      month,
      Object.fromEntries(series.map((item) => [item.key, 0])) as Record<
        string,
        number
      >,
    ]),
  );
  for (const row of rows) {
    const values = byMonth.get(row.month);
    if (!values) continue;
    const seriesKey = keptKeys.has(row.key)
      ? keyOf(row.key)
      : fold && totals.get(row.key)! > 0
        ? "other"
        : undefined;
    if (seriesKey === undefined) continue;
    values[seriesKey] += num(row.amount);
  }
  return {
    series,
    months: months.map((month) => ({ month, values: byMonth.get(month)! })),
  };
}

/** Spending per normalised merchant name, largest first. */
async function merchantTotals(
  db: Db,
  join: SQL,
  where: SQL,
): Promise<Merchant[]> {
  // Group by the raw text in SQL (few distinct ones), merge in JS.
  const text = sql<
    string | null
  >`case when btrim(coalesce(${transactions.counterparty}, '')) <> '' then ${transactions.counterparty} else ${transactions.description} end`;
  const rows = await db
    .select({
      text,
      amount: sql<string>`sum(-${transactions.amountMinor})`,
      count: sql<string>`count(*)`,
    })
    .from(transactions)
    .leftJoin(categories, join)
    .where(where)
    .groupBy(sql`1`);
  const merged = new Map<string, Merchant>();
  for (const row of rows) {
    const name = merchantName(row.text);
    const id = merchantKey(name);
    const merchant = merged.get(id) ?? { name, amountMinor: 0, count: 0 };
    merchant.amountMinor += num(row.amount);
    merchant.count += num(row.count);
    merged.set(id, merchant);
  }
  return [...merged.values()]
    .filter((merchant) => merchant.amountMinor > 0)
    .sort(
      (a, b) =>
        b.amountMinor - a.amountMinor || a.name.localeCompare(b.name, "fi-FI"),
    )
    .slice(0, TOP_MERCHANTS);
}

async function listTransactions(
  db: Db,
  join: SQL,
  where: SQL,
): Promise<{ rows: ReportTransaction[]; total: number }> {
  const result = await db
    .select({
      id: transactions.id,
      bookingDate: transactions.bookingDate,
      account: accounts.name,
      counterparty: transactions.counterparty,
      description: transactions.description,
      category: categories.name,
      categoryId: transactions.categoryId,
      amountMinor: transactions.amountMinor,
      status: transactions.status,
      total: sql<string>`count(*) over ()`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(categories, join)
    .where(where)
    .orderBy(
      desc(transactions.bookingDate),
      desc(transactions.createdAt),
      asc(transactions.id),
    )
    .limit(TRANSACTION_LIST_LIMIT);
  return {
    total: num(result[0]?.total),
    rows: result.map((row) => ({
      id: row.id,
      bookingDate: row.bookingDate,
      account: row.account,
      counterparty: row.counterparty,
      description: row.description,
      category: row.categoryId === null ? UNCATEGORIZED_CATEGORY : row.category,
      amountMinor: row.amountMinor,
      pending: row.status === "pending",
    })),
  };
}

export interface CashFlowTotals {
  incomeMinor: number;
  expensesMinor: number;
  /** Income minus expenses; other money in is not part of it. */
  netMinor: number;
  /** Net over income, 0…1 (negative when spending more); null without income. */
  savingsRate: number | null;
  /**
   * Credits without a category (or in Uncategorized) while the
   * `uncategorizedCreditsAsIncome` setting is off; 0 while it is on.
   */
  otherInMinor: number;
}

export interface CashFlowMonth extends CashFlowTotals {
  month: IsoMonth;
}

export interface CashFlowReport {
  currency: string;
  /** Oldest first, ending with the current month. */
  months: CashFlowMonth[];
  /** January of the current year through the current month. */
  yearToDate: CashFlowTotals & { year: number };
  empty: boolean;
}

export function cashFlowTotals(
  incomeMinor: number,
  expensesMinor: number,
  otherInMinor = 0,
): CashFlowTotals {
  const netMinor = incomeMinor - expensesMinor;
  return {
    incomeMinor,
    expensesMinor,
    netMinor,
    savingsRate: incomeMinor > 0 ? netMinor / incomeMinor : null,
    otherInMinor,
  };
}

export interface CashFlowOptions {
  db?: Db;
  /** The current time; defaults to the clock. Its month is the last one. */
  now?: Date;
  /** Whose calendar decides the current month; `APP_TIMEZONE`. */
  timeZone?: string;
  months?: number;
  /** Overrides the stored setting (`getAppSettings()`). */
  uncategorizedCreditsAsIncome?: boolean;
}

/** Income, expenses, net and other money in per month, plus the year to date. */
export async function getCashFlowReport(
  options: CashFlowOptions,
): Promise<CashFlowReport> {
  const db = options.db ?? getDb();
  const today = localDate(
    options.now ?? new Date(),
    options.timeZone ?? getEnv().APP_TIMEZONE,
  );
  const current = monthOf(today);
  const year = current.slice(0, 4);
  const months = monthsEnding(current, options.months ?? TREND_MONTHS);
  // The year's months may reach before the chart's.
  const from = [firstDay(months[0]), `${year}-01-01`].sort()[0];

  const [list, uncategorizedCreditsAsIncome] = await Promise.all([
    loadCategories(db),
    options.uncategorizedCreditsAsIncome ??
      getAppSettings(db).then(
        (settings) => settings.uncategorizedCreditsAsIncome,
      ),
  ]);
  const { join, kind, counted } = flowParts(
    uncategorizedCategory(list)?.id ?? null,
    { uncategorizedCreditsAsIncome },
  );
  const month = sql<string>`to_char(${transactions.bookingDate}, 'YYYY-MM')`;
  const [rows, first] = await Promise.all([
    db
      .select({
        month,
        income: sql<string>`coalesce(sum(${transactions.amountMinor}) filter (where ${kind} = 'income'), 0)`,
        expenses: sql<string>`coalesce(sum(-${transactions.amountMinor}) filter (where ${kind} = 'expense'), 0)`,
        otherIn: sql<string>`coalesce(sum(${transactions.amountMinor}) filter (where ${kind} = 'other_in'), 0)`,
      })
      .from(transactions)
      .leftJoin(categories, join)
      .where(and(counted, inRange({ from, to: lastDay(current) })))
      .groupBy(sql`1`),
    firstTransactionDay(db),
  ]);
  const byMonth = new Map(rows.map((row) => [row.month, row]));
  const totalsOf = (key: IsoMonth) => {
    const row = byMonth.get(key);
    return cashFlowTotals(
      num(row?.income),
      num(row?.expenses),
      num(row?.otherIn),
    );
  };

  let income = 0;
  let expenses = 0;
  let otherIn = 0;
  for (let m = `${year}-01`; m <= current; m = addMonths(m, 1)) {
    const totals = totalsOf(m);
    income += totals.incomeMinor;
    expenses += totals.expensesMinor;
    otherIn += totals.otherInMinor;
  }
  return {
    currency: REPORT_CURRENCY,
    months: months.map((key) => ({ month: key, ...totalsOf(key) })),
    yearToDate: {
      year: Number(year),
      ...cashFlowTotals(income, expenses, otherIn),
    },
    empty: first === null,
  };
}

/** This month's income, expenses, net and other money in, for the dashboard tiles. */
export async function getMonthCashFlow(
  options: Omit<CashFlowOptions, "months"> = {},
): Promise<CashFlowMonth> {
  const report = await getCashFlowReport({ ...options, months: 1 });
  return report.months[0];
}
