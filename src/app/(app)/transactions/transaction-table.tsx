"use client";

import { useOptimistic, useState, useTransition } from "react";
import { NativeSelect } from "@/components/form-controls";
import { Button } from "@/components/ui/button";
import { formatDay, formatMoney } from "@/lib/format";
import type { CategoryOption } from "@/server/categorization/manage";
import type { TransactionRow } from "@/server/queries/transactions";
import { changeCategory } from "./actions";
import { TransactionDetails, transactionTitle } from "./transaction-details";

// One page of transactions. The category of each row can be changed in
// place (it becomes `manual`; "Automatic" hands it back to the rules);
// "Details" opens the note, transfer and rule actions in a side sheet.

interface TransactionTableProps {
  rows: TransactionRow[];
  categories: CategoryOption[];
}

export function TransactionTable({ rows, categories }: TransactionTableProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = rows.find((row) => row.id === openId) ?? null;

  return (
    <>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" aria-label="Transactions">
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-2 pr-3 font-medium">
                Date
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Account
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Counterparty or description
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Category
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Amount
              </th>
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className="border-b align-top last:border-0"
                data-testid="transaction-row"
              >
                <td className="py-2 pr-3 whitespace-nowrap">
                  {formatDay(row.bookingDate)}
                </td>
                <td className="py-2 pr-3">
                  <div>{row.accountName}</div>
                  <div className="text-muted-foreground text-xs">
                    {row.institutionName}
                  </div>
                </td>
                <td className="py-2 pr-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{transactionTitle(row)}</span>
                    {row.status === "pending" && <Badge>Pending</Badge>}
                    {row.transferGroupId && <Badge>Transfer</Badge>}
                  </div>
                  {row.counterparty && row.description && (
                    <div className="text-muted-foreground text-xs">
                      {row.description}
                    </div>
                  )}
                  {row.note && (
                    <div
                      className="text-muted-foreground text-xs italic"
                      data-testid="transaction-note"
                    >
                      {row.note}
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <CategoryCell
                    row={row}
                    categories={categories}
                    onError={setError}
                  />
                </td>
                <td
                  className={`py-2 pr-3 text-right whitespace-nowrap tabular-nums ${
                    row.amountMinor > 0
                      ? "text-green-700 dark:text-green-400"
                      : ""
                  }`}
                >
                  {formatMoney(row.amountMinor, row.currency)}
                </td>
                <td className="py-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setOpenId(row.id)}
                  >
                    Details
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TransactionDetails
        row={open}
        categories={categories}
        onClose={() => setOpenId(null)}
      />
    </>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-xs font-medium">
      {children}
    </span>
  );
}

const SOURCE_LABELS = { manual: "Manual", rule: "Rule", none: "" } as const;

function CategoryCell({
  row,
  categories,
  onError,
}: {
  row: TransactionRow;
  categories: CategoryOption[];
  onError: (error: string | null) => void;
}) {
  const [value, setOptimistic] = useOptimistic(row.categoryId ?? "");
  const [pending, startTransition] = useTransition();

  const change = (choice: string) => {
    onError(null);
    startTransition(async () => {
      setOptimistic(choice);
      const result = await changeCategory(row.id, choice);
      if (!result.ok) onError(result.error);
    });
  };

  return (
    <div className="flex min-w-48 flex-col gap-1">
      <NativeSelect
        aria-label="Category"
        value={value}
        disabled={pending}
        onChange={(event) => change(event.target.value)}
      >
        {value === "" && (
          <option value="" disabled>
            No category
          </option>
        )}
        <option value="auto">Automatic (rules)</option>
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.label}
          </option>
        ))}
      </NativeSelect>
      <span
        className="text-muted-foreground text-xs"
        data-testid="category-source"
      >
        {SOURCE_LABELS[row.categorySource]}
      </span>
    </div>
  );
}
