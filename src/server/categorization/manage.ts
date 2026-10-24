import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  min,
  sql,
} from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { categories, categoryRules, transactions } from "@/server/db/schema";
import type { Tx } from "@/server/sync/runs";
import { lockCategorization, transfersCategoryId } from "./categorize";
import { TRANSFERS_CATEGORY, type CategoryKind } from "./defaults";
import {
  MAX_CATEGORY_NAME_LENGTH,
  moveRuleIds,
  type MovePlace,
  type RuleInput,
} from "./rule-input";
import { compareRules } from "./rules";

// Categories and rules as /settings/categories manages them (F-015).
//
// - Categories have two levels: a subcategory's parent is top-level and the
//   subcategory takes its kind. Deleting a category deletes its
//   subcategories and their rules; their transactions lose the category and
//   go back to the rules (`none`), manual ones too; transfer legs get
//   Transfers. The top-level Transfers
//   category, which transfer detection assigns, cannot be deleted.
// - A new rule runs first (priority below every other rule): it is usually
//   more specific than the ones before it. Moving a rule renumbers every
//   rule in steps of 10 in the new order. Both take an advisory lock, so two
//   writers never number rules from the same stale order.

/** A change the user asked for that cannot be made; the message says why. */
export class CategoryManageError extends Error {
  override readonly name = "CategoryManageError";
}

/** Any constant; serialises rule numbering. */
const RULE_ORDER_LOCK = 0x46_15;
const PRIORITY_STEP = 10;

export interface CategoryOption {
  id: string;
  name: string;
  parentId: string | null;
  kind: CategoryKind;
  color: string | null;
  /** `Parent › Child`, or the name of a top-level category. */
  label: string;
}

/** Every category, parents first and each followed by its children (by name). */
export async function listCategoryOptions(
  options: { db?: Db } = {},
): Promise<CategoryOption[]> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      parentId: categories.parentId,
      kind: categories.kind,
      color: categories.color,
    })
    .from(categories);
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, "fi");
  const parents = rows.filter((row) => row.parentId === null).sort(byName);
  const result: CategoryOption[] = [];
  for (const parent of parents) {
    result.push({ ...parent, label: parent.name });
    for (const child of rows
      .filter((row) => row.parentId === parent.id)
      .sort(byName)) {
      result.push({ ...child, label: `${parent.name} › ${child.name}` });
    }
  }
  return result;
}

export interface CategoryUsage extends CategoryOption {
  rules: number;
  transactions: number;
  /** The top-level Transfers category: no rename or delete. */
  protected: boolean;
}

/** Transfer detection needs the top-level Transfers category. */
function isTransfersCategory(
  category: Pick<CategoryOption, "name" | "parentId">,
): boolean {
  return category.parentId === null && category.name === TRANSFERS_CATEGORY;
}

/** The categories with how many rules and transactions use each one. */
export async function listCategoryUsage(
  options: { db?: Db } = {},
): Promise<CategoryUsage[]> {
  const db = options.db ?? getDb();
  const [list, ruleCounts, transactionCounts] = await Promise.all([
    listCategoryOptions({ db }),
    db
      .select({ id: categoryRules.categoryId, count: count() })
      .from(categoryRules)
      .groupBy(categoryRules.categoryId),
    db
      .select({ id: transactions.categoryId, count: count() })
      .from(transactions)
      .groupBy(transactions.categoryId),
  ]);
  const rules = new Map(ruleCounts.map((row) => [row.id, row.count]));
  const used = new Map(transactionCounts.map((row) => [row.id, row.count]));
  return list.map((category) => ({
    ...category,
    rules: rules.get(category.id) ?? 0,
    transactions: used.get(category.id) ?? 0,
    protected: isTransfersCategory(category),
  }));
}

function categoryName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (name === "") throw new CategoryManageError("Enter a name.");
  if (name.length > MAX_CATEGORY_NAME_LENGTH) {
    throw new CategoryManageError(
      `The name is longer than ${MAX_CATEGORY_NAME_LENGTH} characters.`,
    );
  }
  return name;
}

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ((cause as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
  }
  return false;
}

export interface NewCategory {
  name: string;
  /** Null: a top-level category. */
  parentId: string | null;
  /** Ignored for a subcategory, which takes its parent's kind. */
  kind: CategoryKind;
  color?: string | null;
}

export async function createCategory(
  input: NewCategory,
  options: { db?: Db } = {},
): Promise<string> {
  const db = options.db ?? getDb();
  const name = categoryName(input.name);
  let kind = input.kind;
  let color = input.color ?? null;
  if (input.parentId !== null) {
    const [parent] = await db
      .select({
        parentId: categories.parentId,
        kind: categories.kind,
        color: categories.color,
      })
      .from(categories)
      .where(eq(categories.id, input.parentId));
    if (!parent) throw new CategoryManageError("The parent category is gone.");
    if (parent.parentId !== null) {
      throw new CategoryManageError("A subcategory cannot have subcategories.");
    }
    kind = parent.kind;
    color ??= parent.color;
  }
  try {
    const [row] = await db
      .insert(categories)
      .values({ name, parentId: input.parentId, kind, color })
      .returning({ id: categories.id });
    return row.id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CategoryManageError(`A category ${name} already exists here.`);
    }
    throw error;
  }
}

