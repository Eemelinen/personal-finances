import type { Metadata } from "next";
import { ArrowLeftRight } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Transactions" };

export default function TransactionsPage() {
  return (
    <>
      <PageHeader
        title="Transactions"
        description="Every booked and pending transaction across your accounts."
      />
      <EmptyState
        icon={ArrowLeftRight}
        title="No transactions yet"
        description="Transactions appear here after the first bank sync or CSV import."
      >
        <Button asChild variant="outline">
          <Link href="/import">Import a CSV export</Link>
        </Button>
      </EmptyState>
    </>
  );
}
