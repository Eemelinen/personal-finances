import type { Metadata } from "next";
import { Landmark } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Connections" };

export default function ConnectionsPage() {
  return (
    <>
      <PageHeader
        title="Connections"
        description="Banks linked through Enable Banking and CSV imports."
      />
      <EmptyState
        icon={Landmark}
        title="No connections yet"
        description="Connected banks and their consent status will be listed here."
      />
    </>
  );
}
