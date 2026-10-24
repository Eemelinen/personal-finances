import type { Metadata } from "next";
import { ArrowLeftRight } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { verifySession } from "@/lib/auth/session";
import { formatMoney } from "@/lib/format";
import { listCategoryOptions } from "@/server/categorization/manage";
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
      <Totals result={result} />
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

function Totals({ result }: { result: TransactionPage }) {
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
      {result.totals.length > 0 && (
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {result.totals.flatMap((totals) => [
            <div key={`${totals.currency}-income`} className="flex flex-col">
              <dt className="text-muted-foreground">Income</dt>
              <dd className="font-medium tabular-nums">
                {formatMoney(totals.income, totals.currency)}
              </dd>
            </div>,
            <div key={`${totals.currency}-expense`} className="flex flex-col">
              <dt className="text-muted-foreground">Expenses</dt>
              <dd className="font-medium tabular-nums">
                {formatMoney(totals.expense, totals.currency)}
              </dd>
            </div>,
            <div key={`${totals.currency}-net`} className="flex flex-col">
              <dt className="text-muted-foreground">Net</dt>
              <dd className="font-medium tabular-nums">
                {formatMoney(totals.net, totals.currency)}
              </dd>
            </div>,
          ])}
        </dl>
      )}
    </section>
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
