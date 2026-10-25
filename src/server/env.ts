import { z } from "zod";
import { decodePasswordHash } from "@/server/auth/hash-encoding";
import { BANK_PROVIDER_IDS } from "@/server/providers/types";

const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined);

// Shared by the Next.js app, the worker and scripts, so it must not import
// anything Next-specific. New variables are added here as features need them.
const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z.url(),
    APP_TIMEZONE: z.string().default("Europe/Helsinki"),
    // When the worker syncs the bank connections (F-010), a cron expression
    // in APP_TIMEZONE. The default, every 6 hours, is PSD2's four unattended
    // fetches a day per consent (FIN-001 → Findings); the worker refuses to
    // start with an expression node-cron rejects.
    SYNC_CRON: z
      .string()
      .trim()
      .default("0 */6 * * *")
      .refine((value) => [5, 6].includes(value.split(/\s+/).length), {
        message: "must be a cron expression of 5 or 6 fields",
      }),
    // `fake` (the deterministic in-memory bank) is for tests and e2e only.
    BANK_PROVIDER: z.enum(BANK_PROVIDER_IDS).default("enable_banking"),
    // Twelve Data key for daily closing prices (F-020); without it the price
    // update fetches only the ECB exchange rates.
    PRICE_API_KEY: optionalSecret,
    // CoinGecko demo key for crypto prices (F-021); optional, the public API
    // works without one at a lower rate limit.
    COINGECKO_API_KEY: optionalSecret,
    // A read-only Kraken key (F-021): Query Funds and Query Ledger Entries
    // only. The worker stores it encrypted as the Kraken connection.
    KRAKEN_API_KEY: optionalSecret,
    KRAKEN_API_SECRET: optionalSecret,
    // Enable Banking (F-006): the application id (the JWT's `kid`), the path
    // of its RSA private key (in `secrets/`, mounted read-only into the
    // containers), where the bank sends the user back, and which
    // environment the application was registered in. Optional so the app
    // runs before a bank is set up; the provider fails on first use without
    // the id and the key.
    ENABLE_BANKING_APP_ID: optionalSecret,
    ENABLE_BANKING_PRIVATE_KEY_PATH: optionalSecret,
    ENABLE_BANKING_REDIRECT_URL: optionalSecret.pipe(z.url().optional()),
    ENABLE_BANKING_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
    // The nightly backup (F-024): where the worker writes the encrypted
    // dumps, and the age public keys (`age1…`, comma- or space-separated)
    // they are encrypted to. Both or neither; without them no backup runs.
    // Backups are never written unencrypted.
    BACKUP_DIR: optionalSecret,
    BACKUP_AGE_RECIPIENTS: optionalSecret.pipe(
      z
        .string()
        .transform((value) => value.split(/[\s,]+/).filter(Boolean))
        .pipe(
          z.array(
            z
              .string()
              .regex(/^age1[0-9a-z]+$/, "must be age public keys (age1…)"),
          ),
        )
        .optional(),
    ),
    // Notifications (F-024): an ntfy topic URL (e.g.
    // `https://ntfy.sh/<topic>`) and, for a protected topic, an access
    // token. Unset, nothing is sent.
    NTFY_URL: optionalSecret.pipe(z.url().optional()),
    NTFY_TOKEN: optionalSecret,
    // How many syncs of a connection must fail in a row before it notifies.
    NOTIFY_FAILED_SYNCS: z.coerce.number().int().min(1).default(3),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.BACKUP_DIR) !== Boolean(env.BACKUP_AGE_RECIPIENTS)) {
      ctx.addIssue({
        code: "custom",
        path: [env.BACKUP_DIR ? "BACKUP_AGE_RECIPIENTS" : "BACKUP_DIR"],
        message:
          "BACKUP_DIR and BACKUP_AGE_RECIPIENTS go together (backups are always encrypted)",
      });
    }
    if (Boolean(env.KRAKEN_API_KEY) !== Boolean(env.KRAKEN_API_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: [env.KRAKEN_API_KEY ? "KRAKEN_API_SECRET" : "KRAKEN_API_KEY"],
        message: "KRAKEN_API_KEY and KRAKEN_API_SECRET go together",
      });
    }
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

// The app and the worker need this once they store or read provider
// sessions; the migrate job does not, so it is validated separately too.
const encryptionEnvSchema = z.object({
  // 32 random bytes in canonical base64 (`openssl rand -base64 32`), so the
  // key has one spelling; holds the bytes after parsing.
  ENCRYPTION_KEY: z.string().transform((value, ctx) => {
    const trimmed = value.trim();
    const key = Buffer.from(trimmed, "base64");
    if (key.length !== 32 || key.toString("base64") !== trimmed) {
      ctx.addIssue({
        code: "custom",
        message: "must be 32 bytes, base64-encoded (openssl rand -base64 32)",
      });
      return z.NEVER;
    }
    return key;
  }),
});

// Every variable the three schemas read, so that a test environment
// (tests/e2e/support/test-env.ts) covers a variable added later too.
export const APP_ENV_SHAPE = {
  ...envSchema.shape,
  ...authEnvSchema.shape,
  ...encryptionEnvSchema.shape,
};

export type Env = z.infer<typeof envSchema>;
export type AuthEnv = z.infer<typeof authEnvSchema>;
export type EncryptionEnv = z.infer<typeof encryptionEnvSchema>;

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

export function parseEncryptionEnv(
  source: Record<string, string | undefined>,
): EncryptionEnv {
  return parseWith(encryptionEnvSchema, source);
}

let cached: Env | undefined;
let cachedAuth: AuthEnv | undefined;
let cachedEncryption: EncryptionEnv | undefined;

// Parsed lazily so that `next build` works without a database configured.
export function getEnv(): Env {
  return (cached ??= parseEnv(process.env));
}

// Parsed lazily, on the first request that needs a session.
export function getAuthEnv(): AuthEnv {
  return (cachedAuth ??= parseAuthEnv(process.env));
}

// Parsed lazily, on the first encryption or decryption.
export function getEncryptionEnv(): EncryptionEnv {
  return (cachedEncryption ??= parseEncryptionEnv(process.env));
}
