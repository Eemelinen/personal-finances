"use server";

import { refresh } from "next/cache";
import { verifySession } from "@/lib/auth/session";
import { isUuid } from "@/server/queries/transaction-filter";
import { describeBankSync, syncBankConnections } from "@/server/sync/bank-sync";
import { summarizeSync, type SyncNowResult } from "./summary";

// Sync now (F-010): the dashboard syncs every active bank connection, a
// connection's card on /connections only that one. Both run the worker's
// sync; provider failures come back as the message, bugs are logged too.

async function syncNow(connectionIds?: string[]): Promise<SyncNowResult> {
  const results = await syncBankConnections({ connectionIds });
  for (const result of results) {
    if (result.errorKind === "internal") {
      console.error(`[sync-now] ${describeBankSync(result)}`, result.cause);
    }
  }
  refresh();
  return summarizeSync(results);
}

export async function syncAllBanksAction(): Promise<SyncNowResult> {
  await verifySession();
  return syncNow();
}

export async function syncConnectionAction(
  connectionId: string,
): Promise<SyncNowResult> {
  await verifySession();
  if (typeof connectionId !== "string" || !isUuid(connectionId)) {
    return { ok: false, message: "Choose a connection to sync." };
  }
  return syncNow([connectionId.toLowerCase()]);
}
