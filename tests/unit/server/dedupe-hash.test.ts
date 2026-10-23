import { describe, expect, it } from "vitest";
import {
  dedupeHash,
  normaliseAmount,
  normaliseDate,
  normaliseText,
} from "@/server/dedupe-hash";

const base = {
  bookingDate: "2026-01-05",
  amountMinor: -1250,
  counterparty: "S-Market Kamppi",
  description: "Korttiosto",
};

describe("dedupeHash", () => {
  it("is a stable SHA-256 hex digest", () => {
    const hash = dedupeHash(base);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(dedupeHash({ ...base })).toBe(hash);
  });

  it("normalises the booking date", () => {
    const hash = dedupeHash(base);

    expect(dedupeHash({ ...base, bookingDate: "2026-01-05T10:15:00Z" })).toBe(
      hash,
    );
    expect(dedupeHash({ ...base, bookingDate: "5.1.2026" })).toBe(hash);
    expect(dedupeHash({ ...base, bookingDate: " 05.01.2026 " })).toBe(hash);
    expect(dedupeHash({ ...base, bookingDate: "2026-01-06" })).not.toBe(hash);
  });

  it("normalises the amount", () => {
    const hash = dedupeHash(base);

    expect(dedupeHash({ ...base, amountMinor: BigInt(-1250) })).toBe(hash);
    expect(dedupeHash({ ...base, amountMinor: 1250 })).not.toBe(hash);
    expect(dedupeHash({ ...base, amountMinor: 0 })).toBe(
      dedupeHash({ ...base, amountMinor: -0 }),
    );
  });

  it("normalises counterparty and description", () => {
    const hash = dedupeHash(base);

    expect(
      dedupeHash({
        ...base,
        counterparty: "  s-market   KAMPPI ",
        description: "KORTTIOSTO\t",
      }),
    ).toBe(hash);
    // NFKC: a no-break space and full-width letters fold to their plain forms.
    expect(dedupeHash({ ...base, counterparty: "S-Market Ｋａｍｐｐｉ" })).toBe(
      hash,
    );
    expect(dedupeHash({ ...base, counterparty: "Prisma Kamppi" })).not.toBe(
      hash,
    );
    expect(dedupeHash({ ...base, description: "Verkko-ostos" })).not.toBe(hash);
  });

  it("treats missing text as empty and keeps fields apart", () => {
    expect(dedupeHash({ ...base, counterparty: null })).toBe(
      dedupeHash({ ...base, counterparty: undefined }),
    );
    expect(
      dedupeHash({ ...base, counterparty: "", description: "ab" }),
    ).not.toBe(dedupeHash({ ...base, counterparty: "ab", description: "" }));
  });
});

describe("dedupeHash occurrence", () => {
  const input = {
    bookingDate: "2026-03-01",
    amountMinor: -250,
    counterparty: "Example Cafe",
    description: "Card purchase",
  };

  it("hashes the first occurrence as before and later ones apart", () => {
    const first = dedupeHash(input);

    expect(dedupeHash({ ...input, occurrence: 1 })).toBe(first);
    expect(dedupeHash({ ...input, occurrence: 2 })).not.toBe(first);
    expect(dedupeHash({ ...input, occurrence: 3 })).not.toBe(
      dedupeHash({ ...input, occurrence: 2 }),
    );
  });

  it("rejects occurrences that are not positive integers", () => {
    for (const occurrence of [0, -1, 1.5, Number.NaN]) {
      expect(() => dedupeHash({ ...input, occurrence })).toThrow(/Occurrence/);
    }
  });
});

describe("normalisers", () => {
  it("rejects dates it cannot read", () => {
    expect(() => normaliseDate("2026-02-30")).toThrow(/Invalid/);
    expect(() => normaliseDate("01/05/2026")).toThrow(/Unrecognised/);
    expect(() => normaliseDate("")).toThrow(/Unrecognised/);
  });

  it("rejects amounts that are not integer minor units", () => {
    expect(() => normaliseAmount(12.5)).toThrow(/integer minor units/);
    expect(() => normaliseAmount(Number.NaN)).toThrow(/integer minor units/);
    expect(normaliseAmount(-0)).toBe("0");
    expect(normaliseAmount(BigInt("9007199254740993"))).toBe(
      "9007199254740993",
    );
  });

  it("collapses whitespace, control characters and case", () => {
    expect(normaliseText("  Foo\n\tBAR  ")).toBe("foo bar");
    expect(normaliseText("a\u001fb\u0000")).toBe("a b");
    expect(normaliseText(null)).toBe("");
  });
});
