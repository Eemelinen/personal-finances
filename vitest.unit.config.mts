import { defineConfig } from "vitest/config";

/** Fast, hermetic unit tests: no database, no network. */
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
