"use client";

import { useId, useState, useTransition } from "react";
import { NativeSelect } from "@/components/form-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/format";
import type {
  CategoryUsage,
  RuleListItem,
} from "@/server/categorization/manage";
import { MAX_CATEGORY_NAME_LENGTH } from "@/server/categorization/rule-input";
import type { ActionResult } from "./action-result";
import {
  addCategory,
  moveRuleAction,
  reapplyAllRules,
  removeCategory,
  removeRule,
  renameCategoryAction,
} from "./actions";
import { RuleForm } from "./rule-form";

// /settings/categories: categories (add, rename, delete), rules (add,
// reorder, delete; optionally only one category's rules) and re-applying
// every rule to past transactions.

const KIND_LABELS = {
  expense: "Expense",
  income: "Income",
  transfer: "Transfer",
} as const;

interface CategoriesManagerProps {
  categories: CategoryUsage[];
  rules: RuleListItem[];
}

export function CategoriesManager({
  categories,
  rules,
}: CategoriesManagerProps) {
  const ids = useId();
  return (
    <div className="flex flex-col gap-8">
      <section
        aria-labelledby={`${ids}-rules`}
        className="flex flex-col gap-4 rounded-xl border p-4"
      >
        <h2 id={`${ids}-rules`} className="text-lg font-medium">
          Rules
        </h2>
        <RulesSection categories={categories} rules={rules} />
      </section>
      <section
        aria-labelledby={`${ids}-categories`}
        className="flex flex-col gap-4 rounded-xl border p-4"
      >
        <h2 id={`${ids}-categories`} className="text-lg font-medium">
          Categories
        </h2>
        <NewCategoryForm categories={categories} />
        <CategoryTable categories={categories} />
      </section>
    </div>
  );
}

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = <T,>(
    action: () => Promise<ActionResult<T>>,
    done?: (result: { ok: true } & T) => string | null,
  ) => {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
      else setMessage(done?.(result) ?? null);
    });
  };
  const feedback = (
    <>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </>
  );
  return { run, pending, feedback };
}

