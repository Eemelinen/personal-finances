import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChartPie } from "lucide-react";
import { CashFlowChart } from "@/components/reports/cash-flow-chart";
import { ReportTabs } from "@/components/reports/report-tabs";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { verifySession } from "@/lib/auth/session";
import { formatMoney, formatMonth, formatPercent } from "@/lib/format";
import { CASH_FLOW_PATH } from "@/lib/reports";
import { getEnv } from "@/server/env";
import { getCashFlowReport, TREND_MONTHS } from "@/server/queries/reports";

export const metadata: Metadata = { title: "Cash flow" };

export default function CashFlowPage() {
  return (
    <>
      <PageHeader
        title="Reports"
        description="Spending by category, income versus expenses, cash flow and balance history."
      />
      <ReportTabs active={CASH_FLOW_PATH} />
      <Suspense
        fallback={<p className="text-muted-foreground">Loading cash flow…</p>}
      >
        <CashFlow />
      </Suspense>
    </>
  );
}

const rate = (value: number | null) =>
  value === null ? "–" : formatPercent(value);

async function CashFlow() {
  // Also awaits io(), so reading the clock below is request-time.
  await verifySession();
  const report = await getCashFlowReport({
    timeZone: getEnv().APP_TIMEZONE,
    months: TREND_MONTHS,
  });

  if (report.empty) {
    return (
      <EmptyState
        icon={ChartPie}
        title="Nothing to report yet"
        description="Reports are drawn from your categorised transactions once there are some."
      >
        <Button asChild variant="outline">
          <Link href="/import">Import a CSV export</Link>
        </Button>
      </EmptyState>
    );
  }

  const { currency, yearToDate: ytd, months } = report;
  return (
    <div className="flex flex-col gap-6">
      <section aria-label={`Year to date ${ytd.year}`}>
        <h2 className="mb-3 font-medium">Year to date {ytd.year}</h2>
        <div className="grid gap-4 sm:grid-cols-4">
          <Total
            label="Income"
            value={formatMoney(ytd.incomeMinor, currency)}
          />
          <Total
            label="Expenses"
            value={formatMoney(ytd.expensesMinor, currency)}
          />
          <Total label="Net" value={formatMoney(ytd.netMinor, currency)} />
          <Total label="Savings rate" value={rate(ytd.savingsRate)} />
        </div>
      </section>
      <section
        aria-label="Income and expenses per month"
        className="bg-card rounded-xl border p-4"
      >
        <h2 className="mb-3 font-medium">
          Income and expenses, {formatMonth(months[0].month)} –{" "}
          {formatMonth(months.at(-1)!.month)}
        </h2>
        <CashFlowChart months={months} currency={currency} />
      </section>
      <section aria-label="Months" className="bg-card rounded-xl border p-4">
        <h2 className="mb-3 font-medium">Months</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th className="pb-2 font-medium">Month</th>
                <th className="pb-2 text-right font-medium">Income</th>
                <th className="pb-2 text-right font-medium">Expenses</th>
                <th className="pb-2 text-right font-medium">Net</th>
                <th className="pb-2 text-right font-medium">Savings rate</th>
              </tr>
            </thead>
            <tbody>
              {[...months].reverse().map((month) => (
                <tr
                  key={month.month}
                  data-testid="cash-flow-row"
                  className="border-t"
                >
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {formatMonth(month.month)}
                  </td>
                  <td className="py-2 pl-3 text-right whitespace-nowrap tabular-nums">
                    {formatMoney(month.incomeMinor, currency)}
                  </td>
                  <td className="py-2 pl-3 text-right whitespace-nowrap tabular-nums">
                    {formatMoney(month.expensesMinor, currency)}
                  </td>
                  <td className="py-2 pl-3 text-right font-medium whitespace-nowrap tabular-nums">
                    {formatMoney(month.netMinor, currency)}
                  </td>
                  <td className="py-2 pl-3 text-right whitespace-nowrap tabular-nums">
                    {rate(month.savingsRate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <section
      aria-label={label}
      className="bg-card flex flex-col gap-1 rounded-xl border p-4"
    >
      <h3 className="text-muted-foreground text-sm font-medium">{label}</h3>
      <p
        data-testid="tile-amount"
        className="text-2xl font-semibold tabular-nums"
      >
        {value}
      </p>
    </section>
  );
}
