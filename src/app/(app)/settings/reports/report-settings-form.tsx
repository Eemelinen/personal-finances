"use client";

import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { saveReportSettings } from "./actions";

export function ReportSettingsForm({
  uncategorizedCreditsAsIncome,
}: {
  uncategorizedCreditsAsIncome: boolean;
}) {
  const id = useId();
  const [result, action, pending] = useActionState(saveReportSettings, null);
  return (
    <form action={action} className="flex flex-col gap-4 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <input
          id={`${id}-uncategorized`}
          type="checkbox"
          name="uncategorizedCreditsAsIncome"
          defaultChecked={uncategorizedCreditsAsIncome}
          aria-describedby={`${id}-uncategorized-help`}
          className="mt-0.5"
        />
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${id}-uncategorized`}
            className="text-sm font-medium"
          >
            Count credits without a category as income
          </label>
          <p
            id={`${id}-uncategorized-help`}
            className="text-muted-foreground text-sm"
          >
            On, every incoming payment without a category (or in Uncategorized)
            is income in the cash-flow report and on the dashboard. Off, only
            credits in an income category, such as Income › Salary through a
            rule, are income; the rest show as “Other money in (not income)” and
            stay out of net and the savings rate. Refunds in a spending category
            always net against it.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {result?.ok && !pending && (
          <p role="status" className="text-sm">
            Saved.
          </p>
        )}
      </div>
    </form>
  );
}
