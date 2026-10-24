import { formatMoney, formatPercent } from "@/lib/format";
import type { Allocation, AllocationClassId } from "@/server/queries/portfolio";

/** Fixed per class, so a class keeps its colour whichever are present. */
const CLASS_COLORS: Record<AllocationClassId, string> = {
  cash: "var(--series-1)",
  stocks: "var(--series-2)",
  funds: "var(--series-3)",
  crypto: "var(--series-4)",
  other: "#94a3b8",
};

const TYPE_LABELS = {
  checking: "Checking",
  savings: "Savings",
  brokerage: "Brokerage",
  crypto: "Crypto",
} as const;

/**
 * Today's net worth by asset class, as one bar split by share plus a table,
 * and by account, as a table with bars. Shares are of the positive values,
 * so an overdrawn account is listed without a share.
 */
export function AllocationBreakdown({
  allocation,
}: {
  allocation: Allocation;
}) {
  const { classes, accounts, currency } = allocation;
  const largest = Math.max(0, ...accounts.map((a) => a.valueMinor));
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section
        aria-label="By asset class"
        className="bg-card rounded-xl border p-4"
      >
        <h2 className="mb-3 font-medium">By asset class</h2>
        <div
          data-testid="allocation-bar"
          role="img"
          aria-label={`Net worth by asset class: ${classes
            .filter((item) => item.share !== null)
            .map((item) => `${item.label} ${formatPercent(item.share!)}`)
            .join(", ")}`}
          className="mb-4 flex h-4 gap-0.5 overflow-hidden rounded"
        >
          {classes.map(
            (item) =>
              item.share !== null && (
                <div
                  key={item.id}
                  title={`${item.label}: ${formatMoney(item.valueMinor, currency)} (${formatPercent(item.share)})`}
                  className="h-full first:rounded-l last:rounded-r"
                  style={{
                    width: `${item.share * 100}%`,
                    backgroundColor: CLASS_COLORS[item.id],
                  }}
                />
              ),
          )}
        </div>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left text-xs">
            <tr>
              <th className="pb-2 font-medium">Asset class</th>
              <th className="pb-2 text-right font-medium">Value</th>
              <th className="pb-2 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {classes.map((item) => (
              <tr
                key={item.id}
                data-testid="allocation-class"
                className="border-t"
              >
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-3 shrink-0 rounded-sm"
                      style={{ backgroundColor: CLASS_COLORS[item.id] }}
                    />
                    {item.label}
                  </span>
                </th>
                <td
                  data-testid="allocation-value"
                  className="py-2 text-right font-medium whitespace-nowrap tabular-nums"
                >
                  {formatMoney(item.valueMinor, currency)}
                </td>
                <td
                  data-testid="allocation-share"
                  className="py-2 pl-3 text-right whitespace-nowrap tabular-nums"
                >
                  {item.share === null ? "–" : formatPercent(item.share)}
                </td>
              </tr>
            ))}
            <tr className="border-t font-medium">
              <th scope="row" className="py-2 pr-3 text-left font-medium">
                Net worth
              </th>
              <td
                data-testid="allocation-total"
                className="py-2 text-right whitespace-nowrap tabular-nums"
              >
                {formatMoney(allocation.totalMinor, currency)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </section>
      <section
        aria-label="By account"
        className="bg-card rounded-xl border p-4"
      >
        <h2 className="mb-3 font-medium">By account</h2>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left text-xs">
            <tr>
              <th className="pb-2 font-medium">Account</th>
              <th className="pb-2 text-right font-medium">Value</th>
              <th className="pb-2 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr
                key={account.id}
                data-testid="allocation-account"
                className="border-t"
              >
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {account.name}
                  <span className="text-muted-foreground block text-xs">
                    {account.institution} · {TYPE_LABELS[account.type]}
                    {account.holdingsMinor !== 0 &&
                      ` · ${formatMoney(account.holdingsMinor, currency)} holdings`}
                  </span>
                  <div className="bg-muted mt-1.5 h-2 rounded-full">
                    <div
                      aria-hidden="true"
                      className="h-2 rounded-full"
                      style={{
                        width: `${largest > 0 && account.valueMinor > 0 ? (account.valueMinor / largest) * 100 : 0}%`,
                        backgroundColor: "var(--series-1)",
                      }}
                    />
                  </div>
                </th>
                <td
                  data-testid="allocation-value"
                  className="py-2 text-right align-top font-medium whitespace-nowrap tabular-nums"
                >
                  {formatMoney(account.valueMinor, currency)}
                </td>
                <td
                  data-testid="allocation-share"
                  className="py-2 pl-3 text-right align-top whitespace-nowrap tabular-nums"
                >
                  {account.share === null ? "–" : formatPercent(account.share)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
