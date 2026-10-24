import Link from "next/link";
import { formatMoney, formatPercent } from "@/lib/format";
import type { ReportCategory } from "@/server/queries/reports";

interface CategoryBreakdownProps {
  title: string;
  categories: ReportCategory[];
  currency: string;
  /** The link that drills into a row, or undefined when it cannot. */
  hrefOf: (category: ReportCategory) => string | undefined;
}

/**
 * Spending per category as horizontal bars with amount and share, next to
 * the previous period and the 6-month average. A table, so it reads without
 * the bars too.
 */
export function CategoryBreakdown({
  title,
  categories,
  currency,
  hrefOf,
}: CategoryBreakdownProps) {
  const largest = Math.max(0, ...categories.map((c) => c.amountMinor));
  return (
    <section aria-label={title} className="bg-card rounded-xl border p-4">
      <h2 className="mb-3 font-medium">{title}</h2>
      {categories.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No spending in this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th className="pb-2 font-medium">Category</th>
                <th className="pb-2 text-right font-medium">Amount</th>
                <th className="pb-2 text-right font-medium">Share</th>
                <th className="hidden pb-2 text-right font-medium sm:table-cell">
                  Previous
                </th>
                <th className="hidden pb-2 text-right font-medium sm:table-cell">
                  6-mo avg
                </th>
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => {
                const href = hrefOf(category);
                const width =
                  largest > 0 && category.amountMinor > 0
                    ? (category.amountMinor / largest) * 100
                    : 0;
                return (
                  <tr
                    key={category.param + category.name}
                    data-testid="category-row"
                    className="border-t"
                  >
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="size-3 shrink-0 rounded-sm"
                          style={{
                            backgroundColor: category.color,
                            opacity: category.opacity,
                          }}
                        />
                        {href ? (
                          <Link href={href} className="hover:underline">
                            {category.name}
                          </Link>
                        ) : (
                          <span>{category.name}</span>
                        )}
                      </div>
                      <div className="bg-muted mt-1.5 h-2 rounded-full">
                        <div
                          aria-hidden="true"
                          className="h-2 rounded-full"
                          style={{
                            width: `${width}%`,
                            backgroundColor: category.color,
                            opacity: category.opacity,
                          }}
                        />
                      </div>
                    </td>
                    <td className="py-2 text-right font-medium whitespace-nowrap tabular-nums">
                      {formatMoney(category.amountMinor, currency)}
                    </td>
                    <td className="py-2 pl-3 text-right whitespace-nowrap tabular-nums">
                      {category.share === null
                        ? "–"
                        : formatPercent(category.share)}
                    </td>
                    <td className="text-muted-foreground hidden py-2 pl-3 text-right whitespace-nowrap tabular-nums sm:table-cell">
                      {formatMoney(category.previousMinor, currency)}
                    </td>
                    <td className="text-muted-foreground hidden py-2 pl-3 text-right whitespace-nowrap tabular-nums sm:table-cell">
                      {category.averageMinor === null
                        ? "–"
                        : formatMoney(category.averageMinor, currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
