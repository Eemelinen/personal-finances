import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { verifySession } from "@/lib/auth/session";
import { listImportAccounts } from "@/server/csv/import-csv";
import { ImportForm } from "./import-form";

export const metadata: Metadata = { title: "Import" };

export default function ImportPage() {
  return (
    <>
      <PageHeader
        title="Import"
        description="Import a Nordea or S-Pankki netbank CSV export, a Nordea credit card export, or any CSV with a date and an amount column. Rows already stored are skipped."
      />
      <Suspense
        fallback={<p className="text-muted-foreground">Loading accounts…</p>}
      >
        <ImportSection />
      </Suspense>
    </>
  );
}

async function ImportSection() {
  await verifySession();
  const accounts = await listImportAccounts();
  return <ImportForm accounts={accounts} />;
}
