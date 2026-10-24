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
    expect(env.SYNC_CRON).toBe("0 */6 * * *");
  });

  it("reads SYNC_CRON and rejects one that is not a cron expression", () => {
    const url = "postgres://user:pass@localhost:5432/finances";
    expect(
      parseEnv({ DATABASE_URL: url, SYNC_CRON: " 0 6,18 * * * " }).SYNC_CRON,
    ).toBe("0 6,18 * * *");
    expect(() =>
      parseEnv({ DATABASE_URL: url, SYNC_CRON: "every hour" }),
    ).toThrow(/SYNC_CRON/);
  });

  it("reads an optional PRICE_API_KEY, blank as unset", () => {
    const url = "postgres://user:pass@localhost:5432/finances";
    expect(parseEnv({ DATABASE_URL: url }).PRICE_API_KEY).toBeUndefined();
    expect(
      parseEnv({ DATABASE_URL: url, PRICE_API_KEY: " " }).PRICE_API_KEY,
    ).toBeUndefined();
    expect(
      parseEnv({ DATABASE_URL: url, PRICE_API_KEY: "abc" }).PRICE_API_KEY,
    ).toBe("abc");
  });

  it("reads the optional Kraken key pair and CoinGecko key", () => {
    const url = "postgres://user:pass@localhost:5432/finances";
    const env = parseEnv({
      DATABASE_URL: url,
      KRAKEN_API_KEY: "key",
      KRAKEN_API_SECRET: "c2VjcmV0",
      COINGECKO_API_KEY: "",
    });

    expect(env.KRAKEN_API_KEY).toBe("key");
    expect(env.KRAKEN_API_SECRET).toBe("c2VjcmV0");
    expect(env.COINGECKO_API_KEY).toBeUndefined();
    expect(parseEnv({ DATABASE_URL: url }).KRAKEN_API_KEY).toBeUndefined();
  });

  it("rejects a Kraken key without its secret", () => {
    const url = "postgres://user:pass@localhost:5432/finances";
    expect(() =>
      parseEnv({ DATABASE_URL: url, KRAKEN_API_KEY: "key" }),
    ).toThrow(/KRAKEN_API_SECRET/);
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
