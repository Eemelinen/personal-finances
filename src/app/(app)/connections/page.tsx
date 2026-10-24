import type { Metadata } from "next";
import { Landmark } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { verifySession } from "@/lib/auth/session";
import { formatDateTime, formatDuration, formatLocalDay } from "@/lib/format";
import {
  SUPPORTED_BANKS,
  type CallbackError,
} from "@/server/connections/authorization";
import { listConnections } from "@/server/connections/manage";
import { getEnv } from "@/server/env";
import { getSyncLog } from "@/server/queries/sync-log";
import { ConnectForm } from "./connect-form";
import { ConnectionList, type ConnectionView } from "./connection-list";

export const metadata: Metadata = { title: "Connections" };

const CALLBACK_ERRORS: Record<CallbackError, string> = {
  cancelled:
    "The bank login was cancelled, so no connection was made. Connect again when you are ready.",
  invalid_state:
    "That bank login could not be matched to a connection you started (it was already used, expired or is not from this app). Start again.",
  provider_error:
    "The bank or the bank service reported an error, so no connection was made. Try again.",
};

export default function ConnectionsPage({
  searchParams,
}: PageProps<"/connections">) {
  return (
    <>
      <PageHeader
        title="Connections"
        description="Banks linked through Enable Banking (read-only) and their consent."
      />
      <Suspense
        fallback={<p className="text-muted-foreground">Loading connections…</p>}
      >
        <ConnectionsSection searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function ConnectionsSection({
  searchParams,
}: Pick<PageProps<"/connections">, "searchParams">) {
  // Also awaits io(), so reading the clock below is request-time.
  await verifySession();
  const query = await searchParams;
  const timeZone = getEnv().APP_TIMEZONE;
  const connections = await listConnections();
  const syncLog = await getSyncLog(connections.map(({ id }) => id));

  const error = single(query.error);
  const errorMessage =
    error && error in CALLBACK_ERRORS
      ? CALLBACK_ERRORS[error as CallbackError]
      : null;
  const connected = connections.find(
    (connection) => connection.id === single(query.connected),
  );
  // The callback synced it: its latest run is the transactions', unless the
  // balances already failed.
  const latestRun = connected && syncLog.get(connected.id)?.[0];
  const firstSyncSucceeded =
    latestRun?.kind === "transactions" && latestRun.status === "succeeded";

  const views: ConnectionView[] = connections.map((connection) => ({
    id: connection.id,
    institutionName: connection.institutionName,
    status:
      connection.status === "active" && connection.consentExpired
        ? "expired"
        : connection.status,
    consentExpires: connection.consentExpiresAt
      ? formatLocalDay(connection.consentExpiresAt, timeZone)
      : null,
    lastSynced: connection.lastSyncedAt
      ? formatDateTime(connection.lastSyncedAt, timeZone)
      : null,
    accounts: connection.accounts,
    syncLog: (syncLog.get(connection.id) ?? []).map((run) => ({
      id: run.id,
      kind: run.kind,
      status: run.status,
      started: formatDateTime(run.startedAt, timeZone),
      duration: run.durationMs === null ? null : formatDuration(run.durationMs),
      accounts: run.accounts,
      fetched: run.fetched,
      inserted: run.inserted,
      updated: run.updated,
      error: run.error,
    })),
  }));

  return (
    <div className="flex flex-col gap-6">
      {errorMessage && (
        <p
          role="alert"
          className="border-destructive/50 text-destructive rounded-lg border px-4 py-3 text-sm"
        >
          {errorMessage}
        </p>
      )}
      {connected && (
        <p role="status" className="rounded-lg border px-4 py-3 text-sm">
          Connected {connected.institutionName} with {connected.accounts.length}{" "}
          {connected.accounts.length === 1 ? "account" : "accounts"}.{" "}
          {firstSyncSucceeded
            ? "Its balances and transactions are synced."
            : "The first sync did not finish (see the sync log below); it is retried with the next scheduled sync, or use Sync now."}{" "}
          Name the accounts and choose checking or savings below.
        </p>
      )}
      <ConnectForm banks={SUPPORTED_BANKS.map((bank) => bank.name)} />
      {views.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="No connections yet"
          description="Connect Nordea or S-Pankki above, or import a netbank CSV export."
        >
          <Button asChild variant="outline">
            <Link href="/import">Import a CSV export</Link>
          </Button>
        </EmptyState>
      ) : (
        <ConnectionList connections={views} />
      )}
    </div>
  );
}
