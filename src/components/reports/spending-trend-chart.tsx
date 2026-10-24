"use client";

import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import { formatMoney, formatMoneyRounded, formatMonth } from "@/lib/format";
import type { TrendMonth, TrendSeries } from "@/server/queries/reports";

interface SpendingTrendChartProps {
  series: TrendSeries[];
  months: TrendMonth[];
  currency: string;
}

type Row = { month: string } & Record<string, number | string>;

/** Spending per month as stacked bars, one segment per category. */
export function SpendingTrendChart({
  series,
  months,
  currency,
}: SpendingTrendChartProps) {
  const data: Row[] = months.map((month) => ({
    month: month.month,
    ...month.values,
  }));
  return (
    <div className="flex flex-col gap-3">
      <ul
        aria-label="Legend"
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
      >
        {series.map((item) => (
          <li key={item.key} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-sm"
              style={{ backgroundColor: item.color, opacity: item.opacity }}
            />
            {item.name}
          </li>
        ))}
      </ul>
      <div
        data-testid="spending-trend-chart"
        role="img"
        aria-label="Spending per month and category, last 12 months"
        className="h-64 w-full"
      >
        <BarChart
          responsive
          style={{ width: "100%", height: "100%" }}
          data={data}
          stackOffset="sign"
          margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
        >
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="month"
            tickFormatter={(month: string) => formatMonth(month).slice(0, 3)}
            tickLine={false}
            axisLine={false}
            fontSize={12}
            stroke="var(--muted-foreground)"
          />
          <YAxis
            tickFormatter={(value: number) =>
              formatMoneyRounded(value, currency)
            }
            tickLine={false}
            axisLine={false}
            fontSize={12}
            width={72}
            stroke="var(--muted-foreground)"
          />
          <Tooltip
            cursor={{ fill: "var(--muted)" }}
            isAnimationActive={false}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const shown = payload.filter(
                (entry) => Number(entry.value) !== 0,
              );
              const total = payload.reduce(
                (sum, entry) => sum + Number(entry.value),
                0,
              );
              return (
                <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-sm">
                  <div className="mb-1 font-medium">
                    {formatMonth(String(label))}: {formatMoney(total, currency)}
                  </div>
                  {shown.reverse().map((entry) => (
                    <div
                      key={String(entry.dataKey)}
                      className="flex justify-between gap-4"
                    >
                      <span className="text-muted-foreground">
                        {entry.name}
                      </span>
                      <span className="tabular-nums">
                        {formatMoney(Number(entry.value), currency)}
                      </span>
                    </div>
                  ))}
                </div>
              );
            }}
          />
          {series.map((item) => (
            <Bar
              key={item.key}
              dataKey={item.key}
              name={item.name}
              stackId="spending"
              fill={item.color}
              fillOpacity={item.opacity}
              stroke="var(--card)"
              strokeWidth={1}
              maxBarSize={40}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </div>
      <details className="text-sm">
        <summary className="text-muted-foreground cursor-pointer">
          Show as table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground text-left">
              <tr>
                <th className="py-1 pr-3 font-medium">Month</th>
                {series.map((item) => (
                  <th
                    key={item.key}
                    className="py-1 pl-3 text-right font-medium"
                  >
                    {item.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {months.map((month) => (
                <tr key={month.month} className="border-t">
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {formatMonth(month.month)}
                  </td>
                  {series.map((item) => (
                    <td
                      key={item.key}
                      className="py-1 pl-3 text-right whitespace-nowrap tabular-nums"
                    >
                      {formatMoney(month.values[item.key] ?? 0, currency)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
