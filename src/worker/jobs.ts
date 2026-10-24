import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import type { Env } from "@/server/env";
import { syncKraken } from "@/server/investments/sync-kraken";
import { updatePrices } from "@/server/investments/update-prices";
import { describeBankSync, syncBankConnections } from "@/server/sync/bank-sync";

export type Job = {
  name: string;
  /** Cron expression, evaluated in APP_TIMEZONE. */
  schedule: string;
  run: () => Promise<void>;
};

/** The worker's jobs; the bank sync runs on `SYNC_CRON`. */
export function createJobs(env: Pick<Env, "SYNC_CRON">): Job[] {
  return [
    {
      name: "heartbeat",
      schedule: "*/15 * * * *",
      run: async () => {
        await getDb().execute(sql`select 1`);
      },
    },
    {
      // Every active bank connection (F-010): balances, then transactions. A
      // failed connection is logged and retried on the next run; the default
      // schedule is four runs a day, PSD2's limit for unattended access.
      name: "bank-sync",
      schedule: env.SYNC_CRON,
      run: async () => {
        const results = await syncBankConnections();
        if (results.length === 0) {
          console.info("[bank-sync] no active bank connection");
        }
        for (const result of results) {
          const line = `[bank-sync] ${describeBankSync(result)}`;
          if (result.errorKind === "internal") {
            console.error(line, result.cause);
          } else if (result.status === "failed") {
            console.warn(line);
          } else {
            console.info(line);
          }
        }
      },
    },
    {
      // After the ECB (about 16:00 CET) and the US close (23:00 Helsinki).
      name: "price-update",
      schedule: "30 7 * * *",
      run: async () => {
        const result = await updatePrices();
        console.info(
          `[price-update] ${result.fxRates} FX rates (${result.fxDate ?? "none"}), ${result.prices} prices, unknown: ${result.unknown.join(", ") || "none"}`,
        );
        for (const problem of result.problems) {
          console.warn(`[price-update] ${problem}`);
        }
      },
    },
    {
      // Kraken balances and ledger (F-021) of every active Kraken connection;
      // the env key creates the connection. Removing the key from the env
      // does not stop the sync: revoke it on Kraken (D-018).
      name: "kraken-sync",
      schedule: "15 */6 * * *",
      run: async () => {
        const results = await syncKraken();
        if (results.length === 0) {
          console.info("[kraken-sync] no active Kraken connection");
        }
        for (const { balances, holdings } of results) {
          const failure =
            balances.status === "failed"
              ? balances
              : holdings?.status === "failed"
                ? holdings
                : null;
          if (failure) {
            console.warn(
              `[kraken-sync] failed (${failure.errorKind}): ${failure.error}`,
            );
            continue;
          }
          for (const account of holdings?.accounts ?? []) {
            console.info(
              `[kraken-sync] ${account.holdings} holdings, ${account.zeroed} sold out, ${account.inserted} new of ${account.fetched} ledger transactions, ${account.skipped.length} entries not recorded`,
            );
          }
        }
      },
    },
  ];
}
