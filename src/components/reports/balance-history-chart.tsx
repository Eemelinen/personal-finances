"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDay, formatMoney, formatMoneyRounded } from "@/lib/format";
import type { BalanceHistoryAccount } from "@/server/queries/balance-history";
import type {
  BalancePoint,
  NetWorthPoint,
} from "@/server/reports/balance-series";

/** Accounts with their own colour; more fold into Other. */
export const MAX_ACCOUNT_SERIES = 8;
const OTHER_COLOR = "#94a3b8";

interface BalanceHistoryChartProps {
  days: string[];
  accounts: BalanceHistoryAccount[];
  netWorth: NetWorthPoint[];
  currency: string;
}

interface Series {
  key: string;
  name: string;
  color: string;
  points: BalancePoint[];
}

type Row = { index: number; date: string } & Record<
  string,
  number | string | null
>;

/** The fixed categorical order; past the last slot the rest is one Other. */
function chartSeries(accounts: BalanceHistoryAccount[]): Series[] {
  const own =
    accounts.length > MAX_ACCOUNT_SERIES
      ? accounts.slice(0, MAX_ACCOUNT_SERIES - 1)
      : accounts;
  const series: Series[] = own.map((account, index) => ({
    key: `account${index}`,
    name: account.name,
    color: `var(--series-${index + 1})`,
    points: account.points,
  }));
  const rest = accounts.slice(own.length);
  if (rest.length > 0) {
    series.push({
      key: "other",
      name: `Other (${rest.length} accounts)`,
      color: OTHER_COLOR,
      points: rest[0].points.map((_, day) => {
        const known = rest
          .map((account) => account.points[day])
          .filter((point) => point.amountMinor !== null);
        return {
          amountMinor: known.length
            ? known.reduce((sum, point) => sum + point.amountMinor!, 0)
            : null,
          estimated: known.some((point) => point.estimated),
        };
      }),
    });
  }
  return series;
}

/**
 * The net-worth line's styles: dashed where estimated, muted where some
 * account has no balance yet (the sum is partial).
 */
const LINE_SEGMENTS = [
  { key: "complete", name: "Net worth", muted: false, dashed: false },
  {
    key: "estimated",
    name: "Net worth (estimated)",
    muted: false,
    dashed: true,
  },
  { key: "partial", name: "Net worth (partial)", muted: true, dashed: false },
  {
    key: "estimatedPartial",
    name: "Net worth (estimated, partial)",
    muted: true,
    dashed: true,
  },
] as const;

function segmentOf(
  point: NetWorthPoint,
): (typeof LINE_SEGMENTS)[number]["key"] {
  if (point.estimated) return point.partial ? "estimatedPartial" : "estimated";
  return point.partial ? "partial" : "complete";
}

/** Runs of consecutive estimated days, as `[first, last]` indexes. */
function estimatedRuns(points: readonly BalancePoint[]): [number, number][] {
  const runs: [number, number][] = [];
  points.forEach((point, index) => {
    if (!point.estimated) return;
    const last = runs.at(-1);
    if (last && last[1] === index - 1) last[1] = index;
    else runs.push([index, index]);
  });
  return runs;
}

/**
 * The net worth as a line (solid where synced, dashed where estimated,
 * muted where partial) and the accounts as stacked areas, sharing a
 * per-account tooltip. Estimated days are shaded in both.
 */
