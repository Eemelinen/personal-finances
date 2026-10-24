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

  it("reads the backup directory with its age recipients, both or neither", () => {
    const url = "postgres://user:pass@localhost:5432/finances";
    const a = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";
    const b = "age1lggyhqrw2nlhcxprm67z43rta597azn8gknawjehu9d9dl0jq3yqqvfafg";
    const env = parseEnv({
      DATABASE_URL: url,
      BACKUP_DIR: "/backups",
      BACKUP_AGE_RECIPIENTS: ` ${a}, ${b} `,
    });
    expect(env.BACKUP_DIR).toBe("/backups");
    expect(env.BACKUP_AGE_RECIPIENTS).toEqual([a, b]);

    const unset = parseEnv({
      DATABASE_URL: url,
      BACKUP_DIR: "",
      BACKUP_AGE_RECIPIENTS: "",
    });
    expect(unset.BACKUP_DIR).toBeUndefined();
    expect(unset.BACKUP_AGE_RECIPIENTS).toBeUndefined();

    // Backups are never written unencrypted.
    expect(() =>
      parseEnv({ DATABASE_URL: url, BACKUP_DIR: "/backups" }),
    ).toThrow(/BACKUP_AGE_RECIPIENTS/);
    expect(() =>
      parseEnv({ DATABASE_URL: url, BACKUP_AGE_RECIPIENTS: a }),
    ).toThrow(/BACKUP_DIR/);
    expect(() =>
      parseEnv({
        DATABASE_URL: url,
        BACKUP_DIR: "/backups",
        BACKUP_AGE_RECIPIENTS: "ssh-ed25519 AAAA",
      }),
    ).toThrow(/age public keys/);
  });

  it("reads the optional ntfy topic and the failed-sync threshold", () => {
    const url = "postgres://user:pass@localhost:5432/finances";
    const defaults = parseEnv({ DATABASE_URL: url, NTFY_URL: "" });
    expect(defaults.NTFY_URL).toBeUndefined();
    expect(defaults.NTFY_TOKEN).toBeUndefined();
    expect(defaults.NOTIFY_FAILED_SYNCS).toBe(3);

    const env = parseEnv({
      DATABASE_URL: url,
      NTFY_URL: "https://ntfy.sh/finances-x1",
      NTFY_TOKEN: "tk_abc",
      NOTIFY_FAILED_SYNCS: "5",
    });
    expect(env.NTFY_URL).toBe("https://ntfy.sh/finances-x1");
    expect(env.NTFY_TOKEN).toBe("tk_abc");
    expect(env.NOTIFY_FAILED_SYNCS).toBe(5);
    expect(() => parseEnv({ DATABASE_URL: url, NTFY_URL: "ntfy" })).toThrow(
      /NTFY_URL/,
    );
    expect(() =>
      parseEnv({ DATABASE_URL: url, NOTIFY_FAILED_SYNCS: "0" }),
    ).toThrow(/NOTIFY_FAILED_SYNCS/);
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
