import { Clock, TriangleAlert } from "lucide-react";
import { RenewButton } from "@/components/connections/renew-button";
import { verifySession } from "@/lib/auth/session";
import { formatLocalDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getEnv } from "@/server/env";
import { getConsentAlerts } from "@/server/queries/consent";

/**
 * The consent banner on every page (F-011): a warning for each bank
 * connection whose consent ends within 14 days, an error for each one whose
 * consent has ended (it is no longer synced), each with Renew. Reads the
 * database, so it checks the session itself and streams in behind a
 * Suspense boundary; nothing is shown while every consent is fine.
 */
export async function ConsentBanner() {
  // Also awaits io(), so reading the clock below is request-time.
  await verifySession();
  const alerts = await getConsentAlerts();
  if (alerts.length === 0) return null;
  const timeZone = getEnv().APP_TIMEZONE;

  return (
    <section
      aria-label="Bank consents"
      className="flex flex-col gap-2 px-4 pt-4 md:px-8"
    >
      {alerts.map((alert) => {
        const expired = alert.level === "expired";
        const Icon = expired ? TriangleAlert : Clock;
        const day = alert.consentExpiresAt
          ? formatLocalDay(alert.consentExpiresAt, timeZone)
          : "";
        return (
          <div
            key={alert.connectionId}
            data-testid="consent-banner"
            data-level={alert.level}
            data-consent-for={alert.connectionId}
            className={cn(
              "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3 text-sm",
              expired
                ? "border-destructive/50 text-destructive"
                : "border-amber-600/50 text-amber-800 dark:text-amber-300",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1">
              {expired
                ? `${alert.institution}: the bank consent has ended, so it is no longer synced. Renew it to continue its history.`
                : `${alert.institution}: the bank consent ends on ${day}. Renew it to keep syncing.`}
            </p>
            <RenewButton
              connectionId={alert.connectionId}
              institution={alert.institution}
              variant={expired ? "default" : "outline"}
            />
          </div>
        );
      })}
    </section>
  );
}
