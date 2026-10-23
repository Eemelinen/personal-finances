import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_RULES,
  TRANSFERS_CATEGORY,
  UNCATEGORIZED_CATEGORY,
} from "@/server/categorization/defaults";
import {
  compileRules,
  matchRule,
  normalizeText,
  type CategoryRule,
  type RuleSubject,
} from "@/server/categorization/rules";

let nextId = 0;
const CREATED = new Date("2026-01-01T00:00:00Z");

function rule(overrides: Partial<CategoryRule>): CategoryRule {
  nextId++;
  return {
    id: `rule-${String(nextId).padStart(3, "0")}`,
    categoryId: `category-${nextId}`,
    matchField: "counterparty",
    matchType: "contains",
    pattern: "x",
    priority: 100,
    amountSign: null,
    amountMinMinor: null,
    amountMaxMinor: null,
    createdAt: CREATED,
    ...overrides,
  };
}

function subject(overrides: Partial<RuleSubject> = {}): RuleSubject {
  return {
    amountMinor: -1_250,
    counterparty: "S-Market Kamppi",
    description: "Korttiosto",
    ...overrides,
  };
}

function first(rules: CategoryRule[], txn: RuleSubject) {
  return matchRule(compileRules(rules), txn);
}

describe("match types", () => {
  it("contains: case-insensitive, whitespace collapsed", () => {
    const smarket = rule({ pattern: "s-market" });
    expect(first([smarket], subject())).toBe(smarket);
    expect(
      first(
        [rule({ pattern: "S-Market  Kamppi" })],
        subject({ counterparty: " s-market\tkamppi " }),
      ),
    ).not.toBeNull();
    expect(first([rule({ pattern: "Prisma" })], subject())).toBeNull();
  });

  it("equals: the whole normalised text, nothing more", () => {
    expect(
      first(
        [rule({ matchType: "equals", pattern: "s-market kamppi" })],
        subject(),
      ),
    ).not.toBeNull();
    expect(
      first([rule({ matchType: "equals", pattern: "S-Market" })], subject()),
    ).toBeNull();
  });

  it("regex: case-insensitive, on the raw text", () => {
    const vr = rule({ matchType: "regex", pattern: "\\bVR\\b" });
    expect(first([vr], subject({ counterparty: "VR-Yhtymä Oyj" }))).toBe(vr);
    expect(first([vr], subject({ counterparty: "vr mobiili" }))).toBe(vr);
    expect(first([vr], subject({ counterparty: "Silvr Oy" }))).toBeNull();
    expect(
      first(
        [rule({ matchType: "regex", pattern: "^k-(market|supermarket)" })],
        subject({ counterparty: "K-Supermarket Mankkaa" }),
      ),
    ).not.toBeNull();
  });

  it("an invalid regex never matches and does not stop later rules", () => {
    const broken = rule({
      matchType: "regex",
      pattern: "(unclosed",
      priority: 1,
    });
    const fallback = rule({ pattern: "market", priority: 2 });
    expect(first([broken, fallback], subject())).toBe(fallback);
  });

  it("matches the field it names; an empty or missing field never matches", () => {
    const onDescription = rule({
      matchField: "description",
      pattern: "korttiosto",
    });
    expect(first([onDescription], subject())).toBe(onDescription);
    expect(first([rule({ pattern: "korttiosto" })], subject())).toBeNull();
    expect(
      first([rule({ pattern: "a" })], subject({ counterparty: null })),
    ).toBeNull();
    expect(
      first(
        [rule({ matchType: "regex", pattern: ".*" })],
        subject({ counterparty: "" }),
      ),
    ).toBeNull();
    expect(first([rule({ pattern: "   " })], subject())).toBeNull();
  });

  it("amount sign and inclusive range on the absolute amount", () => {
    const salary = rule({
      matchField: "description",
      pattern: "palkka",
      amountSign: "credit",
    });
    expect(
      first([salary], subject({ amountMinor: 350_000, description: "Palkka" })),
    ).toBe(salary);
    expect(
      first(
        [salary],
        subject({ amountMinor: -350_000, description: "Palkka" }),
      ),
    ).toBeNull();
    expect(
      first([rule({ pattern: "market", amountSign: "debit" })], subject()),
    ).not.toBeNull();
    expect(
      first(
        [rule({ pattern: "market", amountSign: "debit" })],
        subject({ amountMinor: 1_250 }),
      ),
    ).toBeNull();

    const range = rule({
      pattern: "market",
      amountMinMinor: 1_000,
      amountMaxMinor: 1_250,
    });
    expect(first([range], subject({ amountMinor: -1_250 }))).toBe(range);
    expect(first([range], subject({ amountMinor: 1_000 }))).toBe(range);
    expect(first([range], subject({ amountMinor: -999 }))).toBeNull();
    expect(first([range], subject({ amountMinor: -1_251 }))).toBeNull();
    expect(
      first([rule({ pattern: "market", amountMinMinor: 5_000 })], subject()),
    ).toBeNull();
  });
});

