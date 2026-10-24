import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeftRight, ChartPie, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BALANCES_PATH, CASH_FLOW_PATH, SPENDING_PATH } from "@/lib/reports";

export const metadata: Metadata = { title: "Reports" };

const REPORTS = [
  {
    href: SPENDING_PATH,
    title: "Spending",
    description:
      "Spending per category for a period, month by month, against the previous period and the 6-month average, with the top merchants.",
    icon: ChartPie,
  },
  {
    href: CASH_FLOW_PATH,
    title: "Cash flow",
    description:
      "Income versus expenses per month with the net and savings rate, and the year to date.",
    icon: ArrowLeftRight,
  },
  {
    href: BALANCES_PATH,
    title: "Balances",
    description:
      "Net worth and each account's balance over 3 months, 6 months, a year or all history.",
    icon: TrendingUp,
  },
] as const;

export default function ReportsPage() {
  return (
    <>
      <PageHeader
        title="Reports"
        description="Spending by category, income versus expenses, cash flow and balance history."
      />
      <ul className="grid gap-4 sm:grid-cols-2">
        {REPORTS.map(({ href, title, description, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              className="bg-card hover:bg-muted/50 flex h-full flex-col gap-2 rounded-xl border p-4"
            >
              <span className="flex items-center gap-2 font-medium">
                <Icon
                  className="text-muted-foreground size-4"
                  aria-hidden="true"
                />
                {title}
              </span>
              <span className="text-muted-foreground text-sm">
                {description}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
