import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Layers } from "lucide-react";
import { AllocationBreakdown } from "@/components/reports/allocation-breakdown";
import { PerformanceChart } from "@/components/reports/performance-chart";
import { ReportTabs } from "@/components/reports/report-tabs";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { verifySession } from "@/lib/auth/session";
import { formatMoney, formatMoneyChange } from "@/lib/format";
import {
  ALLOCATION_PATH,
  allocationHref,
  formatRange,
  single,
} from "@/lib/reports";
import { getEnv } from "@/server/env";
import {
  getAllocation,
  getPortfolioPerformance,
  type PortfolioPerformanceReport,
} from "@/server/queries/portfolio";
import {
  BALANCE_RANGES,
  parseBalanceRange,
} from "@/server/reports/balance-series";

export const metadata: Metadata = { title: "Allocation" };

export default function AllocationPage({
  searchParams,
}: PageProps<"/reports/allocation">) {
  return (
    <>
      <PageHeader
        title="Reports"
        description="Spending by category, income versus expenses, cash flow, balance history and allocation."
      />
      <ReportTabs active={ALLOCATION_PATH} />
      <Suspense
        fallback={<p className="text-muted-foreground">Loading allocation…</p>}
      >
        <AllocationReport searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function AllocationReport({
  searchParams,
}: {
  searchParams: PageProps<"/reports/allocation">["searchParams"];
}) {
  // Also awaits io(), so reading the clock below is request-time.
  await verifySession();
  const params = await searchParams;
  const timeZone = getEnv().APP_TIMEZONE;
  const [allocation, performance] = await Promise.all([
    getAllocation({ timeZone }),
    getPortfolioPerformance({
      timeZone,
      range: parseBalanceRange(single(params.range)),
      accountId: single(params.account),
    }),
  ]);

  if (allocation.empty) {
    return (
      <EmptyState
        icon={Layers}
        title="Nothing to allocate yet"
        description="Connect a bank, import a Nordnet export or add a crypto holding to see where your net worth sits."
      >
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link href="/connections">Connect bank</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/investments">Add investments</Link>
          </Button>
        </div>
      </EmptyState>
    );
  }

  const { omitted } = allocation;
  return (
    <div className="flex flex-col gap-6">
      <AllocationBreakdown allocation={allocation} />
      {(allocation.unpriced > 0 ||
        omitted.withoutBalance > 0 ||
        omitted.otherCurrency > 0) && (
        <p
          data-testid="allocation-omitted"
          className="text-muted-foreground -mt-3 text-xs"
        >
          Not included:{" "}
          {[
            allocation.unpriced > 0 &&
              `${allocation.unpriced} ${allocation.unpriced === 1 ? "holding" : "holdings"} without a price`,
            omitted.withoutBalance > 0 &&
              `${omitted.withoutBalance} ${omitted.withoutBalance === 1 ? "account" : "accounts"} without a balance yet`,
            omitted.otherCurrency > 0 &&
              `${omitted.otherCurrency} in other currencies`,
          ]
            .filter(Boolean)
            .join(", ")}
          .
        </p>
      )}
      <Performance report={performance} />
    </div>
  );
}

function Performance({ report }: { report: PortfolioPerformanceReport }) {
  const { days, performance, currency } = report;
  return (
    <section
      aria-label="Portfolio performance"
      className="bg-card flex flex-col gap-4 rounded-xl border p-4"
    >
      <div>
        <h2 className="font-medium">Portfolio performance</h2>
        <p className="text-muted-foreground text-xs">
          Brokerage and crypto accounts. Contributed is the value at the start
          plus deposits and units moved in, minus withdrawals; the rest of the
          change (prices, dividends, fees) is the market gain.
        </p>
      </div>
      {report.accounts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No brokerage or crypto accounts yet.{" "}
          <Link href="/investments" className="underline">
            Import a Nordnet export or add a crypto holding
          </Link>
          .
        </p>
      ) : (
        <>
          <nav aria-label="Range and account" className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1">
              {BALANCE_RANGES.map((item) => (
                <Button
                  key={item.id}
                  asChild
                  size="sm"
                  variant={item.id === report.range ? "default" : "outline"}
                >
                  <Link
                    href={allocationHref(item.id, report.accountId)}
                    aria-current={item.id === report.range ? "page" : undefined}
                  >
                    {item.label}
                  </Link>
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {[{ id: null, name: "All accounts" }, ...report.accounts].map(
                (account) => (
                  <Button
                    key={account.id ?? "all"}
                    asChild
                    size="sm"
                    variant={
                      account.id === report.accountId ? "secondary" : "ghost"
                    }
                  >
                    <Link
                      href={allocationHref(report.range, account.id)}
                      aria-current={
                        account.id === report.accountId ? "page" : undefined
                      }
                    >
                      {account.name}
                    </Link>
                  </Button>
                ),
              )}
            </div>
            <p
              data-testid="performance-range"
              className="text-muted-foreground text-sm"
            >
              {formatRange({ from: days[0], to: days.at(-1)! })}
            </p>
          </nav>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Figure label="Value at start" testId="performance-start">
              {performance.startMinor === null
                ? "–"
                : formatMoney(performance.startMinor, currency)}
            </Figure>
            <Figure
              label="Net contributions"
              testId="performance-contributions"
            >
              {formatMoneyChange(performance.contributionsMinor, currency)}
            </Figure>
            <Figure label="Market gain" testId="performance-gain">
              {performance.gainMinor === null
                ? "–"
                : formatMoneyChange(performance.gainMinor, currency)}
            </Figure>
            <Figure label="Value today" testId="performance-value">
              {performance.endMinor === null
                ? "–"
                : formatMoney(performance.endMinor, currency)}
            </Figure>
          </dl>
          {report.empty ? (
            <p className="text-muted-foreground text-sm">
              No value in this range yet.
            </p>
          ) : (
            <PerformanceChart
              days={days}
              points={performance.points}
              currency={currency}
            />
          )}
        </>
      )}
    </section>
  );
}

function Figure({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd data-testid={testId} className="text-lg font-medium tabular-nums">
        {children}
      </dd>
    </div>
  );
}
