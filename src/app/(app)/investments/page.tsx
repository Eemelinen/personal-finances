import type { Metadata } from "next";
import { Suspense } from "react";
import { HoldingsTable } from "@/components/investments/holdings-table";
import { PageHeader } from "@/components/page-header";
import { verifySession } from "@/lib/auth/session";
import { localDate } from "@/server/dates";
import { getEnv } from "@/server/env";
import { getInvestmentsOverview } from "@/server/queries/investments";
import { ManualHoldingForm } from "./manual-holding-form";
import { NordnetImportForm } from "./nordnet-import-form";

export const metadata: Metadata = { title: "Investments" };

export default function InvestmentsPage() {
  return (
    <>
      <PageHeader
        title="Investments"
        description="Holdings of your brokerage and crypto accounts, valued with the latest closing and market prices."
      />
      <div className="flex flex-col gap-8">
        <Suspense
          fallback={<p className="text-muted-foreground">Loading holdings…</p>}
        >
          <Holdings />
        </Suspense>
        <NordnetImportForm />
        <ManualHoldingForm />
      </div>
    </>
  );
}

async function Holdings() {
  // Also awaits io(), so reading the clock below is request-time.
  await verifySession();
  const today = localDate(new Date(), getEnv().APP_TIMEZONE);
  const overview = await getInvestmentsOverview(today);
  return <HoldingsTable overview={overview} />;
}