function RulesSection({
  categories,
  rules,
}: {
  categories: CategoryUsage[];
  rules: RuleListItem[];
}) {
  const ids = useId();
  const [shown, setShown] = useState("");
  const { run, pending, feedback } = useAction();
  const visible = shown
    ? rules.filter((rule) => rule.categoryId === shown)
    : rules;

  return (
    <>
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          New rule
        </summary>
        <div className="mt-3">
          <RuleForm categories={categories} />
        </div>
      </details>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-64 flex-col gap-2">
          <Label htmlFor={`${ids}-shown`}>Show rules of</Label>
          <NativeSelect
            id={`${ids}-shown`}
            value={shown}
            onChange={(event) => setShown(event.target.value)}
          >
            <option value="">Every category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() =>
            run(
              reapplyAllRules,
              ({ summary }) =>
                `Rules re-applied: ${summary.recategorized} re-categorised, ${summary.transfers} linked as transfers.`,
            )
          }
        >
          Re-apply rules to all transactions
        </Button>
      </div>
      {feedback}
      {visible.length === 0 ? (
        <p className="text-muted-foreground text-sm">No rules.</p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm" aria-label="Rules">
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-2 pr-3 font-medium">
                  #
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Match
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Conditions
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Category
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((rule, index) => (
                <tr
                  key={rule.id}
                  className="border-b last:border-0"
                  data-testid="rule-row"
                >
                  <td className="text-muted-foreground py-2 pr-3 tabular-nums">
                    {rules.indexOf(rule) + 1}
                  </td>
                  <td className="py-2 pr-3">
                    <span className="text-muted-foreground">
                      {rule.matchField === "counterparty"
                        ? "Counterparty"
                        : "Description"}{" "}
                      {rule.matchType === "regex"
                        ? "matches"
                        : rule.matchType}{" "}
                    </span>
                    <code className="font-mono" data-testid="rule-pattern">
                      {rule.pattern}
                    </code>
                  </td>
                  <td className="text-muted-foreground py-2 pr-3">
                    {conditions(rule)}
                  </td>
                  <td className="py-2 pr-3">{rule.categoryLabel}</td>
                  <td className="py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending || index === 0}
                        onClick={() =>
                          run(() =>
                            moveRuleAction(
                              rule.id,
                              visible[index - 1].id,
                              "before",
                            ),
                          )
                        }
                      >
                        Move up
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending || index === visible.length - 1}
                        onClick={() =>
                          run(() =>
                            moveRuleAction(
                              rule.id,
                              visible[index + 1].id,
                              "after",
                            ),
                          )
                        }
                      >
                        Move down
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => run(() => removeRule(rule.id))}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function conditions(rule: RuleListItem): string {
  const parts: string[] = [];
  if (rule.amountSign === "debit") parts.push("debits");
  if (rule.amountSign === "credit") parts.push("credits");
  const euros = (minor: number) => formatMoney(minor, "EUR");
  if (rule.amountMinMinor !== null && rule.amountMaxMinor !== null) {
    parts.push(`${euros(rule.amountMinMinor)} – ${euros(rule.amountMaxMinor)}`);
  } else if (rule.amountMinMinor !== null) {
    parts.push(`at least ${euros(rule.amountMinMinor)}`);
  } else if (rule.amountMaxMinor !== null) {
    parts.push(`at most ${euros(rule.amountMaxMinor)}`);
  }
  return parts.join(", ");
}

function NewCategoryForm({ categories }: { categories: CategoryUsage[] }) {
  const ids = useId();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [kind, setKind] = useState("expense");
  const { run, pending, feedback } = useAction();
  const parents = categories.filter((category) => category.parentId === null);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(
      () => addCategory({ name, parentId, kind }),
      () => {
        setName("");
        return `Category ${name.trim()} added.`;
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor={`${ids}-name`}>New category</Label>
          <Input
            id={`${ids}-name`}
            value={name}
            maxLength={MAX_CATEGORY_NAME_LENGTH}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-parent`}>Parent</Label>
          <NativeSelect
            id={`${ids}-parent`}
            value={parentId}
            onChange={(event) => setParentId(event.target.value)}
          >
            <option value="">None (top level)</option>
            {parents.map((parent) => (
              <option key={parent.id} value={parent.id}>
                {parent.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-kind`}>Kind</Label>
          <NativeSelect
            id={`${ids}-kind`}
            value={parentId ? "" : kind}
            disabled={parentId !== ""}
            onChange={(event) => setKind(event.target.value)}
          >
            {parentId && <option value="">As the parent</option>}
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          Add category
        </Button>
      </div>
      {feedback}
    </form>
  );
}

function CategoryTable({ categories }: { categories: CategoryUsage[] }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full text-sm" aria-label="Categories">
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="py-2 pr-3 font-medium">
              Name
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Kind
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Used by
            </th>
            <th scope="col" className="py-2 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {categories.map((category) => (
            <CategoryRow
              key={category.id}
              category={category}
              subcategories={categories.filter(
                (child) => child.parentId === category.id,
              )}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoryRow({
  category,
  subcategories,
}: {
  category: CategoryUsage;
  subcategories: CategoryUsage[];
}) {
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [name, setName] = useState(category.name);
  const { run, pending, feedback } = useAction();
  const rules = category.rules + subcategories.reduce((n, c) => n + c.rules, 0);
  const used =
    category.transactions +
    subcategories.reduce((n, c) => n + c.transactions, 0);

  return (
    <tr className="border-b align-top last:border-0" data-testid="category-row">
      <td className={`py-2 pr-3 ${category.parentId ? "pl-6" : "font-medium"}`}>
        {mode === "rename" ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              run(
                () => renameCategoryAction(category.id, name),
                () => {
                  setMode("view");
                  return null;
                },
              );
            }}
          >
            <Input
              aria-label="Category name"
              value={name}
              maxLength={MAX_CATEGORY_NAME_LENGTH}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={pending}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setName(category.name);
                setMode("view");
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <span className="flex items-center gap-2">
            {category.color && (
              <span
                aria-hidden="true"
                className="size-2.5 rounded-full"
                style={{ backgroundColor: category.color }}
              />
            )}
            {category.name}
          </span>
        )}
        {mode === "delete" && (
          <div className="mt-2 flex flex-col gap-2" role="group">
            <p className="text-sm">
              Delete {category.label}
              {subcategories.length > 0
                ? ` and its ${subcategories.length} ${subcategories.length === 1 ? "subcategory" : "subcategories"}`
                : ""}
              ? {rules} {rules === 1 ? "rule is" : "rules are"} deleted and{" "}
              {used} {used === 1 ? "transaction loses" : "transactions lose"}{" "}
              the category.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => run(() => removeCategory(category.id))}
              >
                Confirm delete
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setMode("view")}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {feedback}
      </td>
      <td className="text-muted-foreground py-2 pr-3">
        {KIND_LABELS[category.kind]}
      </td>
      <td className="text-muted-foreground py-2 pr-3 whitespace-nowrap">
        {category.rules} {category.rules === 1 ? "rule" : "rules"},{" "}
        {category.transactions}{" "}
        {category.transactions === 1 ? "transaction" : "transactions"}
      </td>
      <td className="py-2">
        {category.protected ? (
          <p className="text-muted-foreground text-right text-sm">
            Used by transfer detection
          </p>
        ) : (
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setMode("rename")}
            >
              Rename
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setMode("delete")}
            >
              Delete
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}
