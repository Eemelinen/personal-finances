import cron from "node-cron";
import { closeDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { jobs } from "./jobs";

const env = getEnv();

for (const job of jobs) {
  cron.schedule(
    job.schedule,
    async () => {
      const startedAt = Date.now();
      try {
        await job.run();
        console.log(`[${job.name}] ok in ${Date.now() - startedAt} ms`);
      } catch (error) {
        console.error(`[${job.name}] failed:`, error);
      }
    },
    { name: job.name, timezone: env.APP_TIMEZONE, noOverlap: true },
  );
}

console.log(
  `Worker started with ${jobs.length} job(s): ${jobs.map((j) => j.name).join(", ")}`,
);

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down worker.`);
  await cron.shutdown();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
