import { defineConfig } from "vitest/config";

/**
 * Root config: wires the test projects together.
 *
 *   pnpm test:unit         -> vitest run --project unit
 *   pnpm test:integration  -> vitest run --project integration (L2, Docker)
 */
export default defineConfig({
  test: {
    projects: ["./vitest.unit.config.mts", "./vitest.integration.config.mts"],
  },
});
