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
import { NO_CATEGORY, type TransactionFilter } from "./transaction-filter";

// Read model of /transactions (F-015): one page of the filtered
// transactions, newest first, with the totals of the whole filter. Pages
// are LIMIT/OFFSET over (booking_date, created_at, id), which stays fast
// for one person's history (tens of thousands of rows).

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
}

/** Sums of the filtered transactions in one currency (minor units). */
export interface CurrencyTotals {
  currency: string;
  count: number;
  income: number;
  expense: number;
  net: number;
}

export interface TransactionPage {
  rows: TransactionRow[];
  /** 1-based, clamped to `pageCount`. */
  page: number;
  pageCount: number;
  /** Transactions matching the filter, over all pages. */
  total: number;
  totals: CurrencyTotals[];
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
  return and(...conditions);
}

export async function listTransactions(
  filter: TransactionFilter,
  page: number,
  options: { db?: Db } = {},
): Promise<TransactionPage> {
  const db = options.db ?? getDb();
  const where = filterConditions(filter);

  const totalsRows = await db
    .select({
      currency: transactions.currency,
      count: count(),
      income: sql<string>`coalesce(sum(${transactions.amountMinor}) filter (where ${transactions.amountMinor} > 0), 0)`,
      expense: sql<string>`coalesce(sum(${transactions.amountMinor}) filter (where ${transactions.amountMinor} < 0), 0)`,
    })
    .from(transactions)
    .where(where)
    .groupBy(transactions.currency)
    .orderBy(asc(transactions.currency));
  const totals = totalsRows.map((row) => {
    const income = Number(row.income);
    const expense = Number(row.expense);
    return {
      currency: row.currency,
      count: row.count,
      income,
      expense,
      net: income + expense,
    };
  });
  const total = totals.reduce((sum, row) => sum + row.count, 0);
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
