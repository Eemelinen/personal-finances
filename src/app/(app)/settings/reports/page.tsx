import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { verifySession } from "@/lib/auth/session";
import { getAppSettings } from "@/server/settings";
import { ReportSettingsForm } from "./report-settings-form";

export const metadata: Metadata = { title: "Report settings" };

export default function ReportSettingsPage() {
  return (
    <>
      <PageHeader
        title="Reports"
        description="What the cash-flow report and the dashboard count as income and spending."
      />
      <Suspense
        fallback={<p className="text-muted-foreground">Loading settings…</p>}
      >
        <ReportSettings />
      </Suspense>
    </>
  );
}

async function ReportSettings() {
  await verifySession();
  const settings = await getAppSettings();
  return (
    <ReportSettingsForm
      uncategorizedCreditsAsIncome={settings.uncategorizedCreditsAsIncome}
      excludeInvestments={settings.excludeInvestments}
    />
  );
}
