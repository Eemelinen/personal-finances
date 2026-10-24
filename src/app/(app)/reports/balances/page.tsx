import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { TrendingUp } from "lucide-react";
import {
  Amount,
  BalanceHistoryChart,
} from "@/components/reports/balance-history-chart";
import { ReportTabs } from "@/components/reports/report-tabs";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { verifySession } from "@/lib/auth/session";
import { formatDay, formatMoneyChange } from "@/lib/format";
import {
  BALANCES_PATH,
  balancesHref,
  formatRange,
  single,
} from "@/lib/reports";
import { getEnv } from "@/server/env";
import { getBalanceHistory } from "@/server/queries/balance-history";
import {
  BALANCE_RANGES,
  parseBalanceRange,
  type BalancePoint,
  type BalanceRangeId,
} from "@/server/reports/balance-series";

export const metadata: Metadata = { title: "Balances" };

export default function BalancesPage({
  searchParams,
}: PageProps<"/reports/balances">) {
  return (
    <>
      <PageHeader
        title="Reports"
        description="Spending by category, income versus expenses, cash flow, balance history and allocation."
      />
      <ReportTabs active={BALANCES_PATH} />
      <Suspense
        fallback={<p className="text-muted-foreground">Loading balances…</p>}
      >
        <Balances searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Balances({
  searchParams,
}: {
  searchParams: PageProps<"/reports/balances">["searchParams"];
}) {
  // Also awaits io(), so reading the clock below is request-time.
  await verifySession();
  const params = await searchParams;
  const history = await getBalanceHistory({
    range: parseBalanceRange(single(params.range)),
    timeZone: getEnv().APP_TIMEZONE,
  });

  if (history.empty) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No balance history yet"
        description="The history starts with an account's first balance sync; earlier days are estimated from its transactions."
      >
        <Button asChild variant="outline">
          <Link href="/connections">Connect bank</Link>
        </Button>
      </EmptyState>
    );
  }

  const { days, accounts, netWorth, currency, omitted } = history;
  const last = days.length - 1;
  return (
    <div className="flex flex-col gap-6">
      <RangeSelector
        active={history.range}
        range={{ from: days[0], to: days[last] }}
      />
      <BalanceHistoryChart
        days={days}
        accounts={accounts}
        netWorth={netWorth}
        currency={currency}
      />
      <section aria-label="Accounts" className="bg-card rounded-xl border p-4">
        <h2 className="mb-3 font-medium">Accounts</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th className="pb-2 font-medium">Account</th>
                <th className="pb-2 text-right font-medium">
                  {formatDay(days[0])}
                </th>
                <th className="pb-2 text-right font-medium">Today</th>
                <th className="pb-2 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <BalanceRow
                  key={account.id}
                  name={account.name}
                  detail={account.institution}
                  start={account.points[0]}
                  end={account.points[last]}
                  currency={currency}
                />
              ))}
              <BalanceRow
                name="Net worth"
                start={netWorth[0]}
                end={netWorth[last]}
                change={history.netWorthChange}
                currency={currency}
                total
              />
            </tbody>
          </table>
        </div>
        {(omitted.withoutBalance > 0 || omitted.otherCurrency > 0) && (
          <p
            data-testid="omitted-accounts"
            className="text-muted-foreground mt-3 text-xs"
          >
            Not included:{" "}
            {[
              omitted.withoutBalance > 0 &&
                `${omitted.withoutBalance} without a balance yet (CSV imports only)`,
              omitted.otherCurrency > 0 &&
                `${omitted.otherCurrency} in other currencies`,
            ]
              .filter(Boolean)
              .join(", ")}
            .
          </p>
        )}
      </section>
    </div>
  );
}

/** The ranges as links, so the choice lives in the URL. */
function RangeSelector({
  active,
  range,
}: {
  active: BalanceRangeId;
  range: { from: string; to: string };
}) {
  return (
    <section aria-label="Range" className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {BALANCE_RANGES.map((item) => (
          <Button
            key={item.id}
            asChild
            size="sm"
            variant={item.id === active ? "default" : "outline"}
          >
            <Link
              href={balancesHref(item.id)}
              aria-current={item.id === active ? "page" : undefined}
            >
              {item.label}
            </Link>
          </Button>
        ))}
      </div>
      <p data-testid="balance-range" className="text-muted-foreground text-sm">
        {formatRange(range)}
      </p>
    </section>
  );
}

function BalanceRow({
  name,
  detail,
  start,
  end,
  change,
  currency,
  total = false,
}: {
  name: string;
  detail?: string;
  start: BalancePoint & { partial?: boolean };
  end: BalancePoint & { partial?: boolean };
  /** Defaults to end minus start when both are known. */
  change?: number | null;
  currency: string;
  total?: boolean;
}) {
  const shown =
    change !== undefined
      ? change
      : start.amountMinor !== null && end.amountMinor !== null
        ? end.amountMinor - start.amountMinor
        : null;
  return (
    <tr
      data-testid={total ? "balance-total" : "balance-row"}
      className={total ? "border-t font-medium" : "border-t"}
    >
      <td className="py-2 pr-3">
        {name}
        {detail && (
          <span className="text-muted-foreground block text-xs">{detail}</span>
        )}
      </td>
      <td
        data-testid="balance-start"
        className="py-2 pl-3 text-right whitespace-nowrap"
      >
        <Amount point={start} currency={currency} />
      </td>
      <td
        data-testid="balance-end"
        className="py-2 pl-3 text-right whitespace-nowrap"
      >
        <Amount point={end} currency={currency} />
      </td>
      <td
        data-testid="balance-change"
        className="py-2 pl-3 text-right whitespace-nowrap tabular-nums"
      >
        {shown === null ? "–" : formatMoneyChange(shown, currency)}
      </td>
    </tr>
  );
}
