import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_ENV_SHAPE,
  parseAuthEnv,
  parseEncryptionEnv,
  parseEnv,
} from "@/server/env";
import { encodePasswordHash } from "@/server/auth/hash-encoding";
import { hashPassword } from "@/server/auth/password";
import {
  E2E_ENCRYPTION_KEY,
  E2E_PASSWORD,
  E2E_SESSION_SECRET,
} from "../../e2e/support/credentials";
import {
  checkTestEnvironment,
  removeEnvFiles,
  testEnvironment,
} from "../../e2e/support/test-env";

const TEST_DATABASE_URL = "postgres://test:test@localhost:55432/test";

// What a real machine's `.env` (loaded into the runner's environment, as
// Docker Compose would) holds: a value for every variable the app reads, none
// of them equal to a test value or a schema default.
const PRODUCTION = {
  NODE_ENV: "development",
  DATABASE_URL:
    "postgres://finances:real-password@db.example.com:5432/finances",
  APP_TIMEZONE: "UTC",
  SYNC_CRON: "15 */4 * * *",
  BANK_PROVIDER: "enable_banking",
  PRICE_API_KEY: "real-price-key",
  COINGECKO_API_KEY: "real-coingecko-key",
  KRAKEN_API_KEY: "real-kraken-key",
  KRAKEN_API_SECRET: "real-kraken-secret",
  ENABLE_BANKING_APP_ID: "real-app-id",
  ENABLE_BANKING_PRIVATE_KEY_PATH: "/run/secrets/enable-banking.pem",
  ENABLE_BANKING_REDIRECT_URL:
    "https://finances.example.com/connections/callback",
  ENABLE_BANKING_ENV: "production",
  BACKUP_DIR: "/backups",
  BACKUP_AGE_RECIPIENTS:
    "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
  NTFY_URL: "https://ntfy.sh/real-topic",
  NTFY_TOKEN: "real-ntfy-token",
  NOTIFY_FAILED_SYNCS: "5",
  AUTH_PASSWORD_HASH: "real-password-hash",
  SESSION_SECRET: "real-session-secret-that-is-long-enough-0001",
  ENCRYPTION_KEY: "cmVhbC1lbmNyeXB0aW9uLWtleS0wMDAwMDAwMDAwMDE=",
};

const UNRELATED = {
  PATH: "/usr/local/bin:/usr/bin",
  DOCKER_HOST: "unix:///var/run/docker.sock",
  TESTCONTAINERS_RYUK_DISABLED: "true",
  E2E_PORT: "3100",
};

const passwordHash = encodePasswordHash(await hashPassword(E2E_PASSWORD));
const values = { databaseUrl: TEST_DATABASE_URL, passwordHash };
const appKeys = Object.keys(APP_ENV_SHAPE);

describe("testEnvironment", () => {
  const env = testEnvironment({ ...PRODUCTION, ...UNRELATED }, values);

  it("covers every variable the app's schemas read", () => {
    expect(Object.keys(PRODUCTION).sort()).toEqual([...appKeys].sort());
    for (const key of appKeys) expect(env).toHaveProperty(key);
  });

  it("gives app variables test values only, whatever the base holds", () => {
    const fromEmptyBase = testEnvironment({}, values);
    for (const key of appKeys) {
      expect(env[key], key).toBe(fromEmptyBase[key]);
      expect(env[key], key).not.toBe(
        PRODUCTION[key as keyof typeof PRODUCTION],
      );
    }
    expect(env).toMatchObject({
      NODE_ENV: "production",
      DATABASE_URL: TEST_DATABASE_URL,
      AUTH_PASSWORD_HASH: passwordHash,
      SESSION_SECRET: E2E_SESSION_SECRET,
      ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
      BANK_PROVIDER: "fake",
      APP_TIMEZONE: "Europe/Helsinki",
      BACKUP_DIR: "",
      BACKUP_AGE_RECIPIENTS: "",
      NTFY_URL: "",
      KRAKEN_API_KEY: "",
      ENABLE_BANKING_APP_ID: "",
    });
  });

  it("parses with the app's own parsers, optional values unset", () => {
    const parsed = parseEnv(env);
    expect(parsed).toMatchObject({
      DATABASE_URL: TEST_DATABASE_URL,
      BANK_PROVIDER: "fake",
      ENABLE_BANKING_ENV: "sandbox",
      NOTIFY_FAILED_SYNCS: 3,
    });
    expect(parsed.BACKUP_AGE_RECIPIENTS).toBeUndefined();
    expect(parsed.NTFY_URL).toBeUndefined();
    expect(parsed.PRICE_API_KEY).toBeUndefined();
    expect(parseAuthEnv(env).SESSION_SECRET).toBe(E2E_SESSION_SECRET);
    expect(parseEncryptionEnv(env).ENCRYPTION_KEY).toHaveLength(32);
    expect(() => checkTestEnvironment(env)).not.toThrow();
  });

  it("passes unrelated variables through", () => {
    expect(env).toMatchObject(UNRELATED);
  });
});

describe("checkTestEnvironment", () => {
  it("fails with the parser's message", () => {
    const env = testEnvironment({}, { ...values, databaseUrl: "not a url" });
    expect(() => checkTestEnvironment(env)).toThrow(
      /test environment.*is invalid: Invalid environment variables:[\s\S]*DATABASE_URL/,
    );
  });
});

describe("removeEnvFiles", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("deletes every .env* file of a standalone directory and nothing else", () => {
    dir = mkdtempSync(path.join(tmpdir(), "e2e-standalone-"));
    for (const name of [".env", ".env.production", ".env.local", "server.js"]) {
      writeFileSync(path.join(dir, name), "SECRET=1\n");
    }
    mkdirSync(path.join(dir, ".next"));

    expect(removeEnvFiles(dir).sort()).toEqual([
      ".env",
      ".env.local",
      ".env.production",
    ]);
    expect(readdirSync(dir).sort()).toEqual([".next", "server.js"]);
    expect(removeEnvFiles(dir)).toEqual([]);
  });
});
