import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import {
  accounts,
  categories,
  institutions,
  transactions,
} from "@/server/db/schema";
import { IS_EXCLUDED } from "@/server/categorization/categorize";
import {
  loadFlowParts,
  REPORT_CURRENCY,
  type FlowSettings,
  type LeftOutReason,
} from "./reports";
import { NO_CATEGORY, type TransactionFilter } from "./transaction-filter";

// Read model of /transactions (F-015): one page of the filtered
// transactions, newest first, with the totals of the whole filter. Pages
// are LIMIT/OFFSET over (booking_date, created_at, id), which stays fast
// for one person's history (tens of thousands of rows).
//
// The totals count like the cash-flow report and the dashboard (F-034,
// D-035): the report rules of `flowParts()` (`reports.ts`) apply to the
// filtered rows, with the settings from `getAppSettings()`. Only EUR rows
// count; own transfers, excluded rows and, while `ignoreHouseholdTransfers`
// is on, household rows do not; a credit in an expense category nets
// against expenses as a refund; a credit without a category (or in
// Uncategorized) is income, or other money in while
// `uncategorizedCreditsAsIncome` is off. The rows that do not count are
// summed apart ("Not counted") with the reasons they meet. The list and its
// filters are unchanged: the `type` filter still goes by the sign.

export const PAGE_SIZE = 50;

export interface TransactionRow {
  id: string;
  bookingDate: string;
  status: "booked" | "pending";
  amountMinor: number;
  currency: string;
  counterparty: string | null;
  /** The counterparty's IBAN when the bank gave it (F-028). */
  counterpartyIban: string | null;
  description: string | null;
  note: string | null;
  accountId: string;
  accountName: string;
  institutionName: string;
  categoryId: string | null;
  categorySource: "none" | "rule" | "manual";
  transferGroupId: string | null;
  /** In a category of kind `excluded`: left out of every report (F-027). */
  excluded: boolean;
  /** With a household member (F-030). */
  household: boolean;
}

/**
 * What the filtered transactions that count add up to, in
 * `REPORT_CURRENCY` minor units, as the cash-flow report counts them.
 */
export interface TransactionTotals {
  currency: string;
  incomeMinor: number;
  /**
   * Signed: debits plus refunds of the expense rows, so normally negative
   * (the cash-flow report's `expensesMinor` with the opposite sign).
   */
  expensesMinor: number;
  /** Income plus the (negative) expenses; other money in is not in it. */
  netMinor: number;
  /**
   * Credits without a category (or in Uncategorized) while
   * `uncategorizedCreditsAsIncome` is off; 0 while it is on.
   */
  otherInMinor: number;
}

/** A filter whose `only` value lists the rows of one reason. */
export type ReasonFilter = "transfers" | "excluded" | "household";

export interface NotCountedReason {
  reason: LeftOutReason;
  /** Rows with this reason; a row can have several reasons. */
  count: number;
  /**
   * The filter whose `only` lists exactly these rows (the rest of the
   * filter unchanged), or null without one: other currencies, and own
   * transfers in a transfer-kind category without a transfer group.
   */
  filter: ReasonFilter | null;
}

/** The filtered transactions the reports leave out. */
export interface NotCounted {
  count: number;
  /** Their credits and debits per currency: EUR first, then by code. */
  sums: { currency: string; creditMinor: number; debitMinor: number }[];
  /** The reasons present, in `LEFT_OUT_REASONS` order. */
  reasons: NotCountedReason[];
}

export interface TransactionPage {
  rows: TransactionRow[];
  /** 1-based, clamped to `pageCount`. */
  page: number;
  pageCount: number;
  /** Transactions matching the filter, over all pages. */
  total: number;
  totals: TransactionTotals;
  notCounted: NotCounted;
}

export const LEFT_OUT_REASONS: readonly LeftOutReason[] = [
  "transfer",
  "excluded",
  "household",
  "currency",
];

export interface ListTransactionsOptions extends Partial<FlowSettings> {
  db?: Db;
}