describe("priority", () => {
  it("lower priority runs first and the first match wins", () => {
    const generic = rule({ pattern: "market", priority: 200 });
    const specific = rule({ pattern: "s-market", priority: 50 });
    expect(first([generic, specific], subject())).toBe(specific);
  });

  it("equal priorities: the older rule, then the id", () => {
    const newer = rule({
      pattern: "market",
      createdAt: new Date("2026-02-01"),
    });
    const older = rule({
      pattern: "s-market",
      createdAt: new Date("2025-12-01"),
    });
    expect(first([newer, older], subject())).toBe(older);

    const b = rule({ id: "b", pattern: "market" });
    const a = rule({ id: "a", pattern: "kamppi" });
    expect(first([b, a], subject())).toBe(a);
  });

  it("a rule that does not match the amount lets the next one win", () => {
    const refund = rule({
      pattern: "market",
      amountSign: "credit",
      priority: 1,
    });
    const purchase = rule({ pattern: "market", priority: 2 });
    expect(first([refund, purchase], subject())).toBe(purchase);
  });

  it("no rules, no match", () => {
    expect(first([], subject())).toBeNull();
  });
});

describe("normalizeText", () => {
  it("lower-cases, trims and collapses whitespace", () => {
    expect(normalizeText("  K-MARKET  Töölö\n")).toBe("k-market töölö");
  });
});

describe("seeded defaults", () => {
  const paths = new Set(
    DEFAULT_CATEGORIES.flatMap((category) => [
      category.name,
      ...category.children.map((child) => `${category.name}/${child}`),
    ]),
  );
  const seeded = compileRules(
    DEFAULT_RULES.map((seed, index) =>
      rule({
        id: `seed-${String(index).padStart(3, "0")}`,
        categoryId: seed.category,
        matchField: seed.matchField,
        matchType: seed.matchType,
        pattern: seed.pattern,
        amountSign: seed.amountSign ?? null,
        priority: 100 + index * 10,
      }),
    ),
  );
  const categoryOf = (txn: Partial<RuleSubject>) =>
    matchRule(seeded, subject({ description: "Korttiosto", ...txn }))
      ?.categoryId ?? null;

  it("has the two-level categories the ticket lists", () => {
    expect(DEFAULT_CATEGORIES.map((category) => category.name)).toEqual([
      "Housing",
      "Groceries",
      "Restaurants & cafés",
      "Transport",
      "Shopping",
      "Health",
      "Subscriptions",
      "Travel",
      "Entertainment",
      "Income",
      "Savings & investments",
      TRANSFERS_CATEGORY,
      UNCATEGORIZED_CATEGORY,
    ]);
    expect(
      DEFAULT_CATEGORIES.filter((category) => category.children.length > 0)
        .length,
    ).toBeGreaterThanOrEqual(10);
    const transfers = DEFAULT_CATEGORIES.find(
      (c) => c.name === TRANSFERS_CATEGORY,
    );
    expect(transfers?.kind).toBe("transfer");
  });

  it("every rule names a seeded category and compiles", () => {
    for (const seed of DEFAULT_RULES) {
      expect(paths, seed.category).toContain(seed.category);
      if (seed.matchType === "regex") {
        expect(() => new RegExp(seed.pattern, "i")).not.toThrow();
      }
    }
  });

  it.each([
    ["S-MARKET KAMPPI", "Groceries/Supermarkets"],
    ["Prisma Itäkeskus", "Groceries/Supermarkets"],
    ["K-Market Ruoholahti", "Groceries/Supermarkets"],
    ["K-Citymarket Espoo", "Groceries/Supermarkets"],
    ["LIDL HELSINKI", "Groceries/Supermarkets"],
    ["Alepa Kallio", "Groceries/Supermarkets"],
    ["Sale Lauttasaari", "Groceries/Supermarkets"],
    ["Alko Kamppi", "Groceries/Alko"],
    ["HSL Mobiili", "Transport/Public transport"],
    ["VR-Yhtymä Oyj", "Transport/Trains & coaches"],
    ["WOLT", "Restaurants & cafés/Food delivery"],
    ["Foodora Finland", "Restaurants & cafés/Food delivery"],
    ["Hesburger Hakaniemi", "Restaurants & cafés/Fast food"],
    ["Neste Express", "Transport/Fuel"],
    ["Yliopiston Apteekki", "Health/Pharmacy"],
    ["NETFLIX.COM", "Subscriptions/Streaming"],
    ["Finnair", "Travel/Flights"],
    ["Nordnet Bank", "Savings & investments/Investments"],
  ])("%s → %s", (counterparty, category) => {
    expect(categoryOf({ counterparty })).toBe(category);
  });

  it("leaves look-alikes and unknown merchants alone", () => {
    expect(categoryOf({ counterparty: "Wholesale Oy" })).toBeNull();
    expect(categoryOf({ counterparty: "Silvr Oy" })).toBeNull();
    expect(categoryOf({ counterparty: "Elisabeth Virtanen" })).toBeNull();
    expect(categoryOf({ counterparty: "Example Shop Oy" })).toBeNull();
  });

  it("salary and rent by description, only in their direction", () => {
    expect(
      categoryOf({
        counterparty: "Esimerkki Oy",
        description: "Palkka maaliskuu",
        amountMinor: 250_000,
      }),
    ).toBe("Income/Salary");
    expect(
      categoryOf({
        counterparty: "Esimerkki Oy",
        description: "Palkka maaliskuu",
        amountMinor: -250_000,
      }),
    ).toBeNull();
    expect(
      categoryOf({
        counterparty: "Asunto Oy Esimerkki",
        description: "Vuokra 3/2026",
        amountMinor: -95_000,
      }),
    ).toBe("Housing/Rent & maintenance");
  });
});
