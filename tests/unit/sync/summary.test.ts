import { describe, expect, it } from "vitest";
import { summarizeSync } from "@/lib/sync/summary";
import type { BankConnectionSyncResult } from "@/server/sync/bank-sync";

// What Sync now says (F-010): one sentence per connection, failures by kind.

function result(
  values: Partial<BankConnectionSyncResult>,
): BankConnectionSyncResult {
  return {
    connectionId: "c1",
    institution: "Nordea",
    status: "succeeded",
    error: null,
    errorKind: null,
    balances: null,
    transactions: null,
    ...values,
  };
}

const transactions = (inserted: number) =>
  ({
    counts: { accounts: 1, fetched: 9, inserted, updated: 0, removed: 0 },
  }) as BankConnectionSyncResult["transactions"];

describe("summarizeSync", () => {
  it("says when there is nothing to sync", () => {
    expect(summarizeSync([])).toEqual({
      ok: true,
      message: "No active bank connection to sync.",
    });
  });

  it("counts the new transactions of each synced connection", () => {
    expect(
      summarizeSync([
        result({ transactions: transactions(1) }),
        result({ institution: "S-Pankki", transactions: transactions(12) }),
      ]),
    ).toEqual({
      ok: true,
      message:
        "Nordea synced, 1 new transaction. S-Pankki synced, 12 new transactions.",
    });
  });

  it("fails when any connection failed, saying why without the raw error", () => {
    expect(
      summarizeSync([
        result({ transactions: transactions(0) }),
        result({
          institution: "S-Pankki",
          status: "failed",
          errorKind: "auth_expired",
          error: "EXPIRED_SESSION",
        }),
        result({ status: "failed", errorKind: "internal", error: "boom" }),
        result({ status: "skipped", error: "running" }),
      ]),
    ).toEqual({
      ok: false,
      message:
        "Nordea synced, 0 new transactions. S-Pankki: the consent has ended; connect the bank again. Nordea: the sync failed; see the sync log on Connections. Nordea: a sync was already running.",
    });
  });
});
