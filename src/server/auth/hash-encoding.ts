// An argon2 PHC string ("$argon2id$v=19$m=…") is full of `$`, which the
// Next.js .env loader expands as variable references even inside quotes, so
// `pnpm auth:hash` prints it base64url-encoded. A raw PHC string is accepted
// too, for environments that set the variable without a .env file. Kept free
// of the argon2 dependency because the env schema imports it.
const PHC_PREFIX = "$argon2";

/** The value `AUTH_PASSWORD_HASH` should hold for a PHC hash string. */
export function encodePasswordHash(phc: string): string {
  return Buffer.from(phc, "utf8").toString("base64url");
}

/** The PHC string from an `AUTH_PASSWORD_HASH` value, or undefined if it is not one. */
export function decodePasswordHash(value: string): string | undefined {
  const trimmed = value.trim();
  const phc = trimmed.startsWith(PHC_PREFIX)
    ? trimmed
    : Buffer.from(trimmed, "base64url").toString("utf8");
  return phc.startsWith(PHC_PREFIX) ? phc : undefined;
}
