import type { Metadata } from "next";
import { ArrowLeftRight } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { verifySession } from "@/lib/auth/session";
import { formatMoney, formatMoneyChange } from "@/lib/format";
import { listCategoryOptions } from "@/server/categorization/manage";
import type { LeftOutReason } from "@/server/queries/reports";
import {
  isFiltered,
  parseTransactionQuery,
  transactionSearchParams,
  transactionsHref,
  type TransactionFilter,
} from "@/server/queries/transaction-filter";
import {
  listAccountOptions,
  listTransactions,
  type NotCounted,
  type TransactionPage,
} from "@/server/queries/transactions";
import { TransactionFilters } from "./transaction-filters";
import { TransactionTable } from "./transaction-table";

export const metadata: Metadata = { title: "Transactions" };

export default function TransactionsPage({
  searchParams,
}: PageProps<"/transactions">) {
  return (
    <>
      <PageHeader
        title="Transactions"
        description="Every booked and pending transaction across your accounts."
      />
      <Suspense
        fallback={
          <p className="text-muted-foreground">Loading transactions…</p>
        }
      >
        <TransactionsSection searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function TransactionsSection({
  searchParams,
}: Pick<PageProps<"/transactions">, "searchParams">) {
  await verifySession();
  const { filter, page } = parseTransactionQuery(await searchParams);
  const [result, accounts, categories] = await Promise.all([
    listTransactions(filter, page),
    listAccountOptions(),
    listCategoryOptions(),
  ]);

  if (result.total === 0 && !isFiltered(filter)) {
    return (
      <EmptyState
        icon={ArrowLeftRight}
        title="No transactions yet"
        description="Transactions appear here after the first bank sync or CSV import."
      >
        <Button asChild variant="outline">
          <Link href="/import">Import a CSV export</Link>
        </Button>
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* A new URL remounts the form, so its fields show the URL's filter. */}
      <TransactionFilters
        key={transactionSearchParams(filter).toString()}
        filter={filter}
        accounts={accounts}
        categories={categories}
      />
      <Totals filter={filter} result={result} />
      {result.total === 0 ? (
        <p className="text-muted-foreground">
          No transactions match the filters.
        </p>
      ) : (
        <TransactionTable rows={result.rows} categories={categories} />
      )}
      <Pagination filter={filter} result={result} />
    </div>
  );
}

const plural = (count: number) =>
  `${count} ${count === 1 ? "transaction" : "transactions"}`;

/**
 * The totals count like the cash-flow report (F-034): Income, Expenses,
 * Net and, when not zero, Other money in of the rows that count, then a
 * "Not counted" line for the rest.
 */
function Totals({
  filter,
  result,
}: {
  filter: TransactionFilter;
  result: TransactionPage;
}) {
  const { totals } = result;
  const figures: [string, number][] = [
    ["Income", totals.incomeMinor],
    ["Expenses", totals.expensesMinor],
    ["Net", totals.netMinor],
  ];
  if (totals.otherInMinor !== 0) {
    figures.push(["Other money in", totals.otherInMinor]);
  }
  return (
    <section
      aria-label="Totals"
      data-testid="transaction-totals"
      className="flex flex-col gap-2 rounded-xl border p-4"
    >
      <p className="text-sm">
        <span className="font-medium tabular-nums">{result.total}</span>{" "}
        {result.total === 1 ? "transaction" : "transactions"}
      </p>
      {result.total > 0 && (
        <dl
          className={`grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3 ${figures.length > 3 ? "lg:grid-cols-4" : ""}`}
        >
          {figures.map(([term, amount]) => (
            <div key={term} className="flex flex-col">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="font-medium tabular-nums">
                {formatMoney(amount, totals.currency)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {result.notCounted.count > 0 && (
        <NotCountedLine filter={filter} notCounted={result.notCounted} />
      )}
    </section>
  );
}

const REASON_LABELS: Record<LeftOutReason, string> = {
  transfer: "own transfers",
  excluded: "excluded from reports",
  household: "with household members",
  currency: "in other currencies",
};

const REASON_EXPLANATIONS: Record<LeftOutReason, string> = {
  transfer: "own transfers only move money between your own accounts",
  excluded: "excluded transactions are left out of every report",
  household:
    "transactions with household members are ignored (Settings → Household)",
  currency: "only EUR is counted",
};

/**
 * "Not counted: N transactions (+x / −y)" and why. A reason links to the
 * same filter with its `only` value when that lists exactly its rows; with
 * more than one reason, a second line explains them.
 */
function NotCountedLine({
  filter,
  notCounted,
}: {
  filter: TransactionFilter;
  notCounted: NotCounted;
}) {
  const { reasons } = notCounted;
  const mixed = reasons.length > 1;
  const sums = notCounted.sums
    .map(
      (sum) =>
        `${formatMoneyChange(sum.creditMinor, sum.currency)} / ${formatMoneyChange(sum.debitMinor, sum.currency)}`,
    )
    .join("; ");
  const overlap =
    reasons.reduce((total, reason) => total + reason.count, 0) >
    notCounted.count;
  return (
    <div data-testid="not-counted" className="flex flex-col gap-1 text-sm">
      <p>
        <span className="text-muted-foreground">Not counted:</span>{" "}
        <span className="tabular-nums">{plural(notCounted.count)}</span>{" "}
        <span className="tabular-nums">({sums})</span>:{" "}
        {reasons.map((reason, index) => {
          const label = REASON_LABELS[reason.reason];
          // No link to the view that is already shown.
          const only =
            reason.filter !== null && filter[reason.filter] !== "only"
              ? reason.filter
              : null;
          return (
            <span key={reason.reason}>
              {index > 0 && ", "}
              {only ? (
                <Link
                  href={transactionsHref({ ...filter, [only]: "only" })}
                  className="underline underline-offset-4"
                >
                  {label}
                </Link>
              ) : (
                label
              )}
              {mixed && <span className="tabular-nums"> ({reason.count})</span>}
            </span>
          );
        })}
        .
      </p>
      {mixed && (
        <p className="text-muted-foreground">
          Like the reports, the totals leave these out:{" "}
          {reasons
            .map((reason) => REASON_EXPLANATIONS[reason.reason])
            .join("; ")}
          .{overlap && " Some transactions have more than one reason."}
        </p>
      )}
    </div>
  );
}

function Pagination({
  filter,
  result,
}: {
  filter: TransactionFilter;
  result: TransactionPage;
}) {
  if (result.pageCount <= 1) return null;
  const { page, pageCount } = result;
  const link = (target: number, label: string) =>
    target < 1 || target > pageCount || target === page ? (
      <Button variant="outline" size="sm" disabled>
        {label}
      </Button>
    ) : (
      <Button asChild variant="outline" size="sm">
        <Link href={transactionsHref(filter, target)}>{label}</Link>
      </Button>
    );
  return (
    <nav aria-label="Pagination" className="flex items-center gap-2">
      {link(1, "First")}
      {link(page - 1, "Previous")}
      <span className="px-2 text-sm tabular-nums" aria-current="page">
        Page {page} of {pageCount}
      </span>
      {link(page + 1, "Next")}
      {link(pageCount, "Last")}
    </nav>
  );
}
