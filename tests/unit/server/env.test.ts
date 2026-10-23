import { describe, expect, it } from "vitest";
import { parseEnv } from "@/server/env";

describe("parseEnv", () => {
  it("applies defaults", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/finances",
    });

    expect(env.NODE_ENV).toBe("development");
    expect(env.APP_TIMEZONE).toBe("Europe/Helsinki");
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });
});
