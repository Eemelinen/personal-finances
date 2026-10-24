import { existsSync } from "node:fs";
import path from "node:path";
import { seedDefaults } from "@/server/categorization/seed";
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
    const seed = await seedDefaults(getDb());
    if (seed.seeded) {
      console.info(
        `Seeded ${seed.categories} default categories and ${seed.rules} rules.`,
      );
    } else if (seed.categories > 0) {
      console.info(`Added ${seed.categories} new default category.`);
    }
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
