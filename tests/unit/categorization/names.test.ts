import { describe, expect, it } from "vitest";
import {
  HouseholdInputError,
  parseHouseholdForm,
} from "@/server/categorization/household";
import {
  householdMatcher,
  nameMatches,
  normalizeName,
} from "@/server/categorization/names";

// Synthetic names and IBANs only.
const SPOUSE_IBAN = "FI49 5000 9420 0287 30";
const OTHER_IBAN = "FI21 1234 5600 0007 85";

describe("normalizeName", () => {
  it("ignores case, punctuation, repeated spaces and word order", () => {
    expect(normalizeName("MEIKÄLÄINEN MATTI")).toBe("matti meikäläinen");
    expect(normalizeName("Matti   Meikäläinen")).toBe("matti meikäläinen");
    expect(normalizeName("Meikäläinen, Matti.")).toBe("matti meikäläinen");
    expect(normalizeName("M. Meikäläinen")).toBe(
      normalizeName("M Meikäläinen"),
    );
  });

  it("keeps accents", () => {
    expect(normalizeName("Meikalainen Matti")).not.toBe(
      normalizeName("Meikäläinen Matti"),
    );
    // A decomposed ä is the same letter.
    expect(normalizeName("Meikäläinen")).toBe("meikäläinen");
  });

  it("is empty without letters or digits", () => {
    expect(normalizeName(" .,- ")).toBe("");
  });
});

describe("nameMatches", () => {
  const variants = new Set(
    ["Matti Meikäläinen", "M. Meikäläinen"].map(normalizeName),
  );

  it("matches a whole name in any order and case", () => {
    expect(nameMatches(variants, "MEIKÄLÄINEN MATTI")).toBe(true);
    expect(nameMatches(variants, "m meikäläinen")).toBe(true);
    expect(nameMatches(variants, "Meikäläinen M.")).toBe(true);
  });

  it("never matches part of a counterparty", () => {
    expect(nameMatches(variants, "Matti Meikäläinen Oy")).toBe(false);
    expect(nameMatches(variants, "Maija Meikäläinen")).toBe(false);
    expect(nameMatches(variants, "Meikäläinen")).toBe(false);
    expect(nameMatches(variants, "Matti")).toBe(false);
    expect(nameMatches(variants, null)).toBe(false);
    expect(nameMatches(variants, "")).toBe(false);
  });
});

describe("householdMatcher", () => {
  const matcher = householdMatcher({
    ownNames: ["Matti Meikäläinen"],
    members: [{ names: ["Maija Meikäläinen"], ibans: [SPOUSE_IBAN] }],
  });

  it("knows own names", () => {
    expect(
      matcher.isOwnName({
        counterparty: "MEIKÄLÄINEN MATTI",
        counterpartyIban: null,
        description: null,
      }),
    ).toBe(true);
    expect(
      matcher.isOwnName({
        counterparty: "Matti Meikäläinen",
        counterpartyIban: OTHER_IBAN,
        description: null,
      }),
    ).toBe(true);
  });

  it("knows household members by name or IBAN", () => {
    expect(
      matcher.isHousehold({
        counterparty: "meikäläinen maija",
        counterpartyIban: null,
        description: null,
      }),
    ).toBe(true);
    expect(
      matcher.isHousehold({
        counterparty: null,
        counterpartyIban: SPOUSE_IBAN.replaceAll(" ", "").toLowerCase(),
        description: null,
      }),
    ).toBe(true);
    expect(
      matcher.isHousehold({
        counterparty: "K-Market Kamppi",
        counterpartyIban: null,
        description: null,
      }),
    ).toBe(false);
  });

  it("does not make an own name from a household member's account an own transfer", () => {
    const leg = {
      counterparty: "Matti Meikäläinen",
      counterpartyIban: SPOUSE_IBAN,
      description: null,
    };
    expect(matcher.isHousehold(leg)).toBe(true);
    expect(matcher.isOwnName(leg)).toBe(false);
  });

  it("is empty without names or IBANs", () => {
    expect(householdMatcher({ ownNames: [], members: [] }).empty).toBe(true);
    expect(matcher.empty).toBe(false);
  });
});