export function BalanceHistoryChart({
  days,
  accounts,
  netWorth,
  currency,
}: BalanceHistoryChartProps) {
  const series = chartSeries(accounts);
  const rows: Row[] = days.map((date, index) => {
    const point = netWorth[index];
    const row: Row = { index, date };
    for (const segment of LINE_SEGMENTS) row[segment.key] = null;
    row[segmentOf(point)] = point.amountMinor;
    // Where the style changes, the previous style also reaches this day,
    // so the line has no gap.
    const previous = netWorth[index - 1];
    if (previous && previous.amountMinor !== null) {
      row[segmentOf(previous)] = point.amountMinor;
    }
    for (const item of series) {
      // Unknown stays a gap, not a zero.
      row[item.key] = item.points[index].amountMinor;
    }
    return row;
  });
  const shading = estimatedRuns(netWorth).map(([first, last], index) => (
    <ReferenceArea
      key={first}
      x1={days[first]}
      x2={days[last]}
      fill="var(--muted)"
      fillOpacity={0.8}
      ifOverflow="hidden"
      label={
        index === 0
          ? {
              value: "Estimated",
              position: "insideTopLeft",
              fontSize: 11,
              fill: "var(--muted-foreground)",
            }
          : undefined
      }
    />
  ));
  const xAxis = (
    <XAxis
      dataKey="date"
      tickFormatter={formatDay}
      tickLine={false}
      axisLine={false}
      fontSize={12}
      minTickGap={48}
      stroke="var(--muted-foreground)"
    />
  );
  const yAxis = (
    <YAxis
      tickFormatter={(value: number) => formatMoneyRounded(value, currency)}
      tickLine={false}
      axisLine={false}
      fontSize={12}
      width={88}
      stroke="var(--muted-foreground)"
    />
  );
  const tooltip = (
    <Tooltip
      cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "3 3" }}
      isAnimationActive={false}
      content={({ active, payload }) => (
        <Breakdown
          row={active ? (payload?.[0]?.payload as Row | undefined) : undefined}
          series={series}
          netWorth={netWorth}
          currency={currency}
        />
      )}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-label="Net worth over time"
        className="bg-card rounded-xl border p-4"
      >
        <h2 className="mb-1 font-medium">Net worth</h2>
        <p className="text-muted-foreground mb-3 text-xs">
          Solid where every balance comes from a sync; dashed where it is
          estimated from transactions before the first sync; grey where some
          account has no balance yet, so the sum covers only the others.
        </p>
        <div
          data-testid="net-worth-chart"
          data-days={days.length}
          role="img"
          aria-label={`Net worth per day, ${formatDay(days[0])} – ${formatDay(days.at(-1)!)}`}
          className="h-64 w-full"
        >
          <LineChart
            responsive
            style={{ width: "100%", height: "100%" }}
            data={rows}
            margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
          >
            <CartesianGrid vertical={false} stroke="var(--border)" />
            {shading}
            {xAxis}
            {yAxis}
            {tooltip}
            {LINE_SEGMENTS.map((segment) => (
              <Line
                key={segment.key}
                dataKey={segment.key}
                name={segment.name}
                type="linear"
                stroke={
                  segment.muted
                    ? "var(--muted-foreground)"
                    : "var(--foreground)"
                }
                strokeWidth={2}
                strokeDasharray={segment.dashed ? "5 4" : undefined}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </div>
      </section>
      <section
        aria-label="Balance per account"
        className="bg-card rounded-xl border p-4"
      >
        <h2 className="mb-3 font-medium">Balance per account</h2>
        <ul
          aria-label="Legend"
          className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs"
        >
          {series.map((item) => (
            <li key={item.key} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2.5 rounded-sm"
                style={{ backgroundColor: item.color }}
              />
              {item.name}
            </li>
          ))}
        </ul>
        <div
          data-testid="account-balance-chart"
          role="img"
          aria-label="Balance per account per day, stacked"
          className="h-72 w-full"
        >
          <AreaChart
            responsive
            style={{ width: "100%", height: "100%" }}
            data={rows}
            stackOffset="sign"
            margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
          >
            <CartesianGrid vertical={false} stroke="var(--border)" />
            {shading}
            {xAxis}
            {yAxis}
            {tooltip}
            {series.map((item) => (
              <Area
                key={item.key}
                dataKey={item.key}
                name={item.name}
                type="linear"
                stackId="accounts"
                fill={item.color}
                fillOpacity={0.85}
                stroke="var(--card)"
                strokeWidth={2}
                activeDot={false}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </div>
      </section>
    </div>
  );
}

function Breakdown({
  row,
  series,
  netWorth,
  currency,
}: {
  row: Row | undefined;
  series: Series[];
  netWorth: NetWorthPoint[];
  currency: string;
}) {
  if (!row) return null;
  const total = netWorth[row.index];
  return (
    <div
      data-testid="balance-tooltip"
      className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-sm"
    >
      <div className="mb-1 font-medium">
        {formatDay(row.date)}: <Amount point={total} currency={currency} />
      </div>
      {[...series].reverse().map((item) => (
        <div key={item.key} className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 rounded-sm"
              style={{ backgroundColor: item.color }}
            />
            {item.name}
          </span>
          <Amount point={item.points[row.index]} currency={currency} />
        </div>
      ))}
    </div>
  );
}

/**
 * A balance, "–" when unknown, with "(est.)" when reconstructed and
 * "(partial)" when some account is missing from a sum.
 */
export function Amount({
  point,
  currency,
}: {
  point: BalancePoint & { partial?: boolean };
  currency: string;
}) {
  if (point.amountMinor === null) return <span>–</span>;
  const notes = [point.estimated && "est.", point.partial && "partial"].filter(
    Boolean,
  );
  return (
    <span className="tabular-nums">
      {formatMoney(point.amountMinor, currency)}
      {notes.length > 0 && (
        <span className="text-muted-foreground"> ({notes.join(", ")})</span>
      )}
    </span>
  );
}
