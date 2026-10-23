import type { Metadata } from "next";
import { ChartPie } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage() {
  return (
    <>
      <PageHeader
        title="Reports"
        description="Spending by category, income versus expenses and cash flow."
      />
      <EmptyState
        icon={ChartPie}
        title="Nothing to report yet"
        description="Reports are drawn from your categorised transactions once there are some."
      />
    </>
  );
}
