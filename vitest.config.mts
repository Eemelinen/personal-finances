import { defineConfig } from "vitest/config";

/**
 * Root config: wires the test projects together.
 *
 *   pnpm test:unit  -> vitest run --project unit
 *
 * The integration project (L2) is added here by F-002.
 */
export default defineConfig({
  test: {
    projects: ["./vitest.unit.config.mts"],
  },
});
