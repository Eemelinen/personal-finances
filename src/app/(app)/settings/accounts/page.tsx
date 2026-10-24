import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { verifySession } from "@/lib/auth/session";
import { formatDay, formatMoney } from "@/lib/format";
import { listManualAccounts } from "@/server/connections/manual-accounts";
import { localDate } from "@/server/dates";
import { getEnv } from "@/server/env";
import { ManualAccounts, type ManualAccountView } from "./manual-accounts";

export const metadata: Metadata = { title: "Accounts" };

export default function AccountSettingsPage() {
  return (
    <>
      <PageHeader
        title="Accounts"
        description="Your own accounts that no bank connection shows. Their IBAN turns money moved to and from them into own transfers, and their balance counts in net worth."
      />
      <Suspense
        fallback={<p className="text-muted-foreground">Loading accounts…</p>}
      >
        <AccountSettings />
      </Suspense>
    </>
  );
}

async function AccountSettings() {
  // Also awaits io(), so reading the clock below is request-time.
  await verifySession();
  const today = localDate(new Date(), getEnv().APP_TIMEZONE);
  const accounts: ManualAccountView[] = (await listManualAccounts()).map(
    (account) => ({
      id: account.id,
      name: account.name,
      institution: account.institution,
      iban: account.iban,
      type: account.type,
      balance: account.balance
        ? `${formatMoney(account.balance.amountMinor, account.currency)} on ${formatDay(account.balance.date)}`
        : null,
    }),
  );
  return <ManualAccounts accounts={accounts} today={today} />;
}
