import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { syncKraken } from "@/server/investments/sync-kraken";
import { updatePrices } from "@/server/investments/update-prices";

export type Job = {
  name: string;
  /** Cron expression, evaluated in APP_TIMEZONE. */
  schedule: string;
  run: () => Promise<void>;
};

// Bank sync jobs are registered here in FIN-010.
export const jobs: Job[] = [
  {
    name: "heartbeat",
    schedule: "*/15 * * * *",
    run: async () => {
      await getDb().execute(sql`select 1`);
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
