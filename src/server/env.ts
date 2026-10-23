import { z } from "zod";

// Shared by the Next.js app, the worker and scripts, so it must not import
// anything Next-specific. New variables are added here as features need them.
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.url(),
  APP_TIMEZONE: z.string().default("Europe/Helsinki"),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid environment variables:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

let cached: Env | undefined;

// Parsed lazily so that `next build` works without a database configured.
export function getEnv(): Env {
  return (cached ??= parseEnv(process.env));
}
