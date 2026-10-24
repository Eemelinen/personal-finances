import type {
  BankSyncErrorKind,
  BankSyncResult,
  BankSyncSkipReason,
} from "@/server/sync/bank-sync";

// What Sync now tells the user (F-010): one sentence per connection.

export interface SyncNowResult {
  /** False when any connection's sync failed. */
  ok: boolean;
  message: string;
}

const FAILURES: Record<BankSyncErrorKind, string> = {
  auth_expired: "the consent has ended; renew it on Connections",
  rate_limited: "the bank is limiting requests; try again later",
  unavailable: "the bank service is not reachable; try again later",
  not_active: "the connection is not active",
  internal: "the sync failed; see the sync log on Connections",
};

const SKIPS: Record<BankSyncSkipReason, string> = {
  running: "a sync was already running",
  removed: "the connection was removed",
  consent_expired: "the consent has ended; renew it on Connections",
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function describe(result: BankSyncResult & { institution: string }): string {
  if (result.status === "skipped") {
    return `${result.institution}: ${SKIPS[result.skipReason]}.`;
  }
  if (result.status === "failed") {
    return `${result.institution}: ${FAILURES[result.errorKind ?? "internal"]}.`;
  }
  const { inserted } = result.transactions.counts;
  return `${result.institution} synced, ${plural(inserted, "new transaction", "new transactions")}.`;
}

export function summarizeSync(
  results: (BankSyncResult & { institution: string })[],
): SyncNowResult {
  if (results.length === 0) {
    return { ok: true, message: "No active bank connection to sync." };
  }
  return {
    ok: results.every((result) => result.status !== "failed"),
    message: results.map(describe).join(" "),
  };
}
