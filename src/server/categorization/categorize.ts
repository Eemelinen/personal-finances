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
  not,
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
import {
  DEFAULT_CATEGORIES,
  EXCLUDED_CATEGORY,
  TRANSFERS_CATEGORY,
} from "./defaults";
import { compileRules, ruleOutcome, type CompiledRule } from "./rules";
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
//   version to the hook again. An excluded leg (category kind `excluded`,
//   F-027) never pairs.

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
  counterpartyIban: transactions.counterpartyIban,
  description: transactions.description,
  status: transactions.status,
  categoryId: transactions.categoryId,
  categorySource: transactions.categorySource,
  transferGroupId: transactions.transferGroupId,
};

function selectRows(tx: Tx, where: SQL | undefined) {
  return tx
    .select(CANDIDATE_COLUMNS)
    .from(transactions)
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

/** Any constant; serialises categorisation (D-020). */
const CATEGORIZE_LOCK = 0x46_14_c;

/**
 * Serialises categorisation for the rest of the transaction: two runs at
 * once (a re-apply and an import, or two re-applies) would update
 * overlapping rows in different orders and could deadlock, and could each
 * link the same free leg. A writer that changes stored transactions before
 * its hook runs (the sync) takes it first, so it never holds row locks a
 * running re-apply waits for.
 */
export async function lockCategorization(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${CATEGORIZE_LOCK})`);
}

async function categorize(tx: Tx, scope: Scope): Promise<CategorizeSummary> {
  await lockCategorization(tx);
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
    const outcome = ruleOutcome(rules, row);
    if (!outcome.change) continue;
    const key = outcome.categoryId ?? "";
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
        // Checked again: a manual edit may have committed since the read.
        .where(
          and(
            inArray(transactions.id, batch),
            ne(transactions.categorySource, "manual"),
            isNull(transactions.transferGroupId),
          ),
        );
    }
    changed += ids.length;
  }
  return changed;
}

/**
 * The transaction is in a category of kind `excluded` (F-027): it counts
 * in no report and is never a transfer leg.
 */
export const IS_EXCLUDED = sql`exists (select 1 from ${categories}
  where ${categories.id} = ${transactions.categoryId}
    and ${categories.kind} = 'excluded')`;

/**
 * Booked, not manual, not excluded (a rule may exclude a leg; an IBAN in
 * its texts does not bring it back), and in no group or the only member of
 * one. The subquery's `other` alias hides the outer table, so
 * `"transactions"."transfer_group_id"` is the outer row's group.
 */
const FREE_LEG = and(
  eq(transactions.status, "booked"),
  ne(transactions.categorySource, "manual"),
  not(IS_EXCLUDED),
  or(
    isNull(transactions.transferGroupId),
    sql`(select count(*) from ${transactions} as other
          where other.transfer_group_id = ${transactions.transferGroupId}) = 1`,
  ),
);

function toCandidate(
  row: CandidateRow,
  transfersId: string | null,
): TransferCandidate {
  return {
    id: row.id,
    accountId: row.accountId,
    bookingDate: row.bookingDate,
    amountMinor: row.amountMinor,
    currency: row.currency,
    counterparty: row.counterparty,
    counterpartyIban: row.counterpartyIban,
    description: row.description,
    transferGroupId: row.transferGroupId,
    // Any category a rule gave but Transfers speaks against a transfer
    // (a Nordnet payment is Savings & investments until Nordnet is an
    // own account, F-020).
    eligible: row.categoryId === null || row.categoryId === transfersId,
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

  const transfersId = await findTransfersCategory(tx);
  const { pairs, oneSided } = findTransfers({
    subjects: subjects.map((row) => toCandidate(row, transfersId)),
    pool: pool.map((row) => toCandidate(row, transfersId)),
    accounts: ownAccounts,
  });
  if (pairs.length === 0 && oneSided.length === 0) return 0;

  const categoryId = transfersId ?? (await createTransfersCategory(tx));
  const link = async (ids: string[], groupId: string) => {
    await tx
      .update(transactions)
      .set({ categoryId, categorySource: "rule", transferGroupId: groupId })
      .where(
        and(
          inArray(transactions.id, ids),
          ne(transactions.categorySource, "manual"),
        ),
      );
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

/** A top-level category by name, if it exists. */
async function findTopLevelCategory(
  tx: Tx,
  name: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(and(isNull(categories.parentId), eq(categories.name, name)));
  return row?.id ?? null;
}

/** Creates a default top-level category (unseeded databases); its id. */
async function createTopLevelCategory(tx: Tx, name: string): Promise<string> {
  const { kind, color } = DEFAULT_CATEGORIES.find(
    (category) => category.name === name,
  )!;
  await tx
    .insert(categories)
    .values({ name, kind, color })
    .onConflictDoNothing();
  return (await findTopLevelCategory(tx, name))!;
}

/** The top-level Transfers category, if it exists. */
function findTransfersCategory(tx: Tx): Promise<string | null> {
  return findTopLevelCategory(tx, TRANSFERS_CATEGORY);
}

/** Creates the top-level Transfers category (unseeded databases). */
function createTransfersCategory(tx: Tx): Promise<string> {
  return createTopLevelCategory(tx, TRANSFERS_CATEGORY);
}

/** The top-level Transfers category's id; created when it is missing. */
export async function transfersCategoryId(tx: Tx): Promise<string> {
  return (
    (await findTransfersCategory(tx)) ?? (await createTransfersCategory(tx))
  );
}

/**
 * The top-level Excluded category's id (F-027); created when it is
 * missing, as in installations seeded before it existed.
 */
export async function excludedCategoryId(tx: Tx): Promise<string> {
  return (
    (await findTopLevelCategory(tx, EXCLUDED_CATEGORY)) ??
    (await createTopLevelCategory(tx, EXCLUDED_CATEGORY))
  );
}
