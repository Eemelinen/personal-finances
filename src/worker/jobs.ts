import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import type { Env } from "@/server/env";
import { syncKraken } from "@/server/investments/sync-kraken";
import { updatePrices } from "@/server/investments/update-prices";
import { pgDumpCommand, pruneBackups, writeBackup } from "@/server/ops/backup";
import { sendNotifications } from "@/server/ops/notifications";
import { describeBankSync, syncBankConnections } from "@/server/sync/bank-sync";

export type Job = {
  name: string;
  /** Cron expression, evaluated in APP_TIMEZONE. */
  schedule: string;
  run: () => Promise<void>;
};

export type JobsEnv = Pick<
  Env,
  | "SYNC_CRON"
  | "DATABASE_URL"
  | "APP_TIMEZONE"
  | "BACKUP_DIR"
  | "BACKUP_AGE_RECIPIENTS"
  | "NTFY_URL"
  | "NTFY_TOKEN"
  | "NOTIFY_FAILED_SYNCS"
>;

/**
 * The worker's jobs; the bank sync runs on `SYNC_CRON`. The backup runs
 * only with `BACKUP_DIR` (and its recipients), the notifications only with
 * `NTFY_URL`.
 */
export function createJobs(env: JobsEnv): Job[] {
  const jobs: Job[] = [
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
          } else if (
            result.status === "failed" ||
            (result.status === "skipped" &&
              result.skipReason === "consent_expired")
          ) {
            // An ended consent needs the user (F-011): renew on /connections.
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

  const { BACKUP_DIR, BACKUP_AGE_RECIPIENTS } = env;
  if (BACKUP_DIR && BACKUP_AGE_RECIPIENTS) {
    jobs.push({
      // The nightly encrypted pg_dump (F-024), kept 7 daily, 4 weekly and
      // 12 monthly; pruned only after a backup succeeded.
      name: "backup",
      schedule: "30 3 * * *",
      run: async () => {
        const backup = await writeBackup({
          dir: BACKUP_DIR,
          recipients: BACKUP_AGE_RECIPIENTS,
          dump: pgDumpCommand(env.DATABASE_URL),
        });
        const removed = await pruneBackups(BACKUP_DIR, {
          timeZone: env.APP_TIMEZONE,
        });
        console.info(
          `[backup] wrote ${backup.path} (${backup.bytes} bytes), removed ${removed.length} old backup(s)`,
        );
      },
    });
  }

  if (env.NTFY_URL) {
    jobs.push({
      // Failing syncs and ending consents (F-024), hourly in the daytime so
      // nothing arrives at night; each issue at most once a day.
      name: "notifications",
      schedule: "30 8-22 * * *",
      run: async () => {
        const result = await sendNotifications(env);
        if (!result) return;
        if (result.sent.length > 0) {
          console.info(`[notifications] sent ${result.sent.join(", ")}`);
        }
        for (const { key, error } of result.failed) {
          console.warn(`[notifications] ${key} not sent: ${error}`);
        }
      },
    });
  }
  return jobs;
}
