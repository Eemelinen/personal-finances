import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import {
  accounts,
  categories,
  categoryRules,
  transactions,
} from "@/server/db/schema";
import type { Tx } from "@/server/sync/runs";
import { TRANSFERS_CATEGORY } from "./defaults";
import { compileRules, matchRule, type CompiledRule } from "./rules";
import {
  findTransfers,
  TRANSFER_WINDOW_DAYS,
  type TransferCandidate,
} from "./transfers";

// Categorises stored transactions (F-014, D-012): the rules first, then
// own-transfer detection. `categorizeTransactions` is the `categorize` hook
// the bank sync and the CSV import run in their write transaction, with the
// ids they inserted or changed; `reapplyRules()` runs the same over every
// transaction.
//
// - A `manual` category is never touched, not even by transfer detection.
// - A transaction in a transfer group keeps the Transfers category: rules
//   skip it. The rest gets its first matching rule's category (`rule`), or
//   none (`none`, no category) when no rule matches.
// - Booked transactions that are not manual and in no group (or the only
//   member of one) are paired as transfers (`transfers.ts`); both legs get
//   one `transfer_group_id` and the Transfers category with source `rule`.
//   Pending ones wait until they are booked: the sync passes the booked
//   version to the hook again.

/** Values per `IN (…)` list, well below Postgres' parameter limit. */
const BATCH = 1_000;

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += BATCH) {
    result.push(values.slice(start, start + BATCH));
  }
  return result;
}

export interface CategorizeSummary {
  /** Transactions whose category the rules changed. */
  recategorized: number;
  /** Transactions newly linked as transfers (both legs of a pair count). */
  transfers: number;
}

/** The `categorize` hook of `syncTransactions()` and the CSV import. */
export async function categorizeTransactions(
  tx: Tx,
  transactionIds: string[],
): Promise<void> {
  if (transactionIds.length === 0) return;
  await categorize(tx, transactionIds);
}

/**
 * Re-applies the rules to every transaction that is not categorised
 * manually, then looks for transfers among all of them.
 */
export async function reapplyRules(
  options: { db?: Db } = {},
): Promise<CategorizeSummary> {
  const db = options.db ?? getDb();
  return db.transaction((tx) => categorize(tx, "all"));
}

type Scope = string[] | "all";

const CANDIDATE_COLUMNS = {
  id: transactions.id,
  accountId: transactions.accountId,
  bookingDate: transactions.bookingDate,
  amountMinor: transactions.amountMinor,
  currency: transactions.currency,
  counterparty: transactions.counterparty,
  description: transactions.description,
  status: transactions.status,
  categoryId: transactions.categoryId,
  categorySource: transactions.categorySource,
  transferGroupId: transactions.transferGroupId,
  categoryKind: categories.kind,
};

function selectRows(tx: Tx, where: SQL | undefined) {
  return tx
    .select(CANDIDATE_COLUMNS)
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(where)
    .orderBy(asc(transactions.bookingDate), asc(transactions.id));
}

type CandidateRow = Awaited<ReturnType<typeof selectRows>>[number];

/** Loads the scope's transactions (or all), `filter` applied. */
async function loadScope(
  tx: Tx,
  scope: Scope,
  filter: SQL | undefined,
): Promise<CandidateRow[]> {
  if (scope === "all") return selectRows(tx, filter);
  const rows: CandidateRow[] = [];
  for (const ids of batches(scope)) {
    rows.push(
      ...(await selectRows(tx, and(inArray(transactions.id, ids), filter))),
    );
  }
  return rows;
}

async function categorize(tx: Tx, scope: Scope): Promise<CategorizeSummary> {
  const recategorized = await applyRules(tx, scope);
  const transfers = await linkTransfers(tx, scope);
  return { recategorized, transfers };
}

async function loadRules(tx: Tx): Promise<CompiledRule[]> {
  const rules = await tx
    .select({
      id: categoryRules.id,
      categoryId: categoryRules.categoryId,
      matchField: categoryRules.matchField,
      matchType: categoryRules.matchType,
      pattern: categoryRules.pattern,
      priority: categoryRules.priority,
      amountSign: categoryRules.amountSign,
      amountMinMinor: categoryRules.amountMinMinor,
      amountMaxMinor: categoryRules.amountMaxMinor,
      createdAt: categoryRules.createdAt,
    })
    .from(categoryRules);
  return compileRules(rules);
}

