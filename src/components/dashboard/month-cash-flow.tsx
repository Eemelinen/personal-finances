import Link from "next/link";
import { formatMoney, formatMonth } from "@/lib/format";
import { CASH_FLOW_PATH, OTHER_IN_LABEL } from "@/lib/reports";
import type { CashFlowMonth } from "@/server/queries/reports";

/**
 * This month's income, expenses and net, and other money in when there is
 * any (F-026), linking to the cash-flow report.
 */
export function MonthCashFlow({
  month,
  currency,
}: {
  month: CashFlowMonth;
  currency: string;
}) {
  const tiles = [
    { label: "Income this month", amountMinor: month.incomeMinor },
    { label: "Expenses this month", amountMinor: month.expensesMinor },
    { label: "Net this month", amountMinor: month.netMinor },
    ...(month.otherInMinor !== 0
      ? [{ label: OTHER_IN_LABEL, amountMinor: month.otherInMinor }]
      : []),
  ];
  return (
    <section aria-labelledby="month-cash-flow" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="month-cash-flow" className="font-medium">
          {formatMonth(month.month)}
        </h2>
        <Link
          href={CASH_FLOW_PATH}
          className="text-muted-foreground text-sm hover:underline"
        >
          Cash flow report
        </Link>
      </div>
      <div
        className={
          tiles.length > 3
            ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
            : "grid gap-4 sm:grid-cols-3"
        }
      >
        {tiles.map((tile) => (
          <section
            key={tile.label}
            aria-label={tile.label}
            className="bg-card flex flex-col gap-1 rounded-xl border p-4"
          >
            <h3 className="text-muted-foreground text-sm font-medium">
              {tile.label}
            </h3>
            <p
              data-testid="tile-amount"
              className="text-2xl font-semibold tabular-nums"
            >
              {formatMoney(tile.amountMinor, currency)}
            </p>
          </section>
        ))}
      </div>
    </section>
  );
}
