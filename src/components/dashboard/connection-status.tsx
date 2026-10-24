import { CircleCheck, Clock, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { SyncNowButton } from "@/components/sync/sync-now-button";
import { cn } from "@/lib/utils";
import { formatLocalDay } from "@/lib/format";
import { syncAllBanksAction } from "@/lib/sync/actions";
import type {
  ConnectionHealth,
  ConnectionSummary,
} from "@/server/queries/dashboard";

const HEALTH = {
  ok: { label: "OK", icon: CircleCheck, className: "text-muted-foreground" },
  expiring: {
    label: "Expiring",
    icon: Clock,
    className: "text-amber-700 dark:text-amber-400",
  },
  expired: {
    label: "Expired",
    icon: TriangleAlert,
    className: "text-destructive",
  },
} satisfies Record<
  ConnectionHealth,
  { label: string; icon: typeof CircleCheck; className: string }
>;

interface ConnectionStatusProps {
  connections: ConnectionSummary[];
  timeZone: string;
}

/**
 * Each bank connection's consent state, linking to /connections, and Sync
 * now for all of them (F-010).
 */
export function ConnectionStatus({
  connections,
  timeZone,
}: ConnectionStatusProps) {
  return (
    <section
      aria-labelledby="connections-heading"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id="connections-heading" className="text-lg font-medium">
          Connections
        </h2>
        {connections.length > 0 && <SyncNowButton sync={syncAllBanksAction} />}
      </div>
      {connections.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No bank connected.{" "}
          <Link href="/connections" className="text-foreground underline">
            Connect a bank
          </Link>
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {connections.map((connection) => {
            const health = HEALTH[connection.health];
            const Icon = health.icon;
            return (
              <li key={connection.id}>
                <Link
                  href="/connections"
                  data-testid="connection"
                  className="hover:bg-muted flex flex-col gap-1 px-4 py-3"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      {connection.institution}
                    </span>
                    <span
                      data-testid="connection-status"
                      className={cn(
                        "flex items-center gap-1 text-sm font-medium",
                        health.className,
                      )}
                    >
                      <Icon className="size-4" aria-hidden="true" />
                      {health.label}
                    </span>
                  </span>
                  {connection.consentExpiresAt && (
                    <span className="text-muted-foreground text-sm">
                      Consent until{" "}
                      {formatLocalDay(connection.consentExpiresAt, timeZone)}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
