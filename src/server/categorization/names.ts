import { ibanSearchText, normalizeIban, searchableIban } from "@/server/iban";

// Own names and household members (F-030), pure. A name variant matches a
// counterparty when both normalise to the same words: case, punctuation and
// repeated spaces are ignored and so is the word order, but accents are
// kept (`MEIKÄLÄINEN MATTI` = `Matti Meikäläinen`, `M. Meikäläinen` =
// `M Meikäläinen`, `Meikalainen` ≠ `Meikäläinen`). A variant matches the
// whole counterparty, never part of it, so a merchant or a relative with
// the same surname does not match. A member's IBAN matches the counterparty
// account, or, when the bank gave none, the counterparty or description
// text (F-036), searched as transfer detection searches own IBANs.

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

/** Words between two holders' names on a joint account (`&`, `/`, `+` too). */
const JOINT_CONNECTORS = new Set(["&", "ja", "och", "and", "cj"]);

/** Lower-case NFC words in order; `&`, `/` and `+` become the word `&`. */
function nameWords(value: string): string[] {
  return (
    value
      .normalize("NFC")
      .toLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+|[&/+]/gu)
      ?.map((word) => (word === "/" || word === "+" ? "&" : word)) ?? []
  );
}

/** Each word is a different one of `given`, whole or as its initial. */
function givenNamesMatch(words: string[], given: string[]): boolean {
  if (words.length === 0) return true;
  const [word, ...rest] = words;
  return given.some(
    (name, index) =>
      (word === name || (word.length === 1 && name.startsWith(word))) &&
      givenNamesMatch(
        rest,
        given.filter((_, other) => other !== index),
      ),
  );
}

/**
 * Whether `words` are `saved` with its other words shortened to initials
 * or left out: one word of `saved` (the surname; which one is not known)
 * whole, and at least one more. The same words are not a variant.
 */
function isInitialsVariant(saved: string[], words: string[]): boolean {
  if (words.length < 2) return false;
  return saved.some((surname, index) => {
    const at = words.indexOf(surname);
    if (at < 0) return false;
    return givenNamesMatch(
      words.filter((_, other) => other !== at),
      saved.filter((_, other) => other !== index),
    );
  });
}

/**
 * How `counterparty` is written from the saved names without being one of
 * them (F-035): one part, a saved name with its given names as initials or
 * left out (`M. Meikäläinen`, `MEIKÄLÄINEN M M`), or a joint-holder name of
 * two parts joined by a connector (`ja`, `och`, `and`, `CJ`, `&`, `/`,
 * `+`), each a saved name or such a variant of one. Returns, per part, the
 * saved names (as given) it fits; null when it is neither. A given name
 * that differs (`Maija Meikäläinen` for `Matti Meikäläinen`) or a word that
 * is no name of theirs (`Meikäläinen Oy`) never fits.
 */
export function nameVariantParts(
  counterparty: string,
  saved: readonly string[],
): string[][] | null {
  const savedWords = saved.map((name) => ({
    name,
    words: nameWords(name),
    normalized: normalizeName(name),
  }));
  const normalized = normalizeName(counterparty);
  if (savedWords.some((entry) => entry.normalized === normalized)) return null;

  const words = nameWords(counterparty);
  const connectors = words.filter((word) => JOINT_CONNECTORS.has(word));
  const at = words.findIndex((word) => JOINT_CONNECTORS.has(word));
  let parts: string[][];
  if (connectors.length === 0) {
    parts = [words];
  } else if (connectors.length === 1 && at > 0 && at < words.length - 1) {
    parts = [words.slice(0, at), words.slice(at + 1)];
  } else {
    return null;
  }

  const fits = parts.map((part) => {
    const partNormalized = [...part].sort().join(" ");
    return savedWords
      .filter(
        (entry) =>
          (parts.length > 1 && entry.normalized === partNormalized) ||
          isInitialsVariant(entry.words, part),
      )
      .map((entry) => entry.name);
  });
  return fits.every((names) => names.length > 0) ? fits : null;
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
  description: string | null;
}

export interface HouseholdMatcher {
  /**
   * The counterparty's name or account is a household member's; without a
   * counterparty account, also when its texts name a member's IBAN.
   */
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
  const searchable = [...memberIbans].flatMap(
    (iban) => searchableIban(iban) ?? [],
  );
  /** A counterparty account (anyone's) wins over an IBAN in the texts. */
  const memberAccount = (leg: HouseholdLeg) => {
    if (leg.counterpartyIban !== null) {
      return memberIbans.has(normalizeIban(leg.counterpartyIban));
    }
    if (searchable.length === 0) return false;
    const text = ibanSearchText(leg.counterparty, leg.description);
    return searchable.some((iban) => text.includes(iban));
  };
  const isHousehold = (leg: HouseholdLeg) =>
    nameMatches(memberNames, leg.counterparty) || memberAccount(leg);
  return {
    isHousehold,
    isOwnName: (leg) => nameMatches(own, leg.counterparty) && !isHousehold(leg),
    empty: own.size === 0 && memberNames.size === 0 && memberIbans.size === 0,
  };
}
