import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";

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
];
