import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { createDb, type Db } from "@/server/db/client";
import { applyMigrations } from "@/server/db/migrations";

/** Same major version and image as the `db` service in docker-compose.yml. */
export const POSTGRES_IMAGE = "postgres:18-alpine";

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  db: Db;
  url: string;
  stop(): Promise<void>;
}

/**
 * Starts a throwaway Postgres 18 and applies the committed migrations with
 * the app's own migration runner. Call it in `beforeAll` and `stop()` in
 * `afterAll`; every test file gets its own empty database.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  const db = createDb(url, { max: 4 });
  try {
    await applyMigrations(db);
  } catch (error) {
    await db.$client.end();
    await container.stop();
    throw error;
  }

  return {
    container,
    db,
    url,
    async stop() {
      await db.$client.end();
      await container.stop();
    },
  };
}