/** `%`, `_` and `\` match themselves in an ILIKE pattern. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function filterConditions(filter: TransactionFilter): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  if (filter.from) conditions.push(gte(transactions.bookingDate, filter.from));
  if (filter.to) conditions.push(lte(transactions.bookingDate, filter.to));
  if (filter.accounts.length > 0) {
    conditions.push(inArray(transactions.accountId, filter.accounts));
  }
  if (filter.category === NO_CATEGORY) {
    conditions.push(isNull(transactions.categoryId));
  } else if (filter.category) {
    // A top-level category includes its subcategories.
    conditions.push(
      or(
        eq(transactions.categoryId, filter.category),
        sql`${transactions.categoryId} in (select ${categories.id} from ${categories} where ${categories.parentId} = ${filter.category})`,
      ),
    );
  }
  if (filter.text) {
    const pattern = likePattern(filter.text);
    conditions.push(
      or(
        ilike(transactions.counterparty, pattern),
        ilike(transactions.description, pattern),
        ilike(transactions.note, pattern),
      ),
    );
  }
  if (filter.direction === "income") {
    conditions.push(gt(transactions.amountMinor, 0));
  } else if (filter.direction === "expense") {
    conditions.push(lt(transactions.amountMinor, 0));
  }
  if (filter.transfers === "exclude") {
    conditions.push(isNull(transactions.transferGroupId));
  } else if (filter.transfers === "only") {
    conditions.push(isNotNull(transactions.transferGroupId));
  }
  if (filter.excluded === "exclude") {
    conditions.push(not(IS_EXCLUDED));
  } else if (filter.excluded === "only") {
    conditions.push(IS_EXCLUDED);
  }
  if (filter.household === "exclude") {
    conditions.push(eq(transactions.household, false));
  } else if (filter.household === "only") {
    conditions.push(eq(transactions.household, true));
  }
  return and(...conditions);
}

const num = (value: string | number | null | undefined) => Number(value ?? 0);

const sumWhere = (condition: SQL) =>
  sql<string>`coalesce(sum(${transactions.amountMinor}) filter (where ${condition}), 0)`;
const countWhere = (condition: SQL) =>
  sql<string>`count(*) filter (where ${condition})`;

/**
 * The totals and the "Not counted" part of the filtered rows, from one
 * aggregate per currency over the report rules (`loadFlowParts()`).
 */
