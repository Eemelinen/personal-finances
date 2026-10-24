import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatRange, periodName, spendingHref } from "@/lib/reports";
import { PERIOD_PRESETS, type Period } from "@/server/reports/period";

interface PeriodSelectorProps {
  period: Period;
  /** The drilled category, kept when the period changes. */
  category?: string;
}

/**
 * The preset periods as links and a custom range as a GET form, so the
 * choice lives in the URL and works without JavaScript.
 */
export function PeriodSelector({ period, category }: PeriodSelectorProps) {
  return (
    <section
      aria-label="Period"
      className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between"
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1">
          {PERIOD_PRESETS.map((preset) => {
            const active = preset.id === period.id;
            return (
              <Button
                key={preset.id}
                asChild
                size="sm"
                variant={active ? "default" : "outline"}
              >
                <Link
                  href={spendingHref({ ...period, id: preset.id }, category)}
                  aria-current={active ? "page" : undefined}
                >
                  {preset.label}
                </Link>
              </Button>
            );
          })}
        </div>
        <p data-testid="period-range" className="text-muted-foreground text-sm">
          {periodName(period.id)}: {formatRange(period)}
        </p>
      </div>
      <form
        action="/reports/spending"
        className="flex flex-wrap items-end gap-2"
        aria-label="Custom period"
      >
        <input type="hidden" name="period" value="custom" />
        {category && <input type="hidden" name="category" value={category} />}
        <label className="flex flex-col gap-1 text-sm">
          From
          <Input
            type="date"
            name="from"
            required
            defaultValue={period.from}
            className="w-40"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          To
          <Input
            type="date"
            name="to"
            required
            defaultValue={period.to}
            className="w-40"
          />
        </label>
        <Button
          type="submit"
          size="sm"
          variant={period.id === "custom" ? "default" : "outline"}
        >
          Custom
        </Button>
      </form>
    </section>
  );
}
