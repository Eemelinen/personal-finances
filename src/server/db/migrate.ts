import { existsSync } from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, getDb } from "./client";

const migrationsFolder = path.resolve("drizzle");

async function main() {
  if (!existsSync(path.join(migrationsFolder, "meta", "_journal.json"))) {
    console.info("No migrations generated yet, nothing to apply.");
    return;
  }

  try {
    await migrate(getDb(), { migrationsFolder });
    console.info("Migrations applied.");
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