export async function renameCategory(
  id: string,
  newName: string,
  options: { db?: Db } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const name = categoryName(newName);
  const [current] = await db
    .select({ name: categories.name, parentId: categories.parentId })
    .from(categories)
    .where(eq(categories.id, id));
  if (!current) throw new CategoryManageError("The category is gone.");
  if (isTransfersCategory(current)) {
    throw new CategoryManageError(
      `${TRANSFERS_CATEGORY} is used by transfer detection and keeps its name.`,
    );
  }
  try {
    await db.update(categories).set({ name }).where(eq(categories.id, id));
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CategoryManageError(`A category ${name} already exists here.`);
    }
    throw error;
  }
}

/** Deletes the category, its subcategories and their rules. */
export async function deleteCategory(
  id: string,
  options: { db?: Db } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db.transaction(async (tx) => {
    // Rewrites the category of many rows: serialised with re-apply (D-020).
    await lockCategorization(tx);
    const [current] = await tx
      .select({ name: categories.name, parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.id, id));
    if (!current) throw new CategoryManageError("The category is gone.");
    if (isTransfersCategory(current)) {
      throw new CategoryManageError(
        `${TRANSFERS_CATEGORY} is used by transfer detection and cannot be deleted.`,
      );
    }
    const ids = [
      id,
      ...(
        await tx
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.parentId, id))
      ).map((row) => row.id),
    ];
    // The foreign key would only null the category; the source goes too.
    // Transfer legs keep Transfers (and their source): the rules skip them.
    await tx
      .update(transactions)
      .set({ categoryId: null, categorySource: "none" })
      .where(
        and(
          inArray(transactions.categoryId, ids),
          isNull(transactions.transferGroupId),
        ),
      );
    await tx
      .update(transactions)
      .set({ categoryId: await transfersCategoryId(tx) })
      .where(
        and(
          inArray(transactions.categoryId, ids),
          isNotNull(transactions.transferGroupId),
        ),
      );
    await tx.delete(categories).where(eq(categories.id, id));
  });
}

export interface RuleListItem {
  id: string;
  categoryId: string;
  categoryLabel: string;
  matchField: "counterparty" | "description";
  matchType: "contains" | "equals" | "regex";
  pattern: string;
  amountSign: "debit" | "credit" | null;
  amountMinMinor: number | null;
  amountMaxMinor: number | null;
  priority: number;
}

/** Every rule in the order the engine runs them. */
export async function listRules(
  options: { db?: Db } = {},
): Promise<RuleListItem[]> {
  const db = options.db ?? getDb();
  const [rows, labels] = await Promise.all([
    db.select().from(categoryRules),
    listCategoryOptions({ db }),
  ]);
  const label = new Map(labels.map((option) => [option.id, option.label]));
  return rows.sort(compareRules).map((row) => ({
    id: row.id,
    categoryId: row.categoryId,
    categoryLabel: label.get(row.categoryId) ?? "",
    matchField: row.matchField,
    matchType: row.matchType,
    pattern: row.pattern,
    amountSign: row.amountSign,
    amountMinMinor: row.amountMinMinor,
    amountMaxMinor: row.amountMaxMinor,
    priority: row.priority,
  }));
}

async function lockRuleOrder(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${RULE_ORDER_LOCK})`);
}

/** Adds the rule in front of every other rule; returns its id. */
export async function createRule(
  rule: RuleInput,
  options: { db?: Db } = {},
): Promise<string> {
  const db = options.db ?? getDb();
  return db.transaction(async (tx) => {
    await lockRuleOrder(tx);
    const [category] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, rule.categoryId));
    if (!category) throw new CategoryManageError("The category is gone.");
    const [{ first }] = await tx
      .select({ first: min(categoryRules.priority) })
      .from(categoryRules);
    const [row] = await tx
      .insert(categoryRules)
      .values({
        ...rule,
        priority: first === null ? 100 : first - PRIORITY_STEP,
      })
      .returning({ id: categoryRules.id });
    return row.id;
  });
}

export async function deleteRule(
  id: string,
  options: { db?: Db } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db.delete(categoryRules).where(eq(categoryRules.id, id));
}

/**
 * Moves the rule to just before or after `targetId` in the rule order and
 * renumbers every rule 10, 20, 30, … in the new order.
 */
export async function moveRule(
  id: string,
  targetId: string,
  place: MovePlace,
  options: { db?: Db } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db.transaction(async (tx) => {
    await lockRuleOrder(tx);
    const rows = await tx
      .select({
        id: categoryRules.id,
        priority: categoryRules.priority,
        createdAt: categoryRules.createdAt,
      })
      .from(categoryRules);
    const ids = rows.sort(compareRules).map((row) => row.id);
    if (!ids.includes(id) || !ids.includes(targetId)) {
      throw new CategoryManageError("The rule is gone.");
    }
    const priority = new Map(rows.map((row) => [row.id, row.priority]));
    const changed = moveRuleIds(ids, id, targetId, place)
      .map((ruleId, index) => ({
        id: ruleId,
        priority: (index + 1) * PRIORITY_STEP,
      }))
      .filter((row) => priority.get(row.id) !== row.priority);
    if (changed.length === 0) return;
    const cases = sql.join(
      changed.map(
        (row) => sql`when ${row.id}::uuid then ${row.priority}::integer`,
      ),
      sql` `,
    );
    await tx
      .update(categoryRules)
      .set({ priority: sql`case ${categoryRules.id} ${cases} end` })
      .where(
        inArray(
          categoryRules.id,
          changed.map((row) => row.id),
        ),
      );
  });
}

/** Whether a category exists (for the inline category change). */
export async function categoryExists(
  tx: Db | Tx,
  id: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.id, id));
  return row !== undefined;
}
