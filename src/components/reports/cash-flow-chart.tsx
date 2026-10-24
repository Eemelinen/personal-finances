"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  formatMoney,
  formatMoneyRounded,
  formatMonth,
  formatPercent,
} from "@/lib/format";
import type { CashFlowMonth } from "@/server/queries/reports";

/** Blue and orange: apart for every colour vision, in light and dark mode. */
export const INCOME_COLOR = "#2563eb";
export const EXPENSES_COLOR = "#ea580c";

interface CashFlowChartProps {
  months: CashFlowMonth[];
  currency: string;
}

/** Income and expenses per month as bars, net as a line, on one axis. */
export function CashFlowChart({ months, currency }: CashFlowChartProps) {
  return (
    <div className="flex flex-col gap-3">
      <ul
        aria-label="Legend"
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
      >
        <LegendItem label="Income" color={INCOME_COLOR} />
        <LegendItem label="Expenses" color={EXPENSES_COLOR} />
        <LegendItem label="Net" color="var(--foreground)" line />
      </ul>
      <div
        data-testid="cash-flow-chart"
        role="img"
        aria-label="Income, expenses and net per month"
        className="h-72 w-full"
      >
        <ComposedChart
          responsive
          style={{ width: "100%", height: "100%" }}
          data={months}
          barGap={2}
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
            width={80}
            stroke="var(--muted-foreground)"
          />
          <ReferenceLine y={0} stroke="var(--muted-foreground)" />
          <Tooltip
            cursor={{ fill: "var(--muted)" }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const month = payload?.[0]?.payload as CashFlowMonth | undefined;
              if (!active || !month) return null;
              return (
                <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-sm">
                  <div className="mb-1 font-medium">
                    {formatMonth(month.month)}
                  </div>
                  <TooltipRow
                    label="Income"
                    minor={month.incomeMinor}
                    currency={currency}
                  />
                  <TooltipRow
                    label="Expenses"
                    minor={month.expensesMinor}
                    currency={currency}
                  />
                  <TooltipRow
                    label="Net"
                    minor={month.netMinor}
                    currency={currency}
                  />
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Savings rate</span>
                    <span className="tabular-nums">
                      {month.savingsRate === null
                        ? "–"
                        : formatPercent(month.savingsRate)}
                    </span>
                  </div>
                </div>
              );
            }}
          />
          <Bar
            dataKey="incomeMinor"
            name="Income"
            fill={INCOME_COLOR}
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
            isAnimationActive={false}
          />
          <Bar
            dataKey="expensesMinor"
            name="Expenses"
            fill={EXPENSES_COLOR}
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
            isAnimationActive={false}
          />
          <Line
            dataKey="netMinor"
            name="Net"
            type="linear"
            stroke="var(--foreground)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--foreground)" }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </div>
    </div>
  );
}

function LegendItem({
  label,
  color,
  line = false,
}: {
  label: string;
  color: string;
  line?: boolean;
}) {
  return (
    <li className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={line ? "h-0.5 w-3" : "size-2.5 rounded-sm"}
        style={{ backgroundColor: color }}
      />
      {label}
    </li>
  );
}

function TooltipRow({
  label,
  minor,
  currency,
}: {
  label: string;
  minor: number;
  currency: string;
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{formatMoney(minor, currency)}</span>
    </div>
  );
}
