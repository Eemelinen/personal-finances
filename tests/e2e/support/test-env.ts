/**
 * The environment L3 builds and serves the app with (./server.ts). Next.js
 * loads the checkout's `.env` files during `next build` and copies them into
 * `.next/standalone`, where the served app loads them again, but it never
 * overrides a variable the process already has, even an empty one. So every
 * variable the app reads (`APP_ENV_SHAPE` in src/server/env.ts) gets a test
 * value here: the schema's default, or an empty value, which env.ts reads as
 * unset. A real `.env` in the checkout then cannot reach the test app.
 */
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
  APP_ENV_SHAPE,
  parseAuthEnv,
  parseEncryptionEnv,
  parseEnv,
} from "@/server/env";
import { E2E_ENCRYPTION_KEY, E2E_SESSION_SECRET } from "./credentials";
import { E2E_TIME_ZONE } from "./database";

export interface TestEnvironmentValues {
  /** The Testcontainers database the run started. */
  databaseUrl: string;
  /** `AUTH_PASSWORD_HASH` for ./credentials.ts's `E2E_PASSWORD`. */
  passwordHash: string;
}

/** The schema's default as a string, or "" (unset) when it has none. */
function defaultValue(schema: z.ZodType): string {
  const result = schema.safeParse(undefined);
  return result.success && result.data !== undefined ? String(result.data) : "";
}

function isAppVariable(key: string): boolean {
  return Object.hasOwn(APP_ENV_SHAPE, key);
}

/**
 * `base` (the runner's environment) without the app's variables, which get
 * test values instead; the rest (PATH, Docker and Testcontainers settings)
 * passes through.
 */
export function testEnvironment(
  base: Record<string, string | undefined>,
  values: TestEnvironmentValues,
): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !isAppVariable(key)) env[key] = value;
  }
  for (const [key, schema] of Object.entries(APP_ENV_SHAPE)) {
    env[key] = defaultValue(schema);
  }
  return {
    ...env,
    NODE_ENV: "production",
    DATABASE_URL: values.databaseUrl,
    AUTH_PASSWORD_HASH: values.passwordHash,
    SESSION_SECRET: E2E_SESSION_SECRET,
    APP_TIMEZONE: E2E_TIME_ZONE,
    BANK_PROVIDER: "fake",
    ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
  };
}

/**
 * Parses `env` with the app's own parsers, so an invalid test environment
 * fails the run with their message before the build starts.
 */
export function checkTestEnvironment(
  env: Record<string, string | undefined>,
): void {
  try {
    parseEnv(env);
    parseAuthEnv(env);
    parseEncryptionEnv(env);
  } catch (error) {
    throw new Error(
      `the test environment (tests/e2e/support/test-env.ts) is invalid: ${(error as Error).message}`,
    );
  }
}

const isEnvFile = (name: string) => name.startsWith(".env");

/**
 * Deletes the `.env*` files `next build` copied into the standalone output
 * `dir`, and throws if any is left. Returns the names it deleted.
 */
export function removeEnvFiles(dir: string): string[] {
  const removed = readdirSync(dir).filter(isEnvFile);
  for (const name of removed) {
    rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  const left = readdirSync(dir).filter(isEnvFile);
  if (left.length > 0) {
    throw new Error(`${dir} still holds ${left.join(", ")}`);
  }
  return removed;
}
