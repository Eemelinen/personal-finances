import { describe, expect, it } from "vitest";
import {
  moveRuleIds,
  parseRuleInput,
} from "@/server/categorization/rule-input";
import { regexError } from "@/server/categorization/rules";

const CATEGORY = "0b6f6a3e-6a0f-4c55-9a59-4f3d3b8c1a01";

const fields = {
  categoryId: CATEGORY,
  matchField: "counterparty",
  matchType: "contains",
  pattern: "  K-Market  ",
  amountSign: "",
  amountMin: "",
  amountMax: "",
};

describe("parseRuleInput", () => {
  it("accepts a plain rule and trims the pattern", () => {
    expect(parseRuleInput(fields)).toEqual({
      ok: true,
      rule: {
        categoryId: CATEGORY,
        matchField: "counterparty",
        matchType: "contains",
        pattern: "K-Market",
        amountSign: null,
        amountMinMinor: null,
        amountMaxMinor: null,
      },
    });
  });

  it("reads the sign and euro bounds as minor units", () => {
    const result = parseRuleInput({
      ...fields,
      amountSign: "debit",
      amountMin: "10",
      amountMax: "1 234,50",
    });
    expect(result).toMatchObject({
      ok: true,
      rule: {
        amountSign: "debit",
        amountMinMinor: 1_000,
        amountMaxMinor: 123_450,
      },
    });
    expect(parseRuleInput({ ...fields, amountMin: "12.5" })).toMatchObject({
      rule: { amountMinMinor: 1_250 },
    });
  });

  it("rejects a regex that does not compile, with the reason", () => {
    const result = parseRuleInput({
      ...fields,
      matchType: "regex",
      pattern: "(unclosed",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/^Invalid regular expression: /);
    expect(
      parseRuleInput({ ...fields, matchType: "regex", pattern: "\\bVR\\b" }).ok,
    ).toBe(true);
    // The same text is fine for contains, which has no syntax.
    expect(parseRuleInput({ ...fields, pattern: "(unclosed" }).ok).toBe(true);
  });

  it.each([
    [{ pattern: "   " }, "Enter the text to match."],
    [
      { pattern: "x".repeat(201) },
      "The pattern is longer than 200 characters.",
    ],
    [{ categoryId: "" }, "Choose a category."],
    [{ matchField: "amount" }, "Choose the field to match."],
    [{ matchType: "glob" }, "Choose how to match."],
    [{ amountMin: "ten" }, "The minimum amount is not a number of euros."],
    [{ amountMax: "-5" }, "The maximum amount must not be negative."],
    [
      { amountMin: "50", amountMax: "10" },
      "The minimum amount is larger than the maximum.",
    ],
  ])("rejects %o", (overrides, error) => {
    expect(parseRuleInput({ ...fields, ...overrides })).toEqual({
      ok: false,
      error,
    });
  });
});

describe("regexError", () => {
  it("is null for a valid pattern and the message otherwise", () => {
    expect(regexError("^a+$")).toBeNull();
    expect(regexError("[")).toEqual(expect.any(String));
  });
});

describe("moveRuleIds", () => {
  const ids = ["a", "b", "c", "d"];

  it("moves a rule before or after another", () => {
    expect(moveRuleIds(ids, "d", "b", "before")).toEqual(["a", "d", "b", "c"]);
    expect(moveRuleIds(ids, "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
    expect(moveRuleIds(ids, "b", "a", "before")).toEqual(["b", "a", "c", "d"]);
    expect(moveRuleIds(ids, "c", "d", "after")).toEqual(["a", "b", "d", "c"]);
  });

  it("moves past rules in between (another category's, hidden)", () => {
    // Visible a, d: "move d up" places it before a, over b and c.
    expect(moveRuleIds(ids, "d", "a", "before")).toEqual(["d", "a", "b", "c"]);
  });

  it("changes nothing for unknown or equal ids", () => {
    expect(moveRuleIds(ids, "x", "a", "before")).toEqual(ids);
    expect(moveRuleIds(ids, "a", "x", "after")).toEqual(ids);
    expect(moveRuleIds(ids, "b", "b", "after")).toEqual(ids);
  });
});
