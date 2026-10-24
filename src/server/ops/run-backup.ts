import { getEnv } from "@/server/env";
import { pgDumpCommand, pruneBackups, writeBackup } from "./backup";

// `pnpm backup`: one backup now, as the worker's nightly `backup` job takes
// it (F-024), then the same pruning. Needs `pg_dump` on the PATH; in Docker
// Compose run it in the worker (docs/operations.md).

const env = getEnv();
if (!env.BACKUP_DIR || !env.BACKUP_AGE_RECIPIENTS) {
  console.error("Set BACKUP_DIR and BACKUP_AGE_RECIPIENTS first.");
  process.exit(1);
}
const backup = await writeBackup({
  dir: env.BACKUP_DIR,
  recipients: env.BACKUP_AGE_RECIPIENTS,
  dump: pgDumpCommand(env.DATABASE_URL),
});
const removed = await pruneBackups(env.BACKUP_DIR, {
  timeZone: env.APP_TIMEZONE,
});
console.info(
  `Wrote ${backup.path} (${backup.bytes} bytes), removed ${removed.length} old backup(s).`,
);
