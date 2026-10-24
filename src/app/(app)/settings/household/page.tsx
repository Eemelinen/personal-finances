import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { verifySession } from "@/lib/auth/session";
import { getHousehold } from "@/server/categorization/household";
import { HouseholdLists, HouseholdToggle } from "./household-forms";

export const metadata: Metadata = { title: "Household" };

export default function HouseholdSettingsPage() {
  return (
    <>
      <PageHeader
        title="Household"
        description="Your own names, so deposits from your accounts elsewhere are own transfers, and the people you share costs with, whose transfers can be left out of income and spending."
      />
      <Suspense
        fallback={<p className="text-muted-foreground">Loading settings…</p>}
      >
        <HouseholdSettings />
      </Suspense>
    </>
  );
}

async function HouseholdSettings() {
  await verifySession();
  const household = await getHousehold();
  return (
    <div className="flex flex-col gap-6">
      <HouseholdToggle
        ignoreHouseholdTransfers={household.ignoreHouseholdTransfers}
      />
      <HouseholdLists
        ownNames={household.ownNames.join("\n")}
        members={household.members.map((member) => ({
          names: member.names.join("\n"),
          ibans: member.ibans.join("\n"),
        }))}
      />
    </div>
  );
}