describe("household IBANs in texts (F-036)", () => {
  const matcher = householdMatcher({
    ownNames: ["Matti Meikäläinen"],
    members: [{ names: [], ibans: ["FI4950009420028730"] }],
  });
  const leg = (
    overrides: Partial<Parameters<typeof matcher.isHousehold>[0]>,
  ) => ({
    counterparty: null,
    counterpartyIban: null,
    description: null,
    ...overrides,
  });

  it("finds a member's IBAN in the description or counterparty, with any spacing and case", () => {
    expect(
      matcher.isHousehold(leg({ description: "FI4950009420028730" })),
    ).toBe(true);
    expect(
      matcher.isHousehold(
        leg({ description: `Siirto ${SPOUSE_IBAN.toLowerCase()}` }),
      ),
    ).toBe(true);
    expect(matcher.isHousehold(leg({ counterparty: SPOUSE_IBAN }))).toBe(true);
    expect(matcher.isHousehold(leg({ description: OTHER_IBAN }))).toBe(false);
  });

  it("lets a counterparty account win over an IBAN in the texts", () => {
    expect(
      matcher.isHousehold(
        leg({ counterpartyIban: OTHER_IBAN, description: SPOUSE_IBAN }),
      ),
    ).toBe(false);
    expect(
      matcher.isHousehold(
        leg({ counterpartyIban: SPOUSE_IBAN, description: OTHER_IBAN }),
      ),
    ).toBe(true);
  });

  it("makes an own name with a member's IBAN in the texts a household row", () => {
    const own = leg({
      counterparty: "Matti Meikäläinen",
      description: SPOUSE_IBAN,
    });
    expect(matcher.isHousehold(own)).toBe(true);
    expect(matcher.isOwnName(own)).toBe(false);
    expect(
      matcher.isOwnName(
        leg({ counterparty: "Matti Meikäläinen", description: OTHER_IBAN }),
      ),
    ).toBe(true);
  });

  it("never searches the texts for an IBAN shorter than MIN_IBAN_LENGTH", () => {
    const short = householdMatcher({
      ownNames: [],
      members: [{ names: [], ibans: ["FI12"] }],
    });
    expect(short.isHousehold(leg({ description: "Viite FI12 3456" }))).toBe(
      false,
    );
    expect(short.isHousehold(leg({ counterpartyIban: "fi12" }))).toBe(true);
  });

  it("does not let an IBAN span the counterparty and the description", () => {
    expect(
      matcher.isHousehold(
        leg({ counterparty: "FI49500094", description: "20028730" }),
      ),
    ).toBe(false);
  });
});

describe("parseHouseholdForm", () => {
  it("trims, drops empty lines and duplicate variants, normalises IBANs", () => {
    expect(
      parseHouseholdForm({
        ownNames:
          "  Matti  Meikäläinen \n\nMEIKÄLÄINEN MATTI\nM. Meikäläinen\n",
        members: [
          {
            names: "Maija Meikäläinen\n",
            ibans: "fi49 5000 9420 0287 30, FI4950009420028730",
          },
          { names: " ", ibans: "" },
        ],
      }),
    ).toEqual({
      ownNames: ["Matti Meikäläinen", "M. Meikäläinen"],
      members: [
        { names: ["Maija Meikäläinen"], ibans: ["FI4950009420028730"] },
      ],
    });
  });

  it("refuses an invalid IBAN, a line without a name and a shared name", () => {
    expect(() =>
      parseHouseholdForm({
        ownNames: "",
        members: [{ names: "Maija", ibans: "FI49 5000 9420 0287 31" }],
      }),
    ).toThrow(/not a valid IBAN/);
    expect(() => parseHouseholdForm({ ownNames: "--", members: [] })).toThrow(
      HouseholdInputError,
    );
    expect(() =>
      parseHouseholdForm({
        ownNames: "Matti Meikäläinen",
        members: [{ names: "meikäläinen matti", ibans: "" }],
      }),
    ).toThrow(/both your name and a household member/);
  });
});
