import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
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
];
