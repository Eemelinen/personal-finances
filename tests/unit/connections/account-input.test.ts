import { describe, expect, it } from "vitest";
import {
  AccountInputError,
  MAX_ACCOUNT_NAME_LENGTH,
  parseManualBalance,
  parseNewOwnAccount,
  parseOwnAccountEdit,
} from "@/server/connections/account-input";

// Settings → Accounts (F-029): what the add and edit forms accept. The IBAN
// is checked (country code, check digits, mod-97) and normalised, so the
// transfer detection compares it with the counterparty IBANs as stored.

const TODAY = "2026-10-24";

/** A valid synthetic Finnish IBAN (the standard's example). */
const IBAN = "FI2112345600000785";

const VALID = {
  institution: "Other bank",
  name: "Savings",
  iban: "fi21 1234 5600 0007 85",
  type: "savings",
  balance: "",
  balanceDate: "",
};

function expectError(run: () => unknown, message: RegExp) {
  expect(run).toThrow(AccountInputError);
  expect(run).toThrow(message);
}

describe("parseNewOwnAccount", () => {
  it("normalises the IBAN and trims the texts", () => {
    expect(
      parseNewOwnAccount(
        { ...VALID, institution: "  Other bank ", name: " Savings  " },
        TODAY,
      ),
    ).toEqual({
      institution: "Other bank",
      name: "Savings",
      iban: IBAN,
      type: "savings",
      balance: null,
    });
  });

  it("refuses an IBAN with wrong check digits, shape or country code", () => {
    for (const iban of [
      "FI2112345600000786",
      "FI21 1234",
      "1234123456000007",
      "Savings account",
    ]) {
      expectError(
        () => parseNewOwnAccount({ ...VALID, iban }, TODAY),
        /not a valid IBAN/,
      );
    }
  });

  it("accepts IBANs of other countries", () => {
    expect(
      parseNewOwnAccount(
        { ...VALID, iban: "DE89 3704 0044 0532 0130 00" },
        TODAY,
      ).iban,
    ).toBe("DE89370400440532013000");
  });

  it("requires the bank, the name, the IBAN and the type", () => {
    expectError(
      () => parseNewOwnAccount({ ...VALID, institution: " " }, TODAY),
      /bank's name/,
    );
    expectError(
      () => parseNewOwnAccount({ ...VALID, name: "" }, TODAY),
      /name/,
    );
    expectError(
      () => parseNewOwnAccount({ ...VALID, iban: "" }, TODAY),
      /IBAN/,
    );
    expectError(
      () => parseNewOwnAccount({ ...VALID, type: "brokerage" }, TODAY),
      /checking or savings/,
    );
    expectError(
      () => parseNewOwnAccount({ institution: "Bank" }, TODAY),
      /name/,
    );
  });

  it("refuses a name that is too long", () => {
    expectError(
      () =>
        parseNewOwnAccount(
          { ...VALID, name: "x".repeat(MAX_ACCOUNT_NAME_LENGTH + 1) },
          TODAY,
        ),
      /under 101 characters/,
    );
  });

  it("reads the optional balance on a date", () => {
    expect(
      parseNewOwnAccount(
        { ...VALID, balance: "12 345,60", balanceDate: "2026-10-01" },
        TODAY,
      ).balance,
    ).toEqual({ amountMinor: 1_234_560, date: "2026-10-01" });
  });
});

describe("parseOwnAccountEdit", () => {
  it("keeps an emptied IBAN as none", () => {
    expect(parseOwnAccountEdit({ ...VALID, iban: " " }, TODAY)).toEqual({
      name: "Savings",
      iban: null,
      type: "savings",
      balance: null,
    });
  });

  it("still refuses an invalid IBAN", () => {
    expectError(
      () => parseOwnAccountEdit({ ...VALID, iban: "FI00 1234" }, TODAY),
      /not a valid IBAN/,
    );
  });
});

describe("parseManualBalance", () => {
  const balance = (amount: string, date = "2026-10-24") =>
    parseManualBalance({ balance: amount, balanceDate: date }, TODAY);

  it("reads Finnish and plain amounts with a sign", () => {
    expect(balance("1 234,56")?.amountMinor).toBe(123_456);
    expect(balance("1234.5")?.amountMinor).toBe(123_450);
    expect(balance("-12,05 €")?.amountMinor).toBe(-1_205);
    expect(balance("−7")?.amountMinor).toBe(-700);
    expect(balance("+0,00")?.amountMinor).toBe(0);
    expect(balance("-0")?.amountMinor).toBe(0);
  });

  it("is none when both fields are empty", () => {
    expect(parseManualBalance({ balance: " ", balanceDate: "" }, TODAY)).toBe(
      null,
    );
    expect(parseManualBalance({}, TODAY)).toBe(null);
  });

  it("needs both the amount and the date", () => {
    expectError(
      () => parseManualBalance({ balance: "10" }, TODAY),
      /date of the balance/,
    );
    expectError(
      () => parseManualBalance({ balanceDate: TODAY }, TODAY),
      /Give the balance/,
    );
  });

  it("refuses malformed amounts", () => {
    for (const amount of ["12,345", "1.234,56", "abc", "1e5", "--1"]) {
      expectError(() => balance(amount), /as a number/);
    }
  });

  it("refuses days that do not exist and future days", () => {
    expectError(() => balance("1", "2026-02-30"), /calendar day/);
    expectError(() => balance("1", "24.10.2026"), /calendar day/);
    expectError(() => balance("1", "2026-10-25"), /future/);
  });
});