async function countFiltered(
  db: Db,
  where: SQL | undefined,
  settings: Partial<FlowSettings>,
): Promise<{
  total: number;
  totals: TransactionTotals;
  notCounted: NotCounted;
}> {
  const { join, kind, counted, leftOut } = await loadFlowParts(db, settings);
  const notCounted = not(counted);
  const ofKind = (value: string) => and(counted, sql`${kind} = ${value}`)!;
  const groups = await db
    .select({
      currency: transactions.currency,
      count: count(),
      income: sumWhere(ofKind("income")),
      expenses: sumWhere(ofKind("expense")),
      otherIn: sumWhere(ofKind("other_in")),
      notCounted: countWhere(notCounted),
      credits: sumWhere(and(notCounted, gt(transactions.amountMinor, 0))!),
      debits: sumWhere(and(notCounted, lt(transactions.amountMinor, 0))!),
      transfer: countWhere(leftOut.transfer),
      grouped: countWhere(isNotNull(transactions.transferGroupId)),
      excluded: countWhere(leftOut.excluded),
      household: countWhere(leftOut.household),
      currencyReason: countWhere(leftOut.currency),
    })
    .from(transactions)
    .leftJoin(categories, join)
    .where(where)
    .groupBy(transactions.currency)
    .orderBy(asc(transactions.currency));

  const sumOf = (pick: (group: (typeof groups)[number]) => string | number) =>
    groups.reduce((sum, group) => sum + num(pick(group)), 0);
  const incomeMinor = sumOf((group) => group.income);
  const expensesMinor = sumOf((group) => group.expenses);

  const reasonCounts: Record<LeftOutReason, number> = {
    transfer: sumOf((group) => group.transfer),
    excluded: sumOf((group) => group.excluded),
    household: sumOf((group) => group.household),
    currency: sumOf((group) => group.currencyReason),
  };
  // `transfers=only` lists the rows in a transfer group, all of them own
  // transfers; it lists every own transfer only when each is in a group.
  const reasonFilters: Record<LeftOutReason, ReasonFilter | null> = {
    transfer:
      sumOf((group) => group.grouped) === reasonCounts.transfer
        ? "transfers"
        : null,
    excluded: "excluded",
    household: "household",
    currency: null,
  };

  return {
    total: sumOf((group) => group.count),
    totals: {
      currency: REPORT_CURRENCY,
      incomeMinor,
      expensesMinor,
      netMinor: incomeMinor + expensesMinor,
      otherInMinor: sumOf((group) => group.otherIn),
    },
    notCounted: {
      count: sumOf((group) => group.notCounted),
      sums: groups
        .filter((group) => num(group.notCounted) > 0)
        .map((group) => ({
          currency: group.currency,
          creditMinor: num(group.credits),
          debitMinor: num(group.debits),
        }))
        .sort(
          (a, b) =>
            Number(b.currency === REPORT_CURRENCY) -
              Number(a.currency === REPORT_CURRENCY) ||
            a.currency.localeCompare(b.currency),
        ),
      reasons: LEFT_OUT_REASONS.filter(
        (reason) => reasonCounts[reason] > 0,
      ).map((reason) => ({
        reason,
        count: reasonCounts[reason],
        filter: reasonFilters[reason],
      })),
    },
  };
}

export async function listTransactions(
  filter: TransactionFilter,
  page: number,
  options: ListTransactionsOptions = {},
): Promise<TransactionPage> {
  const db = options.db ?? getDb();
  const where = filterConditions(filter);

  const { total, totals, notCounted } = await countFiltered(db, where, {
    uncategorizedCreditsAsIncome: options.uncategorizedCreditsAsIncome,
    ignoreHouseholdTransfers: options.ignoreHouseholdTransfers,
  });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pageCount);

  const rows =
    total === 0
      ? []
      : await db
          .select({
            id: transactions.id,
            bookingDate: transactions.bookingDate,
            status: transactions.status,
            amountMinor: transactions.amountMinor,
            currency: transactions.currency,
            counterparty: transactions.counterparty,
            counterpartyIban: transactions.counterpartyIban,
            description: transactions.description,
            note: transactions.note,
            accountId: transactions.accountId,
            accountName: accounts.name,
            institutionName: institutions.name,
            categoryId: transactions.categoryId,
            categorySource: transactions.categorySource,
            transferGroupId: transactions.transferGroupId,
            excluded: sql<boolean>`${IS_EXCLUDED}`,
            household: transactions.household,
          })
          .from(transactions)
          .innerJoin(accounts, eq(accounts.id, transactions.accountId))
          .innerJoin(institutions, eq(institutions.id, accounts.institutionId))
          .where(where)
          .orderBy(
            desc(transactions.bookingDate),
            desc(transactions.createdAt),
            desc(transactions.id),
          )
          .limit(PAGE_SIZE)
          .offset((current - 1) * PAGE_SIZE);

  return {
    rows,
    page: current,
    pageCount,
    total,
    totals,
    notCounted,
  };
}

export interface AccountOption {
  id: string;
  name: string;
  institution: string;
  archived: boolean;
}

/** Every account, for the account filter (archived ones last). */
export async function listAccountOptions(
  options: { db?: Db } = {},
): Promise<AccountOption[]> {
  const db = options.db ?? getDb();
  return db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: institutions.name,
      archived: accounts.archived,
    })
    .from(accounts)
    .innerJoin(institutions, eq(institutions.id, accounts.institutionId))
    .orderBy(
      asc(accounts.archived),
      asc(institutions.name),
      asc(accounts.name),
    );
}
