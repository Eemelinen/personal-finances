import { parseIban } from "@/server/iban";
import type { IsoDate } from "@/server/providers/types";

// What the user may set on a bank account (F-007) and on an own account
// outside the connections (F-029). Only pure imports: the /connections and
// /settings/accounts client components use these too.

export type BankAccountType = "checking" | "savings";

export const BANK_ACCOUNT_TYPES: readonly BankAccountType[] = [
  "checking",
  "savings",
];

export const MAX_ACCOUNT_NAME_LENGTH = 100;

export const MAX_INSTITUTION_NAME_LENGTH = 100;

/** A field the user typed is missing or malformed; the message says which. */
export class AccountInputError extends Error {
  override readonly name = "AccountInputError";
}

export interface OwnAccountFields {
  name: string;
  /**
   * Normalised (upper case, no spaces) and mod-97 checked. Null only when
   * an edit leaves it empty (a CSV import's account whose IBAN is unknown).
   */
  iban: string | null;
  type: BankAccountType;
}

export interface ManualBalance {
  amountMinor: number;
  date: IsoDate;
}

export interface NewOwnAccount extends OwnAccountFields {
  /** Required when adding: the IBAN is what marks own transfers. */
  iban: string;
  institution: string;
  /** "Balance on date", when given. */
  balance: ManualBalance | null;
}

export interface OwnAccountEdit extends OwnAccountFields {
  balance: ManualBalance | null;
}

type RawFields = Record<string, unknown>;

function text(raw: RawFields, key: string): string {
  const value = raw[key];
  return typeof value === "string" ? value.trim() : "";
}

function limited(
  value: string,
  max: number,
  messages: { missing: string; what: string },
): string {
  if (value === "") throw new AccountInputError(messages.missing);
  if (value.length > max) {
    throw new AccountInputError(
      `Keep the ${messages.what} under ${max + 1} characters.`,
    );
  }
  return value;
}

/**
 * Name, IBAN and type: what both adding and editing an own account set.
 * An empty IBAN is null, or refused when `ibanRequired`.
 */
export function parseOwnAccountFields(
  raw: RawFields,
  { ibanRequired }: { ibanRequired: boolean },
): OwnAccountFields {
  const name = limited(text(raw, "name"), MAX_ACCOUNT_NAME_LENGTH, {
    missing: "Give the account a name.",
    what: "name",
  });
  const typed = text(raw, "iban");
  if (typed === "" && ibanRequired) {
    throw new AccountInputError("Give the account's IBAN.");
  }
  const iban = typed === "" ? null : parseIban(typed);
  if (typed !== "" && iban === null) {
    throw new AccountInputError(
      "That is not a valid IBAN: check the country code, the check digits and the number.",
    );
  }
  const type = BANK_ACCOUNT_TYPES.find((value) => value === text(raw, "type"));
  if (!type) throw new AccountInputError("Choose checking or savings.");
  return { name, iban, type };
}

/** A hand-typed balance: `1 234,56`, `-12.5`, `100 €`; at most two decimals. */
const BALANCE = /^([+\-−]?)(\d+)(?:[.,](\d{1,2}))?$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The optional "Balance on date": both fields or neither. The date is a
 * `YYYY-MM-DD` (what `<input type="date">` sends) that exists and is not
 * after `today`, so the balance counts from that day on.
 */
export function parseManualBalance(
  raw: RawFields,
  today: IsoDate,
): ManualBalance | null {
  const amount = text(raw, "balance");
  const date = text(raw, "balanceDate");
  if (amount === "" && date === "") return null;
  if (amount === "") throw new AccountInputError("Give the balance.");
  if (date === "") {
    throw new AccountInputError("Give the date of the balance.");
  }

  const match = BALANCE.exec(amount.replace(/[\s  ]/g, "").replace(/€$/, ""));
  if (!match) {
    throw new AccountInputError(
      "Write the balance as a number, such as 1 234,56.",
    );
  }
  const [, sign, integer, fraction = ""] = match;
  const minor = Number(integer) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) {
    throw new AccountInputError("The balance is too large.");
  }
  const amountMinor =
    sign === "" || sign === "+" || minor === 0 ? minor : -minor;

  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !ISO_DAY.test(date) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new AccountInputError("Give the balance's date as a calendar day.");
  }
  if (date > today) {
    throw new AccountInputError("The balance's date cannot be in the future.");
  }
  return { amountMinor, date };
}

/** The add form: institution, name, IBAN, type and an optional balance. */
export function parseNewOwnAccount(
  raw: RawFields,
  today: IsoDate,
): NewOwnAccount {
  const fields = parseOwnAccountFields(raw, { ibanRequired: true });
  const institution = limited(
    text(raw, "institution"),
    MAX_INSTITUTION_NAME_LENGTH,
    { missing: "Give the bank's name.", what: "bank's name" },
  );
  return {
    ...fields,
    iban: fields.iban!,
    institution,
    balance: parseManualBalance(raw, today),
  };
}

/**
 * The edit form: name, IBAN (may be emptied), type and an optional new
 * balance.
 */
export function parseOwnAccountEdit(
  raw: RawFields,
  today: IsoDate,
): OwnAccountEdit {
  return {
    ...parseOwnAccountFields(raw, { ibanRequired: false }),
    balance: parseManualBalance(raw, today),
  };
}
