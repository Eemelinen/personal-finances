import { hash, verify } from "@node-rs/argon2";

/** Hashes a password with argon2id (the library's OWASP-baseline defaults). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** Whether `password` matches the PHC hash; false (never a throw) on a malformed hash. */
export async function verifyPassword(
  phc: string,
  password: string,
): Promise<boolean> {
  if (password.length === 0) return false;
  try {
    return await verify(phc, password);
  } catch {
    return false;
  }
}
