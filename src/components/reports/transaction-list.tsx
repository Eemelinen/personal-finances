import { formatDay, formatMoney } from "@/lib/format";
import type { ReportTransaction } from "@/server/queries/reports";

interface TransactionListProps {
  title: string;
  rows: ReportTransaction[];
  total: number;
  currency: string;
}

/** The transactions behind a drilled-into category, newest first. */
export function TransactionList({
  title,
  rows,
  total,
  currency,
}: TransactionListProps) {
  return (
    <section aria-label={title} className="bg-card rounded-xl border p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-medium">{title}</h2>
        <p
          data-testid="transaction-count"
          className="text-muted-foreground text-xs"
        >
          {rows.length < total
            ? `Showing ${rows.length} of ${total}`
            : total === 1
              ? "1 transaction"
              : `${total} transactions`}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No transactions in this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th className="pb-2 font-medium">Date</th>
                <th className="pb-2 font-medium">Description</th>
                <th className="hidden pb-2 font-medium md:table-cell">
                  Account
                </th>
                <th className="hidden pb-2 font-medium sm:table-cell">
                  Category
                </th>
                <th className="pb-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid="transaction-row"
                  className="border-t"
                >
                  <td className="py-2 pr-3 whitespace-nowrap tabular-nums">
                    {formatDay(row.bookingDate)}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{row.counterparty ?? row.description ?? "–"}</span>
                      {row.pending && (
                        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs">
                          Pending
                        </span>
                      )}
                    </div>
                    {row.counterparty && row.description && (
                      <div className="text-muted-foreground text-xs">
                        {row.description}
                      </div>
                    )}
                  </td>
                  <td className="text-muted-foreground hidden py-2 pr-3 md:table-cell">
                    {row.account}
                  </td>
                  <td className="text-muted-foreground hidden py-2 pr-3 sm:table-cell">
                    {row.category ?? "–"}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap tabular-nums">
                    {formatMoney(row.amountMinor, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
