"use server";

import { refresh } from "next/cache";
import { verifySession } from "@/lib/auth/session";
import { isUuid } from "@/server/queries/transaction-filter";
import {
  describeBankSync,
  rereadConnectionHistory,
  syncBankConnections,
  type BankConnectionSyncResult,
} from "@/server/sync/bank-sync";
import { summarizeSync, type SyncNowResult } from "./summary";

// Sync now (F-010): the dashboard syncs every active bank connection, a
// connection's card on /connections only that one. Both run the worker's
// sync; provider failures come back as the message, bugs are logged too.
// Re-read history (F-028) on a connection's card syncs it from the oldest
// day the bank has.

async function report(
  sync: Promise<BankConnectionSyncResult[]>,
): Promise<SyncNowResult> {
  const results = await sync;
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
  return report(syncBankConnections());
}

export async function syncConnectionAction(
  connectionId: string,
): Promise<SyncNowResult> {
  await verifySession();
  if (typeof connectionId !== "string" || !isUuid(connectionId)) {
    return { ok: false, message: "Choose a connection to sync." };
  }
  return report(
    syncBankConnections({ connectionIds: [connectionId.toLowerCase()] }),
  );
}

export async function rereadHistoryAction(
  connectionId: string,
): Promise<SyncNowResult> {
  await verifySession();
  if (typeof connectionId !== "string" || !isUuid(connectionId)) {
    return { ok: false, message: "Choose a connection to re-read." };
  }
  return report(rereadConnectionHistory(connectionId.toLowerCase()));
}
