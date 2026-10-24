import { normalizeIban } from "@/server/iban";

// Own names and household members (F-030), pure. A name variant matches a
// counterparty when both normalise to the same words: case, punctuation and
// repeated spaces are ignored and so is the word order, but accents are
// kept (`MEIKÄLÄINEN MATTI` = `Matti Meikäläinen`, `M. Meikäläinen` =
// `M Meikäläinen`, `Meikalainen` ≠ `Meikäläinen`). A variant matches the
// whole counterparty, never part of it, so a merchant or a relative with
// the same surname does not match.

/**
 * The name's words in lower case, without punctuation, sorted and joined
 * by one space; empty when it has no letters or digits.
 */
export function normalizeName(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .sort()
    .join(" ");
}

/** Whether `name` is one of `variants` (all normalised). */
export function nameMatches(
  variants: ReadonlySet<string>,
  name: string | null,
): boolean {
  if (name === null) return false;
  const normalized = normalizeName(name);
  return normalized.length > 0 && variants.has(normalized);
}

export interface HouseholdMember {
  /** Name variants as the user typed them. */
  names: string[];
  /** Account numbers, normalised. */
  ibans: string[];
}

export interface HouseholdNames {
  /** The user's own name variants as typed. */
  ownNames: readonly string[];
  members: readonly HouseholdMember[];
}

export interface HouseholdLeg {
  counterparty: string | null;
  counterpartyIban: string | null;
}

export interface HouseholdMatcher {
  /** The counterparty's name or account is a household member's. */
  isHousehold(leg: HouseholdLeg): boolean;
  /**
   * The counterparty is one of the own names and not a household member
   * (by name or account): money moved from or to the user's own account.
   */
  isOwnName(leg: HouseholdLeg): boolean;
  /** No names and no accounts: nothing can match. */
  empty: boolean;
}

function normalizedSet(names: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const name of names) {
    const normalized = normalizeName(name);
    if (normalized.length > 0) set.add(normalized);
  }
  return set;
}

export function householdMatcher(names: HouseholdNames): HouseholdMatcher {
  const own = normalizedSet(names.ownNames);
  const memberNames = normalizedSet(
    names.members.flatMap((member) => member.names),
  );
  const memberIbans = new Set(
    names.members.flatMap((member) => member.ibans.map(normalizeIban)),
  );
  const isHousehold = (leg: HouseholdLeg) =>
    nameMatches(memberNames, leg.counterparty) ||
    (leg.counterpartyIban !== null &&
      memberIbans.has(normalizeIban(leg.counterpartyIban)));
  return {
    isHousehold,
    isOwnName: (leg) => nameMatches(own, leg.counterparty) && !isHousehold(leg),
    empty: own.size === 0 && memberNames.size === 0 && memberIbans.size === 0,
  };
}
