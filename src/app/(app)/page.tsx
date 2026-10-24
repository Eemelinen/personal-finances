import Link from "next/link";
import { Suspense } from "react";
import { Wallet } from "lucide-react";
import { AccountList } from "@/components/dashboard/account-list";
import { ConnectionStatus } from "@/components/dashboard/connection-status";
import { MonthCashFlow } from "@/components/dashboard/month-cash-flow";
import { StatTile } from "@/components/dashboard/stat-tile";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { verifySession } from "@/lib/auth/session";
import { getEnv } from "@/server/env";
import {
  CHANGE_DAYS,
  getDashboardOverview,
  SPARKLINE_DAYS,
} from "@/server/queries/dashboard";
import { getMonthCashFlow, REPORT_CURRENCY } from "@/server/queries/reports";

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Balances, spending and net worth at a glance."
      />
      <Suspense
        fallback={<p className="text-muted-foreground">Loading balances…</p>}
      >
        <Overview />
      </Suspense>
    </>
  );
}

async function Overview() {
  // Also awaits io(), so reading the clock below is request-time.
  await verifySession();
  const timeZone = getEnv().APP_TIMEZONE;
  const [overview, month] = await Promise.all([
    getDashboardOverview({ timeZone }),
    getMonthCashFlow({ timeZone }),
  ]);

  if (overview.empty) {
    return (
      <div className="flex flex-col gap-8">
        <EmptyState
          icon={Wallet}
          title="No accounts yet"
          description="Connect a bank or import a CSV export to see your balances here."
        >
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link href="/connections">Connect bank</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/import">Import CSV</Link>
            </Button>
          </div>
        </EmptyState>
        {overview.connections.length > 0 && (
          <ConnectionStatus
            connections={overview.connections}
            timeZone={timeZone}
          />
        )}
      </div>
    );
  }

  const { totals } = overview;
  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Net worth"
          total={totals.netWorth}
          currency={totals.currency}
          changeDays={CHANGE_DAYS}
        />
        <StatTile
          label="Checking"
          total={totals.checking}
          currency={totals.currency}
          changeDays={CHANGE_DAYS}
        />
        <StatTile
          label="Savings"
          total={totals.savings}
          currency={totals.currency}
          changeDays={CHANGE_DAYS}
        />
      </div>
      <MonthCashFlow month={month} currency={REPORT_CURRENCY} />
      <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
        <AccountList
          banks={overview.banks}
          timeZone={timeZone}
          sparklineDays={SPARKLINE_DAYS}
        />
        <ConnectionStatus
          connections={overview.connections}
          timeZone={timeZone}
        />
      </div>
    </div>
  );
}
