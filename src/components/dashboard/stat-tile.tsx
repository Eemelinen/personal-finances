import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { formatMoney, formatMoneyChange } from "@/lib/format";
import type { Total } from "@/server/queries/dashboard";

interface StatTileProps {
  label: string;
  total: Total;
  currency: string;
  /** Days the change looks back. */
  changeDays: number;
}

/** A headline total and its change; the change's sign is in text and icon. */
export function StatTile({
  label,
  total,
  currency,
  changeDays,
}: StatTileProps) {
  const change = total.changeMinor;
  const Arrow =
    change === null || change === 0
      ? null
      : change > 0
        ? ArrowUpRight
        : ArrowDownRight;
  return (
    <section
      aria-label={label}
      className="bg-card flex flex-col gap-1 rounded-xl border p-4"
    >
      <h2 className="text-muted-foreground text-sm font-medium">{label}</h2>
      <p data-testid="tile-amount" className="text-2xl font-semibold">
        {formatMoney(total.amountMinor, currency)}
      </p>
      <p
        data-testid="tile-change"
        className="text-muted-foreground flex items-center gap-1 text-sm"
      >
        {Arrow && <Arrow className="size-4" aria-hidden="true" />}
        {change === null
          ? `No balance ${changeDays} days ago`
          : `${formatMoneyChange(change, currency)} vs ${changeDays} days ago`}
      </p>
    </section>
  );
}
