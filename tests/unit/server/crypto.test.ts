import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DecryptionError, decryptSecret, encryptSecret } from "@/server/crypto";
import { parseEncryptionEnv } from "@/server/env";

const key = randomBytes(32);
const SESSION_ID = "4d1b6c8e-1f0a-4b7e-9a51-0c2d3e4f5a6b";

/** Flips one bit in the decoded bytes of part `index` of a ciphertext. */
function flipBit(value: string, index: number): string {
  const parts = value.split(":");
  const bytes = Buffer.from(parts[index], "base64url");
  bytes[0] ^= 1;
  parts[index] = bytes.toString("base64url");
  return parts.join(":");
}

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a session id, including unicode and empty strings", () => {
    for (const plaintext of [SESSION_ID, "äö € 🏦", ""]) {
      expect(decryptSecret(encryptSecret(plaintext, key), key)).toBe(plaintext);
    }
  });

  it("writes a versioned format with a fresh IV every time", () => {
    const first = encryptSecret(SESSION_ID, key);
    const second = encryptSecret(SESSION_ID, key);

    expect(first).toMatch(/^v1:[\w-]{16}:[\w-]+:[\w-]{22}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(SESSION_ID);
  });

  it.each([
    ["the IV", 1],
    ["the ciphertext", 2],
    ["the tag", 3],
  ])("rejects a ciphertext with a modified %s", (_, index) => {
    const tampered = flipBit(encryptSecret(SESSION_ID, key), index);

    expect(() => decryptSecret(tampered, key)).toThrow(DecryptionError);
  });

  it("rejects a ciphertext whose version prefix was changed", () => {
    const value = encryptSecret(SESSION_ID, key);

    expect(() => decryptSecret(value.replace(/^v1/, "v2"), key)).toThrow(
      /Unsupported ciphertext version "v2"/,
    );
  });

  it("rejects the wrong key", () => {
    const value = encryptSecret(SESSION_ID, key);

    expect(() => decryptSecret(value, randomBytes(32))).toThrow(
      /tampered with or the key is wrong/,
    );
  });

  it.each(["", SESSION_ID, "v1:abc", "v1:a:b:c:d", "v1:!!!:abc:def"])(
    "rejects malformed input %j",
    (value) => {
      expect(() => decryptSecret(value, key)).toThrow(DecryptionError);
    },
  );

  it("rejects a truncated tag and non-canonical base64url", () => {
    const [version, iv, ciphertext, tag] = encryptSecret(SESSION_ID, key).split(
      ":",
    );

    expect(() =>
      decryptSecret([version, iv, ciphertext, tag.slice(0, 11)].join(":"), key),
    ).toThrow(/Malformed/);
    // 22 characters carry 132 bits for a 128-bit tag; changing the unused
    // low bits would decode to the same bytes and must still be refused.
    const last = tag.at(-1)!;
    expect("AQgw").toContain(last);
    const alias = String.fromCharCode(last.charCodeAt(0) + 1);
    const respelled = [version, iv, ciphertext, tag.slice(0, -1) + alias].join(
      ":",
    );
    expect(() => decryptSecret(respelled, key)).toThrow(DecryptionError);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => encryptSecret(SESSION_ID, randomBytes(16))).toThrow(
      /must be 32 bytes/,
    );
  });
});

describe("parseEncryptionEnv", () => {
  it("decodes a base64 key", () => {
    const env = parseEncryptionEnv({ ENCRYPTION_KEY: key.toString("base64") });

    expect(env.ENCRYPTION_KEY.equals(key)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "short",
    randomBytes(16).toString("base64"),
    "x".repeat(44),
  ])("rejects %j", (value) => {
    expect(() => parseEncryptionEnv({ ENCRYPTION_KEY: value })).toThrow(
      /ENCRYPTION_KEY/,
    );
  });
});
