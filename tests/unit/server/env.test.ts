import { describe, expect, it } from "vitest";
import { encodePasswordHash } from "@/server/auth/hash-encoding";
import { parseAuthEnv, parseEnv } from "@/server/env";

const PHC = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
const SECRET = "x".repeat(32);

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

describe("parseAuthEnv", () => {
  it("decodes the hash printed by pnpm auth:hash", () => {
    const env = parseAuthEnv({
      AUTH_PASSWORD_HASH: encodePasswordHash(PHC),
      SESSION_SECRET: SECRET,
    });

    expect(env.AUTH_PASSWORD_HASH).toBe(PHC);
    expect(env.SESSION_SECRET).toBe(SECRET);
  });

  it("accepts a raw PHC string", () => {
    expect(
      parseAuthEnv({ AUTH_PASSWORD_HASH: PHC, SESSION_SECRET: SECRET })
        .AUTH_PASSWORD_HASH,
    ).toBe(PHC);
  });

  it("rejects missing or invalid values", () => {
    expect(() => parseAuthEnv({ SESSION_SECRET: SECRET })).toThrow(
      /AUTH_PASSWORD_HASH/,
    );
    expect(() =>
      parseAuthEnv({ AUTH_PASSWORD_HASH: "hunter2", SESSION_SECRET: SECRET }),
    ).toThrow(/AUTH_PASSWORD_HASH/);
    expect(() =>
      parseAuthEnv({ AUTH_PASSWORD_HASH: PHC, SESSION_SECRET: "short" }),
    ).toThrow(/SESSION_SECRET/);
  });
});
