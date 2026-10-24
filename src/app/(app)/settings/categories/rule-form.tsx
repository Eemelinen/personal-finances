"use client";

import { useId, useState, useTransition } from "react";
import { NativeSelect } from "@/components/form-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CategoryOption } from "@/server/categorization/manage";
import { MAX_PATTERN_LENGTH } from "@/server/categorization/rule-input";
import { addRule, type NewRuleFields } from "./actions";

// The "new rule" form of /settings/categories, also used to create a rule
// from a transaction on /transactions (with "apply to similar past ones").

export type RuleDraft = Omit<NewRuleFields, "applyToPast">;

export const EMPTY_RULE: RuleDraft = {
  categoryId: "",
  matchField: "counterparty",
  matchType: "contains",
  pattern: "",
  amountSign: "",
  amountMin: "",
  amountMax: "",
};

interface RuleFormProps {
  categories: CategoryOption[];
  initial?: RuleDraft;
  /** Offer re-applying the rules to past transactions (checked by default). */
  offerApplyToPast?: boolean;
  submitLabel?: string;
}

export function RuleForm({
  categories,
  initial = EMPTY_RULE,
  offerApplyToPast = false,
  submitLabel = "Add rule",
}: RuleFormProps) {
  const ids = useId();
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [applyToPast, setApplyToPast] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const set = (field: keyof RuleDraft) => (value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await addRule({
        ...draft,
        applyToPast: offerApplyToPast && applyToPast,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const changed = result.reapplied
        ? ` ${result.reapplied.recategorized} ${
            result.reapplied.recategorized === 1
              ? "transaction"
              : "transactions"
          } re-categorised.`
        : "";
      setMessage(`Rule created.${changed}`);
      if (!offerApplyToPast)
        setDraft({ ...initial, categoryId: draft.categoryId });
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-field`}>Match field</Label>
          <NativeSelect
            id={`${ids}-field`}
            value={draft.matchField}
            onChange={(event) => set("matchField")(event.target.value)}
          >
            <option value="counterparty">Counterparty</option>
            <option value="description">Description</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-type`}>Match type</Label>
          <NativeSelect
            id={`${ids}-type`}
            value={draft.matchType}
            onChange={(event) => set("matchType")(event.target.value)}
          >
            <option value="contains">Contains</option>
            <option value="equals">Equals</option>
            <option value="regex">Regular expression</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor={`${ids}-pattern`}>Pattern</Label>
          <Input
            id={`${ids}-pattern`}
            value={draft.pattern}
            maxLength={MAX_PATTERN_LENGTH}
            onChange={(event) => set("pattern")(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor={`${ids}-category`}>Rule category</Label>
          <NativeSelect
            id={`${ids}-category`}
            value={draft.categoryId}
            onChange={(event) => set("categoryId")(event.target.value)}
          >
            <option value="" disabled>
              Choose…
            </option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-sign`}>Direction</Label>
          <NativeSelect
            id={`${ids}-sign`}
            value={draft.amountSign}
            onChange={(event) => set("amountSign")(event.target.value)}
          >
            <option value="">Debits and credits</option>
            <option value="debit">Only debits (money out)</option>
            <option value="credit">Only credits (money in)</option>
          </NativeSelect>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-min`}>Min €</Label>
            <Input
              id={`${ids}-min`}
              inputMode="decimal"
              value={draft.amountMin}
              onChange={(event) => set("amountMin")(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-max`}>Max €</Label>
            <Input
              id={`${ids}-max`}
              inputMode="decimal"
              value={draft.amountMax}
              onChange={(event) => set("amountMax")(event.target.value)}
            />
          </div>
        </div>
      </div>
      {offerApplyToPast && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={applyToPast}
            onChange={(event) => setApplyToPast(event.target.checked)}
          />
          Apply to similar past transactions
        </label>
      )}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
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
    </form>
  );
}
