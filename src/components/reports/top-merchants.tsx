import { formatMoney } from "@/lib/format";
import type { Merchant } from "@/server/queries/reports";

/** The period's largest merchants by spending, names normalised. */
export function TopMerchants({
  merchants,
  currency,
}: {
  merchants: Merchant[];
  currency: string;
}) {
  return (
    <section
      aria-label="Top merchants"
      className="bg-card rounded-xl border p-4"
    >
      <h2 className="mb-3 font-medium">Top merchants</h2>
      {merchants.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No spending in this period.
        </p>
      ) : (
        <ol className="flex flex-col text-sm">
          {merchants.map((merchant) => (
            <li
              key={merchant.name}
              data-testid="merchant-row"
              className="flex items-baseline justify-between gap-3 border-t py-2 first:border-t-0"
            >
              <span className="min-w-0 truncate">{merchant.name}</span>
              <span className="text-muted-foreground shrink-0 text-xs">
                {merchant.count === 1
                  ? "1 purchase"
                  : `${merchant.count} purchases`}
              </span>
              <span className="ml-auto shrink-0 font-medium tabular-nums">
                {formatMoney(merchant.amountMinor, currency)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
