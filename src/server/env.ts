import { z } from "zod";
import { decodePasswordHash } from "@/server/auth/hash-encoding";

// Shared by the Next.js app, the worker and scripts, so it must not import
// anything Next-specific. New variables are added here as features need them.
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.url(),
  APP_TIMEZONE: z.string().default("Europe/Helsinki"),
});

// Only the web app needs these, so they are validated separately: the worker
// and the migrate job run without the login secrets.
const authEnvSchema = z.object({
  // Holds the PHC string after parsing, whichever form the variable used.
  AUTH_PASSWORD_HASH: z.string().transform((value, ctx) => {
    const phc = decodePasswordHash(value);
    if (phc === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "must be an argon2 hash printed by `pnpm auth:hash`",
      });
      return z.NEVER;
    }
    return phc;
  }),
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
});

export type Env = z.infer<typeof envSchema>;
export type AuthEnv = z.infer<typeof authEnvSchema>;

function parseWith<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid environment variables:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  return parseWith(envSchema, source);
}

export function parseAuthEnv(
  source: Record<string, string | undefined>,
): AuthEnv {
  return parseWith(authEnvSchema, source);
}

let cached: Env | undefined;
let cachedAuth: AuthEnv | undefined;

// Parsed lazily so that `next build` works without a database configured.
export function getEnv(): Env {
  return (cached ??= parseEnv(process.env));
}

// Parsed lazily, on the first request that needs a session.
export function getAuthEnv(): AuthEnv {
  return (cachedAuth ??= parseAuthEnv(process.env));
}
