// Account numbers (F-014, F-028): IBANs are compared and stored normalised,
// so `FI21 1234 5600 0007 85` from a bank and `fi2112345600000785` typed by
// hand agree. A transaction's texts can name an account too (F-014, F-036):
// `ibanSearchText()` normalises them the same way, so a searchable IBAN is
// found with `includes()` whatever its spacing and case.

/** Upper-case without whitespace, so `FI12 3456` and `fi123456` agree. */
export function normalizeIban(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** IBANs shorter than this (normalised) are never searched for in texts. */
export const MIN_IBAN_LENGTH = 15;

/** `iban` normalised when it is long enough to search texts for, else null. */
export function searchableIban(iban: string | null): string | null {
  if (iban === null) return null;
  const normalized = normalizeIban(iban);
  return normalized.length >= MIN_IBAN_LENGTH ? normalized : null;
}

/**
 * A transaction's texts (counterparty, description) normalised like IBANs
 * and joined by `|`, so a searchable IBAN never spans two of them.
 */
export function ibanSearchText(...texts: (string | null)[]): string {
  return normalizeIban(texts.map((text) => text ?? "").join("|"));
}

/** Country code, two check digits, then 11–30 letters or digits. */
const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;

/**
 * `value` normalised when it is an IBAN (its shape and ISO 7064 mod-97
 * check digits), else null: a card's masked number, a reference or a name.
 */
export function parseIban(value: string | null | undefined): string | null {
  if (!value) return null;
  const iban = normalizeIban(value);
  if (!IBAN_SHAPE.test(iban)) return null;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1 ? iban : null;
}
