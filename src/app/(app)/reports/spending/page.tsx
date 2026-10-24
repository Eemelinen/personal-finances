import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChartPie } from "lucide-react";
import { CategoryBreakdown } from "@/components/reports/category-breakdown";
import { ComparisonTiles } from "@/components/reports/comparison-tiles";
import { PeriodSelector } from "@/components/reports/period-selector";
import { ReportTabs } from "@/components/reports/report-tabs";
import { SpendingTrendChart } from "@/components/reports/spending-trend-chart";
import { TopMerchants } from "@/components/reports/top-merchants";
import { TransactionList } from "@/components/reports/transaction-list";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { verifySession } from "@/lib/auth/session";
import { formatMonth } from "@/lib/format";
import { single, SPENDING_PATH, spendingHref } from "@/lib/reports";
import { getEnv } from "@/server/env";
import {
  getSpendingReport,
  UNCATEGORIZED_PARAM,
  type SpendingReport,
} from "@/server/queries/reports";
import {
  monthOf,
  monthsEnding,
  resolvePeriod,
  type Period,
} from "@/server/reports/period";
import { localDate } from "@/server/dates";

export const metadata: Metadata = { title: "Spending" };

export default function SpendingPage({
  searchParams,
}: PageProps<"/reports/spending">) {
  return (
    <>
      <PageHeader
        title="Reports"
        description="Spending by category, income versus expenses, cash flow, balance history and allocation."
      />
      <ReportTabs active={SPENDING_PATH} />
      <Suspense
        fallback={<p className="text-muted-foreground">Loading spending…</p>}
      >
        <Spending searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Spending({
  searchParams,
}: {
  searchParams: PageProps<"/reports/spending">["searchParams"];
}) {
  // Also awaits io(), so reading the clock below is request-time.
  await verifySession();
  const params = await searchParams;
  const today = localDate(new Date(), getEnv().APP_TIMEZONE);
  const period = resolvePeriod(
    {
      period: single(params.period),
      from: single(params.from),
      to: single(params.to),
    },
    today,
  );
  const report = await getSpendingReport({
    period,
    category: single(params.category),
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

  const { scope } = report;
  const category = scope.level === "all" ? undefined : scopeParam(report);
  const trendMonths = monthsEnding(monthOf(period.to), 12);
  return (
    <>
      <PeriodSelector period={period} category={category} />
      <Breadcrumbs report={report} period={period} />
      <ComparisonTiles
        currency={report.currency}
        totalMinor={report.totalMinor}
        previousTotalMinor={report.previousTotalMinor}
        previous={report.previous}
        averageTotalMinor={report.averageTotalMinor}
      />
      <div className="mb-6 grid gap-6 lg:grid-cols-[3fr_2fr]">
        {scope.level !== "subcategory" && scope.level !== "uncategorized" ? (
          <CategoryBreakdown
            title={
              scope.level === "all"
                ? "By category"
                : `${scope.category.name} by subcategory`
            }
            categories={report.categories}
            currency={report.currency}
            hrefOf={(row) =>
              // The parent's own row would only show the same view again.
              scope.level === "category" && row.param === scope.category.id
                ? undefined
                : spendingHref(period, row.param)
            }
          />
        ) : null}
        <TopMerchants merchants={report.merchants} currency={report.currency} />
      </div>
      <section
        aria-label="Spending per month"
        className="bg-card mb-6 rounded-xl border p-4"
      >
        <h2 className="mb-3 font-medium">
          Spending per month, {formatMonth(trendMonths[0])} –{" "}
          {formatMonth(trendMonths[11])}
        </h2>
        <SpendingTrendChart
          series={report.trend.series}
          months={report.trend.months}
          currency={report.currency}
        />
      </section>
      {report.transactions && (
        <TransactionList
          title="Transactions"
          rows={report.transactions.rows}
          total={report.transactions.total}
          currency={report.currency}
        />
      )}
    </>
  );
}

function scopeParam(report: SpendingReport): string {
  const { scope } = report;
  return scope.level === "category" || scope.level === "subcategory"
    ? scope.category.id
    : UNCATEGORIZED_PARAM;
}

/** All categories › Parent › Subcategory, each a link but the last. */
function Breadcrumbs({
  report,
  period,
}: {
  report: SpendingReport;
  period: Period;
}) {
  const { scope } = report;
  if (scope.level === "all") return null;
  const trail: { label: string; href?: string }[] = [
    { label: "All categories", href: spendingHref(period) },
  ];
  if (scope.level === "subcategory") {
    trail.push({
      label: scope.parent.name,
      href: spendingHref(period, scope.parent.id),
    });
    trail.push({ label: scope.category.name });
  } else {
    trail.push({
      label: scope.level === "category" ? scope.category.name : "Uncategorized",
    });
  }
  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-sm">
      <ol className="flex flex-wrap items-center gap-1.5">
        {trail.map((step, index) => (
          <li key={step.label} className="flex items-center gap-1.5">
            {index > 0 && (
              <span aria-hidden="true" className="text-muted-foreground">
                ›
              </span>
            )}
            {step.href ? (
              <Link
                href={step.href}
                className="text-muted-foreground hover:underline"
              >
                {step.label}
              </Link>
            ) : (
              <span aria-current="page" className="font-medium">
                {step.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
