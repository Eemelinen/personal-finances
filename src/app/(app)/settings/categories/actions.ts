"use server";

import { refresh } from "next/cache";
import { verifySession } from "@/lib/auth/session";
import {
  reapplyRules,
  type CategorizeSummary,
} from "@/server/categorization/categorize";
import type { CategoryKind } from "@/server/categorization/defaults";
import {
  CategoryManageError,
  createCategory,
  createRule,
  deleteCategory,
  deleteRule,
  moveRule,
  renameCategory,
} from "@/server/categorization/manage";
import {
  parseRuleInput,
  type MovePlace,
} from "@/server/categorization/rule-input";
import { isUuid } from "@/server/queries/transaction-filter";
import { userError, type ActionResult } from "./action-result";

// /settings/categories (F-015): categories, rules and re-applying them.
// "Create a rule from a transaction" on /transactions uses `addRule` too.

function requireId(value: unknown, what: string): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new CategoryManageError(`Choose ${what}.`);
  }
  return value.toLowerCase();
}

const KINDS: readonly CategoryKind[] = ["expense", "income", "transfer"];

export async function addCategory(input: {
  name: string;
  parentId: string;
  kind: string;
}): Promise<ActionResult<{ id: string }>> {
  await verifySession();
  try {
    const kind = KINDS.find((value) => value === input.kind);
    if (!kind) throw new CategoryManageError("Choose a kind.");
    const id = await createCategory({
      name: String(input.name ?? ""),
      parentId:
        input.parentId === "" ? null : requireId(input.parentId, "a parent"),
      kind,
    });
    refresh();
    return { ok: true, id };
  } catch (error) {
    return userError(error);
  }
}

export async function renameCategoryAction(
  id: string,
  name: string,
): Promise<ActionResult> {
  await verifySession();
  try {
    await renameCategory(requireId(id, "a category"), String(name ?? ""));
    refresh();
    return { ok: true };
  } catch (error) {
    return userError(error);
  }
}

export async function removeCategory(id: string): Promise<ActionResult> {
  await verifySession();
  try {
    await deleteCategory(requireId(id, "a category"));
    refresh();
    return { ok: true };
  } catch (error) {
    return userError(error);
  }
}

export interface NewRuleFields {
  categoryId: string;
  matchField: string;
  matchType: string;
  pattern: string;
  amountSign: string;
  amountMin: string;
  amountMax: string;
  /** Re-apply every rule to past transactions afterwards. */
  applyToPast?: boolean;
}

export async function addRule(
  fields: NewRuleFields,
): Promise<ActionResult<{ id: string; reapplied: CategorizeSummary | null }>> {
  await verifySession();
  try {
    const input = parseRuleInput({ ...fields });
    if (!input.ok) throw new CategoryManageError(input.error);
    const id = await createRule(input.rule);
    const reapplied = fields.applyToPast === true ? await reapplyRules() : null;
    if (reapplied) {
      console.info(
        `[rules] re-applied: ${reapplied.recategorized} recategorised, ${reapplied.transfers} linked`,
      );
    }
    refresh();
    return { ok: true, id, reapplied };
  } catch (error) {
    return userError(error);
  }
}

export async function removeRule(id: string): Promise<ActionResult> {
  await verifySession();
  try {
    await deleteRule(requireId(id, "a rule"));
    refresh();
    return { ok: true };
  } catch (error) {
    return userError(error);
  }
}

export async function moveRuleAction(
  id: string,
  targetId: string,
  place: MovePlace,
): Promise<ActionResult> {
  await verifySession();
  try {
    if (place !== "before" && place !== "after") {
      throw new CategoryManageError("Choose where to move the rule.");
    }
    await moveRule(
      requireId(id, "a rule"),
      requireId(targetId, "a rule"),
      place,
    );
    refresh();
    return { ok: true };
  } catch (error) {
    return userError(error);
  }
}

export async function reapplyAllRules(): Promise<
  ActionResult<{ summary: CategorizeSummary }>
> {
  await verifySession();
  const summary = await reapplyRules();
  console.info(
    `[rules] re-applied: ${summary.recategorized} recategorised, ${summary.transfers} linked`,
  );
  refresh();
  return { ok: true, summary };
}
