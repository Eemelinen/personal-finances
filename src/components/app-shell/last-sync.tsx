import { verifySession } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { getEnv } from "@/server/env";
import { getLastSuccessfulSync } from "@/server/queries/sync-log";

/**
 * The header's last successful bank sync (F-010). Reads the database, so it
 * checks the session itself and streams in behind a Suspense boundary.
 */
export async function LastSync() {
  await verifySession();
  const lastSync = await getLastSuccessfulSync();
  return (
    <p
      data-testid="last-sync"
      className="text-muted-foreground hidden text-sm sm:block"
    >
      {lastSync
        ? `Last sync ${formatDateTime(lastSync, getEnv().APP_TIMEZONE)}`
        : "No bank sync yet"}
    </p>
  );
}
