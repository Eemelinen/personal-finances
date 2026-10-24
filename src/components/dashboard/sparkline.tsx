"use client";

import { Line, LineChart, Tooltip, YAxis } from "recharts";
import { formatDay, formatMoney } from "@/lib/format";
import type { DailyBalance } from "@/server/queries/balances";

interface SparklineProps {
  points: DailyBalance[];
  currency: string;
  /** What the line shows, for screen readers, e.g. "Balance, last 90 days". */
  label: string;
}

/** An account's daily balance as a small line without axes; hover for values. */
export function Sparkline({ points, currency, label }: SparklineProps) {
  const known = points.filter((point) => point.amountMinor !== null).length;
  if (known < 2) {
    return (
      <p
        data-testid="sparkline-empty"
        className="text-muted-foreground w-32 text-xs"
      >
        No history yet
      </p>
    );
  }
  return (
    <div data-testid="sparkline" role="img" aria-label={label}>
      <LineChart
        width={128}
        height={36}
        data={points}
        margin={{ top: 4, right: 2, bottom: 4, left: 2 }}
      >
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Tooltip
          cursor={{ stroke: "var(--border)" }}
          isAnimationActive={false}
          content={({ active, payload }) => {
            const point = payload?.[0]?.payload as DailyBalance | undefined;
            if (!active || !point || point.amountMinor === null) return null;
            return (
              <div className="bg-popover text-popover-foreground rounded-md border px-2 py-1 text-xs whitespace-nowrap shadow-sm">
                <div className="text-muted-foreground">
                  {formatDay(point.date)}
                </div>
                <div className="font-medium tabular-nums">
                  {formatMoney(point.amountMinor, currency)}
                </div>
              </div>
            );
          }}
        />
        <Line
          type="linear"
          dataKey="amountMinor"
          stroke="var(--chart-2)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3 }}
          isAnimationActive={false}
          connectNulls={false}
        />
      </LineChart>
    </div>
  );
}
