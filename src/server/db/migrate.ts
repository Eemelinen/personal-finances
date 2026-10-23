import { existsSync } from "node:fs";
import path from "node:path";
import { closeDb, getDb } from "./client";
import { applyMigrations, migrationsFolder } from "./migrations";

async function main() {
  if (!existsSync(path.join(migrationsFolder, "meta", "_journal.json"))) {
    console.info("No migrations generated yet, nothing to apply.");
    return;
  }

  try {
    await applyMigrations(getDb());
    console.info("Migrations applied.");
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
