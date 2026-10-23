import Link from "next/link";
import { Wallet } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Balances, spending and net worth at a glance."
      />
      <EmptyState
        icon={Wallet}
        title="No accounts yet"
        description="Connect a bank or import a CSV export to see your balances and spending here."
      >
        <Button asChild>
          <Link href="/connections">Go to Connections</Link>
        </Button>
      </EmptyState>
    </>
  );
}
