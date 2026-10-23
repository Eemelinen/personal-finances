import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { categories, categoryRules } from "@/server/db/schema";
import { DEFAULT_CATEGORIES, DEFAULT_RULES } from "./defaults";

// Writes the default categories and rules (`defaults.ts`) into an empty
// `categories` table, in one transaction; `src/server/db/migrate.ts` runs it
// after the migrations. A table with any category is left alone, so
// categories and rules the user deleted or changed (F-015) do not come
// back. A transaction-scoped advisory lock keeps two runs from seeding
// twice.

/** Seeded rule priorities: 100, 110, 120, … in `DEFAULT_RULES` order. */
const FIRST_PRIORITY = 100;
const PRIORITY_STEP = 10;

/** Any constant; identifies the seeding lock. */
const SEED_LOCK = 0x46_14;

export interface SeedResult {
  seeded: boolean;
  categories: number;
  rules: number;
}

export async function seedDefaults(db: Db): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SEED_LOCK})`);
    const [any] = await tx
      .select({ id: categories.id })
      .from(categories)
      .limit(1);
    if (any) return { seeded: false, categories: 0, rules: 0 };

    const ids = new Map<string, string>();
    for (const parent of DEFAULT_CATEGORIES) {
      const [row] = await tx
        .insert(categories)
        .values({ name: parent.name, kind: parent.kind, color: parent.color })
        .returning({ id: categories.id });
      ids.set(parent.name, row.id);
      if (parent.children.length === 0) continue;
      const children = await tx
        .insert(categories)
        .values(
          parent.children.map((name) => ({
            name,
            parentId: row.id,
            kind: parent.kind,
            color: parent.color,
          })),
        )
        .returning({ id: categories.id, name: categories.name });
      for (const child of children) {
        ids.set(`${parent.name}/${child.name}`, child.id);
      }
    }

    const rules = DEFAULT_RULES.map((rule, index) => {
      const categoryId = ids.get(rule.category);
      if (!categoryId) {
        throw new Error(`Unknown default category ${rule.category}`);
      }
      return {
        categoryId,
        matchField: rule.matchField,
        matchType: rule.matchType,
        pattern: rule.pattern,
        amountSign: rule.amountSign ?? null,
        priority: FIRST_PRIORITY + index * PRIORITY_STEP,
      };
    });
    await tx.insert(categoryRules).values(rules);
    return { seeded: true, categories: ids.size, rules: rules.length };
  });
}

/** A seeded category's id by `Parent/Child` or top-level name, for tests and tools. */
export async function categoryIdByPath(
  db: Pick<Db, "select">,
  path: string,
): Promise<string | null> {
  const [parentName, childName] = path.split("/");
  const [parent] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(isNull(categories.parentId), eq(categories.name, parentName)));
  if (!parent || childName === undefined) return parent?.id ?? null;
  const [child] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(eq(categories.parentId, parent.id), eq(categories.name, childName)),
    );
  return child?.id ?? null;
}
