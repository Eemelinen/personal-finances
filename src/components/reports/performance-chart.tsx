"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  formatDay,
  formatMoney,
  formatMoneyChange,
  formatMoneyRounded,
} from "@/lib/format";
import type { PerformancePoint } from "@/server/investments/performance";

interface PerformanceChartProps {
  days: string[];
  points: PerformancePoint[];
  currency: string;
}

type Row = PerformancePoint & { date: string };

const SERIES = [
  {
    key: "valueMinor",
    name: "Value",
    color: "var(--series-1)",
    dash: undefined,
  },
  {
    key: "contributedMinor",
    name: "Contributed",
    color: "var(--series-2)",
    dash: "5 4",
  },
] as const;

/**
 * The investments' value and what was contributed to it, per day, on one
 * axis; the gap between them is the market gain, which the tooltip shows.
 */
export function PerformanceChart({
  days,
  points,
  currency,
}: PerformanceChartProps) {
  const rows: Row[] = days.map((date, index) => ({ date, ...points[index] }));
  return (
    <div className="flex flex-col gap-3">
      <ul
        aria-label="Legend"
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
      >
        {SERIES.map((series) => (
          <li key={series.key} className="flex items-center gap-1.5">
            <svg aria-hidden="true" width="16" height="4">
              <line
                x1="0"
                y1="2"
                x2="16"
                y2="2"
                stroke={series.color}
                strokeWidth="2"
                strokeDasharray={series.dash === undefined ? undefined : "4 3"}
              />
            </svg>
            {series.name}
          </li>
        ))}
      </ul>
      <div
        data-testid="performance-chart"
        data-days={days.length}
        role="img"
        aria-label={`Investments' value and contributions per day, ${formatDay(days[0])} – ${formatDay(days.at(-1)!)}`}
        className="h-64 w-full"
      >
        <LineChart
          responsive
          style={{ width: "100%", height: "100%" }}
          data={rows}
          margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
        >
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tickFormatter={formatDay}
            tickLine={false}
            axisLine={false}
            fontSize={12}
            minTickGap={48}
            stroke="var(--muted-foreground)"
          />
          <YAxis
            tickFormatter={(value: number) =>
              formatMoneyRounded(value, currency)
            }
            tickLine={false}
            axisLine={false}
            fontSize={12}
            width={88}
            stroke="var(--muted-foreground)"
          />
          <Tooltip
            cursor={{
              stroke: "var(--muted-foreground)",
              strokeDasharray: "3 3",
            }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const row = active
                ? (payload?.[0]?.payload as Row | undefined)
                : undefined;
              if (!row || row.valueMinor === null) return null;
              return (
                <div
                  data-testid="performance-tooltip"
                  className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-sm"
                >
                  <div className="mb-1 font-medium">{formatDay(row.date)}</div>
                  <TooltipRow label="Value">
                    {formatMoney(row.valueMinor, currency)}
                  </TooltipRow>
                  <TooltipRow label="Contributed">
                    {formatMoney(row.contributedMinor ?? 0, currency)}
                  </TooltipRow>
                  <TooltipRow label="Market gain">
                    {formatMoneyChange(row.gainMinor ?? 0, currency)}
                  </TooltipRow>
                </div>
              );
            }}
          />
          {SERIES.map((series) => (
            <Line
              key={series.key}
              dataKey={series.key}
              name={series.name}
              type="linear"
              stroke={series.color}
              strokeWidth={2}
              strokeDasharray={series.dash}
              dot={false}
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </div>
    </div>
  );
}

function TooltipRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{children}</span>
    </div>
  );
}