/** Returns how many transactions changed category. */
async function applyRules(tx: Tx, scope: Scope): Promise<number> {
  const rules = await loadRules(tx);
  const rows = await loadScope(
    tx,
    scope,
    and(
      ne(transactions.categorySource, "manual"),
      isNull(transactions.transferGroupId),
    ),
  );

  // Target category ("" = none) → ids that must change to it.
  const changes = new Map<string, string[]>();
  for (const row of rows) {
    const rule = matchRule(rules, row);
    const categoryId = rule?.categoryId ?? null;
    const source = rule ? "rule" : "none";
    if (row.categoryId === categoryId && row.categorySource === source) {
      continue;
    }
    const key = categoryId ?? "";
    const ids = changes.get(key);
    if (ids) ids.push(row.id);
    else changes.set(key, [row.id]);
  }

  let changed = 0;
  for (const [key, ids] of changes) {
    for (const batch of batches(ids)) {
      await tx
        .update(transactions)
        .set(
          key === ""
            ? { categoryId: null, categorySource: "none" }
            : { categoryId: key, categorySource: "rule" },
        )
        .where(inArray(transactions.id, batch));
    }
    changed += ids.length;
  }
  return changed;
}

/** Booked, not manual, and in no group or the only member of one. */
const FREE_LEG = and(
  eq(transactions.status, "booked"),
  ne(transactions.categorySource, "manual"),
  or(
    isNull(transactions.transferGroupId),
    sql`(select count(*) from ${transactions} as other
          where other.transfer_group_id = ${transactions.transferGroupId}) = 1`,
  ),
);

function toCandidate(row: CandidateRow): TransferCandidate {
  return {
    id: row.id,
    accountId: row.accountId,
    bookingDate: row.bookingDate,
    amountMinor: row.amountMinor,
    currency: row.currency,
    counterparty: row.counterparty,
    description: row.description,
    transferGroupId: row.transferGroupId,
    // A rule's spending or income category speaks against a transfer.
    eligible: row.categoryId === null || row.categoryKind === "transfer",
  };
}

function shiftDay(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

/** The legs a subject may pair with: same window, opposite amounts. */
async function loadPool(
  tx: Tx,
  subjects: readonly CandidateRow[],
): Promise<CandidateRow[]> {
  const days = subjects.map((row) => row.bookingDate).sort();
  const from = shiftDay(days[0], -TRANSFER_WINDOW_DAYS);
  const to = shiftDay(days.at(-1)!, TRANSFER_WINDOW_DAYS);
  const amounts = [...new Set(subjects.map((row) => -row.amountMinor))];
  const pool: CandidateRow[] = [];
  for (const batch of batches(amounts)) {
    pool.push(
      ...(await selectRows(
        tx,
        and(
          FREE_LEG,
          gte(transactions.bookingDate, from),
          lte(transactions.bookingDate, to),
          inArray(transactions.amountMinor, batch),
        ),
      )),
    );
  }
  return pool;
}

/** Returns how many transactions were linked. */
async function linkTransfers(tx: Tx, scope: Scope): Promise<number> {
  const subjects = await loadScope(tx, scope, FREE_LEG);
  if (subjects.length === 0) return 0;
  const pool = scope === "all" ? subjects : await loadPool(tx, subjects);
  const ownAccounts = await tx
    .select({ id: accounts.id, iban: accounts.iban })
    .from(accounts);

  const { pairs, oneSided } = findTransfers({
    subjects: subjects.map(toCandidate),
    pool: pool.map(toCandidate),
    accounts: ownAccounts,
  });
  if (pairs.length === 0 && oneSided.length === 0) return 0;

  const categoryId = await transfersCategoryId(tx);
  const link = async (ids: string[], groupId: string) => {
    await tx
      .update(transactions)
      .set({ categoryId, categorySource: "rule", transferGroupId: groupId })
      .where(inArray(transactions.id, ids));
  };
  let linked = 0;
  for (const pair of pairs) {
    await link(pair.ids, pair.groupId ?? randomUUID());
    linked += pair.groupId === null ? 2 : 1;
  }
  for (const id of oneSided) {
    await link([id], randomUUID());
    linked++;
  }
  return linked;
}

/** The top-level Transfers category; created when it is missing. */
async function transfersCategoryId(tx: Tx): Promise<string> {
  const where = and(
    isNull(categories.parentId),
    eq(categories.name, TRANSFERS_CATEGORY),
  );
  const [existing] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(where);
  if (existing) return existing.id;
  await tx
    .insert(categories)
    .values({ name: TRANSFERS_CATEGORY, kind: "transfer", color: "#64748b" })
    .onConflictDoNothing();
  const [created] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(where);
  return created.id;
}
