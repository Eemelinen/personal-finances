import type { ProviderAccount } from "@/server/providers/types";

// Which stored account a renewed session's account is (F-011). A renewal
// gives a new provider session whose account ids may differ from the old
// one's (Enable Banking's `uid` is per session), so an account is matched
// by its IBAN first and only then by the provider account id. An id match
// is refused when both sides have an IBAN and they differ: that is another
// account that happens to reuse the id. Each stored account is matched at
// most once; renewed accounts without a match are new accounts.

/** The fields of a stored account the matching reads. */
export interface StoredAccount {
  id: string;
  iban: string | null;
  providerAccountRef: string | null;
}

export interface AccountMatch<T extends ProviderAccount = ProviderAccount> {
  account: T;
  /** The stored account it continues; null for a new account. */
  existingId: string | null;
  matchedBy: "iban" | "ref" | null;
}

/** An IBAN without spaces, upper case; null when empty. */
export function normalizeIban(iban: string | null): string | null {
  const normalized = iban?.replace(/\s+/g, "").toUpperCase() ?? "";
  return normalized === "" ? null : normalized;
}

/**
 * Pairs each renewed account with the stored account it continues, in the
 * renewed accounts' order: by IBAN, then by provider account id.
 */
export function matchRenewedAccounts<T extends ProviderAccount>(
  stored: readonly StoredAccount[],
  renewed: readonly T[],
): AccountMatch<T>[] {
  const used = new Set<string>();
  const matches: AccountMatch<T>[] = renewed.map((account) => ({
    account,
    existingId: null,
    matchedBy: null,
  }));

  for (const match of matches) {
    const iban = normalizeIban(match.account.iban);
    if (iban === null) continue;
    const found = stored.find(
      (candidate) =>
        !used.has(candidate.id) && normalizeIban(candidate.iban) === iban,
    );
    if (!found) continue;
    used.add(found.id);
    match.existingId = found.id;
    match.matchedBy = "iban";
  }

  for (const match of matches) {
    if (match.existingId !== null) continue;
    const iban = normalizeIban(match.account.iban);
    const found = stored.find((candidate) => {
      if (used.has(candidate.id)) return false;
      if (candidate.providerAccountRef !== match.account.ref) return false;
      const storedIban = normalizeIban(candidate.iban);
      return iban === null || storedIban === null || storedIban === iban;
    });
    if (!found) continue;
    used.add(found.id);
    match.existingId = found.id;
    match.matchedBy = "ref";
  }

  return matches;
}
