import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { connections, institutions } from "@/server/db/schema";
import { BANK_PROVIDER_IDS } from "@/server/providers/types";
import { connectionHealth } from "./dashboard";

// The consent banner on every page (F-011): bank connections whose consent
// ends within `CONSENT_WARNING_DAYS` (a warning) or has ended, or that the
// bank stopped accepting (an error). Archived connections are never synced,
// so they are left out.

export interface ConsentAlert {
  connectionId: string;
  institution: string;
  level: "expiring" | "expired";
  consentExpiresAt: Date | null;
}

/** Expired ones first, then by the consent's end. */
export async function getConsentAlerts(
  options: { db?: Db; now?: () => Date } = {},
): Promise<ConsentAlert[]> {
  const db = options.db ?? getDb();
  const now = (options.now ?? (() => new Date()))();
  const rows = await db
    .select({
      connectionId: connections.id,
      institution: institutions.name,
      status: connections.status,
      consentExpiresAt: connections.consentExpiresAt,
    })
    .from(connections)
    .innerJoin(institutions, eq(institutions.id, connections.institutionId))
    .where(
      and(
        inArray(connections.provider, [...BANK_PROVIDER_IDS]),
        inArray(connections.status, ["active", "expired", "revoked"]),
      ),
    )
    .orderBy(
      asc(connections.consentExpiresAt),
      asc(institutions.name),
      asc(connections.id),
    );

  const alerts: ConsentAlert[] = [];
  for (const row of rows) {
    const level = connectionHealth(row, now);
    if (level === "ok") continue;
    alerts.push({
      connectionId: row.connectionId,
      institution: row.institution,
      level,
      consentExpiresAt: row.consentExpiresAt,
    });
  }
  return [
    ...alerts.filter((alert) => alert.level === "expired"),
    ...alerts.filter((alert) => alert.level === "expiring"),
  ];
}
