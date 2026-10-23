import type { Metadata } from "next";
import { Settings } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Categories, rules and app preferences."
      />
      <EmptyState
        icon={Settings}
        title="No settings yet"
        description="Categories, categorisation rules and preferences will be managed here."
      />
    </>
  );
}
