import { formatMoney, formatMoneyChange } from "@/lib/format";
import { formatRange } from "@/lib/reports";
import type { DayRange } from "@/server/reports/period";

interface ComparisonTilesProps {
  currency: string;
  totalMinor: number;
  previousTotalMinor: number;
  previous: DayRange;
  averageTotalMinor: number | null;
}

/** The period's spending against the previous period and the 6-month average. */
export function ComparisonTiles({
  currency,
  totalMinor,
  previousTotalMinor,
  previous,
  averageTotalMinor,
}: ComparisonTilesProps) {
  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-3">
      <Tile label="Spending" value={formatMoney(totalMinor, currency)}>
        In the chosen period
      </Tile>
      <Tile
        label="Previous period"
        value={formatMoney(previousTotalMinor, currency)}
      >
        {formatRange(previous)} · now{" "}
        {formatMoneyChange(totalMinor - previousTotalMinor, currency)}
      </Tile>
      <Tile
        label="6-month average"
        value={
          averageTotalMinor === null
            ? "–"
            : formatMoney(averageTotalMinor, currency)
        }
      >
        {averageTotalMinor === null
          ? "No earlier months yet"
          : "Per month, the 6 months before"}
      </Tile>
    </div>
  );
}

function Tile({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="bg-card flex flex-col gap-1 rounded-xl border p-4"
    >
      <h2 className="text-muted-foreground text-sm font-medium">{label}</h2>
      <p
        data-testid="tile-amount"
        className="text-2xl font-semibold tabular-nums"
      >
        {value}
      </p>
      <p className="text-muted-foreground text-sm">{children}</p>
    </section>
  );
}
