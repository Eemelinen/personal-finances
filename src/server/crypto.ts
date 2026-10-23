import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEncryptionEnv } from "@/server/env";

// Encrypts secrets stored in the database (provider session ids in
// `connections.session_ref`) with AES-256-GCM under `ENCRYPTION_KEY`.
//
// Format: `v1:<iv>:<ciphertext>:<tag>`, each part base64url, with a fresh
// 12-byte IV per value and a 16-byte tag. The version prefix is authenticated
// too (additional data), so a later format or key rotation can introduce `v2`
// while `v1` values still decrypt.

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Malformed, tampered with, or encrypted under a different key. */
export class DecryptionError extends Error {
  override readonly name = "DecryptionError";
}

function checkKey(key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new TypeError(`The encryption key must be ${KEY_BYTES} bytes`);
  }
  return key;
}

// Only the canonical encoding is accepted, so a value has one spelling.
function decodePart(part: string, bytes?: number): Buffer {
  const decoded = BASE64URL.test(part)
    ? Buffer.from(part, "base64url")
    : undefined;
  if (
    decoded?.toString("base64url") !== part ||
    (bytes !== undefined && decoded.length !== bytes)
  ) {
    throw new DecryptionError("Malformed ciphertext");
  }
  return decoded;
}

export function encryptSecret(
  plaintext: string,
  key: Buffer = getEncryptionEnv().ENCRYPTION_KEY,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, checkKey(key), iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(VERSION));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [VERSION, iv, ciphertext, cipher.getAuthTag()]
    .map((part) =>
      typeof part === "string" ? part : part.toString("base64url"),
    )
    .join(":");
}

/** Throws `DecryptionError` unless `value` came from `encryptSecret()` with `key`. */
export function decryptSecret(
  value: string,
  key: Buffer = getEncryptionEnv().ENCRYPTION_KEY,
): string {
  const parts = value.split(":");
  if (parts.length !== 4) throw new DecryptionError("Malformed ciphertext");
  const [version, ivPart, ciphertextPart, tagPart] = parts;
  if (version !== VERSION) {
    throw new DecryptionError(
      `Unsupported ciphertext version ${JSON.stringify(version)}`,
    );
  }
  const iv = decodePart(ivPart, IV_BYTES);
  const ciphertext = decodePart(ciphertextPart);
  const tag = decodePart(tagPart, TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, checkKey(key), iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(VERSION));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new DecryptionError(
      "Ciphertext was tampered with or the key is wrong",
      { cause: error },
    );
  }
}
