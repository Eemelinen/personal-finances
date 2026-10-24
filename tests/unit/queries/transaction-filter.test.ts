import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  isFiltered,
  isIsoDate,
  MAX_TEXT_LENGTH,
  parseTransactionQuery,
  transactionSearchParams,
  transactionsHref,
} from "@/server/queries/transaction-filter";

const A = "0b6f6a3e-6a0f-4c55-9a59-4f3d3b8c1a01";
const B = "7d1e2a44-1b2c-4d3e-8f90-123456789abc";

describe("parseTransactionQuery", () => {
  it("reads every filter from the URL", () => {
    expect(
      parseTransactionQuery({
        from: "2024-03-01",
        to: "2024-03-31",
        account: [A, B],
        category: B,
        q: "  kiosk  ",
        type: "expense",
        transfers: "exclude",
        page: "3",
      }),
    ).toEqual({
      filter: {
        from: "2024-03-01",
        to: "2024-03-31",
        accounts: [A, B],
        category: B,
        text: "kiosk",
        direction: "expense",
        transfers: "exclude",
      },
      page: 3,
    });
  });

  it("is the empty filter on page 1 without parameters", () => {
    expect(parseTransactionQuery({})).toEqual({
      filter: EMPTY_FILTER,
      page: 1,
    });
  });

  it("ignores values that do not parse", () => {
    expect(
      parseTransactionQuery({
        from: "2024-02-30",
        to: "yesterday",
        account: ["not-a-uuid", A],
        category: "groceries",
        type: "both",
        transfers: "yes",
        page: "-2",
      }),
    ).toEqual({
      filter: { ...EMPTY_FILTER, accounts: [A] },
      page: 1,
    });
    for (const page of ["0", "1.5", "abc", "1e400"]) {
      expect(parseTransactionQuery({ page }).page).toBe(1);
    }
  });

  it("accepts the no-category filter and lower-cases ids", () => {
    expect(parseTransactionQuery({ category: "none" }).filter.category).toBe(
      "none",
    );
    const upper = parseTransactionQuery({
      category: B.toUpperCase(),
      account: [A.toUpperCase(), A],
    }).filter;
    expect(upper.category).toBe(B);
    expect(upper.accounts).toEqual([A]);
  });

  it("uses the first value of a repeated single-valued parameter", () => {
    expect(
      parseTransactionQuery({ type: ["income", "expense"] }).filter.direction,
    ).toBe("income");
  });

  it("cuts a long text filter", () => {
    const text = parseTransactionQuery({ q: "x".repeat(500) }).filter.text;
    expect(text).toHaveLength(MAX_TEXT_LENGTH);
  });
});

describe("transactionSearchParams", () => {
  it("writes only the set values and leaves page 1 out", () => {
    expect(transactionSearchParams(EMPTY_FILTER).toString()).toBe("");
    expect(transactionsHref(EMPTY_FILTER)).toBe("/transactions");
    expect(
      transactionsHref(
        { ...EMPTY_FILTER, accounts: [A, B], text: "a&b", direction: "income" },
        2,
      ),
    ).toBe(
      `/transactions?account=${A}&account=${B}&q=a%26b&type=income&page=2`,
    );
  });

  it("round-trips through parseTransactionQuery", () => {
    const filter = {
      from: "2024-01-01",
      to: "2024-12-31",
      accounts: [B],
      category: "none",
      text: "100% kahvi",
      direction: "expense" as const,
      transfers: "only" as const,
    };
    const params = Object.fromEntries(transactionSearchParams(filter, 4));
    expect(parseTransactionQuery(params)).toEqual({ filter, page: 4 });
  });

  it("tells a filtered view from the unfiltered one", () => {
    expect(isFiltered(EMPTY_FILTER)).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTER, transfers: "exclude" })).toBe(true);
  });
});

describe("isIsoDate", () => {
  it("accepts real days only", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2023-02-29")).toBe(false);
    expect(isIsoDate("2024-13-01")).toBe(false);
    expect(isIsoDate("2024-1-01")).toBe(false);
    expect(isIsoDate("")).toBe(false);
  });
});
