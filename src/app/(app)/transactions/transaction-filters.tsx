"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId } from "react";
import { NativeSelect } from "@/components/form-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CategoryOption } from "@/server/categorization/manage";
import {
  MAX_TEXT_LENGTH,
  NO_CATEGORY,
  parseTransactionQuery,
  transactionsHref,
  type SearchParams,
  type TransactionFilter,
} from "@/server/queries/transaction-filter";
import type { AccountOption } from "@/server/queries/transactions";

// The /transactions filter form. Applying it navigates to the URL of the
// filter (only the fields that are set, back to page 1); the page reads
// everything from the URL, so a filtered view can be bookmarked or shared.

interface TransactionFiltersProps {
  filter: TransactionFilter;
  accounts: AccountOption[];
  categories: CategoryOption[];
}

export function TransactionFilters({
  filter,
  accounts,
  categories,
}: TransactionFiltersProps) {
  const ids = useId();
  const router = useRouter();

  const apply = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const params: SearchParams = {};
    for (const [key, value] of new FormData(event.currentTarget)) {
      if (typeof value !== "string") continue;
      const current = params[key];
      params[key] =
        current === undefined
          ? value
          : [...(Array.isArray(current) ? current : [current]), value];
    }
    router.push(transactionsHref(parseTransactionQuery(params).filter));
  };

  return (
    <form
      aria-label="Filters"
      onSubmit={apply}
      className="flex flex-col gap-4 rounded-xl border p-4"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-q`}>Search</Label>
          <Input
            id={`${ids}-q`}
            name="q"
            type="search"
            defaultValue={filter.text}
            maxLength={MAX_TEXT_LENGTH}
            placeholder="Counterparty, description or note"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-from`}>From</Label>
            <Input
              id={`${ids}-from`}
              name="from"
              type="date"
              defaultValue={filter.from ?? ""}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-to`}>To</Label>
            <Input
              id={`${ids}-to`}
              name="to"
              type="date"
              defaultValue={filter.to ?? ""}
            />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-category`}>Category</Label>
          <NativeSelect
            id={`${ids}-category`}
            name="category"
            defaultValue={filter.category ?? ""}
          >
            <option value="">Any category</option>
            <option value={NO_CATEGORY}>No category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-type`}>Income or expense</Label>
          <NativeSelect
            id={`${ids}-type`}
            name="type"
            defaultValue={filter.direction ?? ""}
          >
            <option value="">Income and expenses</option>
            <option value="income">Income only</option>
            <option value="expense">Expenses only</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-transfers`}>Transfers</Label>
          <NativeSelect
            id={`${ids}-transfers`}
            name="transfers"
            defaultValue={filter.transfers ?? ""}
          >
            <option value="">Include transfers</option>
            <option value="exclude">Exclude transfers</option>
            <option value="only">Only transfers</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-excluded`}>Excluded</Label>
          <NativeSelect
            id={`${ids}-excluded`}
            name="excluded"
            defaultValue={filter.excluded ?? ""}
          >
            <option value="">Excluded and not excluded</option>
            <option value="exclude">Not excluded</option>
            <option value="only">Excluded only</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-household`}>Household</Label>
          <NativeSelect
            id={`${ids}-household`}
            name="household"
            defaultValue={filter.household ?? ""}
          >
            <option value="">With and without household members</option>
            <option value="exclude">Without household members</option>
            <option value="only">Household only</option>
          </NativeSelect>
        </div>
      </div>
      {accounts.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Accounts</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {accounts.map((account) => (
              <label
                key={account.id}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  name="account"
                  value={account.id}
                  defaultChecked={filter.accounts.includes(account.id)}
                />
                {account.name}
                <span className="text-muted-foreground">
                  {account.institution}
                  {account.archived ? ", archived" : ""}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex gap-2">
        <Button type="submit">Apply filters</Button>
        <Button asChild variant="outline">
          <Link href="/transactions">Clear</Link>
        </Button>
      </div>
    </form>
  );
}
