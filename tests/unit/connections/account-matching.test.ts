import { describe, expect, it } from "vitest";
import {
  matchRenewedAccounts,
  normalizeIban,
  type StoredAccount,
} from "@/server/connections/account-matching";
import type { ProviderAccount } from "@/server/providers/types";

// Renewal (F-011): a renewed session's accounts continue the stored ones,
// matched by IBAN first, then by the provider account id.

function renewed(ref: string, iban: string | null): ProviderAccount {
  return {
    ref,
    iban,
    name: `Account ${ref}`,
    type: "checking",
    currency: "EUR",
  };
}

function stored(
  id: string,
  iban: string | null,
  providerAccountRef: string | null,
): StoredAccount {
  return { id, iban, providerAccountRef };
}

function pairs(matches: ReturnType<typeof matchRenewedAccounts>) {
  return matches.map((match) => [
    match.account.ref,
    match.existingId,
    match.matchedBy,
  ]);
}

describe("normalizeIban", () => {
  it("drops spaces and ignores case", () => {
    expect(normalizeIban("fi21 1234 5600 0007 85")).toBe("FI2112345600000785");
    expect(normalizeIban("  ")).toBeNull();
    expect(normalizeIban(null)).toBeNull();
  });
});

describe("matchRenewedAccounts", () => {
  it("matches by IBAN even when the provider ids changed", () => {
    const matches = matchRenewedAccounts(
      [stored("a1", "FI00 0000 0000 0000 01", "old-uid-1")],
      [renewed("new-uid-1", "FI0000000000000001")],
    );
    expect(pairs(matches)).toEqual([["new-uid-1", "a1", "iban"]]);
  });

  it("prefers the IBAN over a provider id that points at another account", () => {
    const matches = matchRenewedAccounts(
      [
        stored("a1", "FI00 0000 0000 0000 01", "uid-2"),
        stored("a2", "FI00 0000 0000 0000 02", "uid-1"),
      ],
      [
        renewed("uid-1", "FI00 0000 0000 0000 01"),
        renewed("uid-2", "FI00 0000 0000 0000 02"),
      ],
    );
    expect(pairs(matches)).toEqual([
      ["uid-1", "a1", "iban"],
      ["uid-2", "a2", "iban"],
    ]);
  });

  it("falls back to the provider id when an IBAN is missing", () => {
    const matches = matchRenewedAccounts(
      [stored("card", null, "card-uid"), stored("a1", "FI01", "uid-1")],
      [renewed("card-uid", null), renewed("uid-1", null)],
    );
    expect(pairs(matches)).toEqual([
      ["card-uid", "card", "ref"],
      ["uid-1", "a1", "ref"],
    ]);
  });

  it("does not match a provider id whose IBAN differs", () => {
    const matches = matchRenewedAccounts(
      [stored("a1", "FI00 0000 0000 0000 01", "uid-1")],
      [renewed("uid-1", "FI00 0000 0000 0000 09")],
    );
    expect(pairs(matches)).toEqual([["uid-1", null, null]]);
  });

  it("uses each stored account once and leaves new accounts unmatched", () => {
    const matches = matchRenewedAccounts(
      [stored("a1", "FI01", "uid-1")],
      [
        renewed("uid-1", "FI01"),
        renewed("uid-x", "FI01"),
        renewed("uid-3", "FI03"),
      ],
    );
    expect(pairs(matches)).toEqual([
      ["uid-1", "a1", "iban"],
      ["uid-x", null, null],
      ["uid-3", null, null],
    ]);
  });

  it("an IBAN match wins over an earlier account's provider id match", () => {
    // The second renewed account has a1's IBAN; the first only its old id.
    const matches = matchRenewedAccounts(
      [stored("a1", "FI01", "uid-1")],
      [renewed("uid-1", null), renewed("uid-9", "FI01")],
    );
    expect(pairs(matches)).toEqual([
      ["uid-1", null, null],
      ["uid-9", "a1", "iban"],
    ]);
  });

  it("matches nothing when nothing is stored", () => {
    expect(pairs(matchRenewedAccounts([], [renewed("uid-1", "FI01")]))).toEqual(
      [["uid-1", null, null]],
    );
  });
});
