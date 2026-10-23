import { defineConfig } from "vitest/config";

/**
 * Integration tests (L2): real Postgres 18 in a throwaway Testcontainers
 * container per test file (tests/integration/helpers/postgres.ts). Needs
 * Docker; never touches the dev database.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: "integration",
    environment: "node",
    include: ["tests/integration/**/*.int.test.ts"],
    // Pulling the image and starting the container can take a while.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
