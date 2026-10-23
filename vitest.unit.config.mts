import { defineConfig } from "vitest/config";

/** Fast, hermetic unit tests: no database, no network. Includes the harness tests. */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: "unit",
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
