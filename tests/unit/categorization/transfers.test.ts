import { describe, expect, it } from "vitest";
import {
  findTransfers,
  normalizeIban,
  type OwnAccount,
  type TransferCandidate,
} from "@/server/categorization/transfers";

const NORDEA: OwnAccount = { id: "nordea", iban: "FI21 1234 5600 0007 85" };
const SPANKKI: OwnAccount = { id: "s-pankki", iban: "FI79 3939 0001 0002 46" };
const SAVINGS: OwnAccount = { id: "savings", iban: "FI49 5000 9420 0287 30" };
const ACCOUNTS = [NORDEA, SPANKKI, SAVINGS];

function leg(
  id: string,
  accountId: string,
  bookingDate: string,
  amountMinor: number,
  overrides: Partial<TransferCandidate> = {},
): TransferCandidate {
  return {
    id,
    accountId,
    bookingDate,
    amountMinor,
    currency: "EUR",
    counterparty: null,
    description: null,
    transferGroupId: null,
    eligible: true,
    ...overrides,
  };
}

/** Every leg is a subject and in the pool, as in a re-apply. */
function detect(legs: TransferCandidate[], accounts = ACCOUNTS) {
  return findTransfers({ subjects: legs, pool: legs, accounts });
}

describe("pairs between own accounts", () => {
  it("same day: a debit and a credit of the same amount", () => {
    const result = detect([
      leg("out", "nordea", "2026-03-16", -20_000, { counterparty: "Oma tili" }),
      leg("in", "savings", "2026-03-16", 20_000),
    ]);
    expect(result).toEqual({
      pairs: [{ ids: ["out", "in"], groupId: null }],
      oneSided: [],
    });
  });

  it("cross-bank delay: up to 3 days either way, debit first in the pair", () => {
    expect(
      detect([
        leg("in", "s-pankki", "2026-03-19", 50_000),
        leg("out", "nordea", "2026-03-16", -50_000),
      ]).pairs,
    ).toEqual([{ ids: ["out", "in"], groupId: null }]);
    // Credit booked before the debit (the banks book on different days).
    expect(
      detect([
        leg("out", "nordea", "2026-03-18", -50_000),
        leg("in", "s-pankki", "2026-03-16", 50_000),
      ]).pairs,
    ).toEqual([{ ids: ["out", "in"], groupId: null }]);
    // Across a month boundary.
    expect(
      detect([
        leg("out", "nordea", "2026-02-27", -50_000),
        leg("in", "s-pankki", "2026-03-02", 50_000),
      ]).pairs,
    ).toHaveLength(1);
  });

  it("only the subjects look for partners; the pool supplies them", () => {
    const out = leg("out", "nordea", "2026-03-16", -20_000);
    const back = leg("in", "savings", "2026-03-17", 20_000);
    expect(
      findTransfers({ subjects: [back], pool: [out, back], accounts: ACCOUNTS })
        .pairs,
    ).toEqual([{ ids: ["out", "in"], groupId: null }]);
  });

  it("picks the nearest day, then the earlier leg, and uses each leg once", () => {
    const result = detect([
      leg("out-1", "nordea", "2026-03-16", -10_000),
      leg("out-2", "nordea", "2026-03-18", -10_000),
      leg("in-far", "savings", "2026-03-15", 10_000),
      leg("in-near", "s-pankki", "2026-03-16", 10_000),
    ]);
    expect(result.pairs).toEqual([
      { ids: ["out-1", "in-near"], groupId: null },
      { ids: ["out-2", "in-far"], groupId: null },
    ]);
  });
});

describe("equal amounts that are not transfers", () => {
  it("more than 3 days apart", () => {
    expect(
      detect([
        leg("out", "nordea", "2026-03-16", -20_000),
        leg("in", "savings", "2026-03-20", 20_000),
      ]).pairs,
    ).toEqual([]);
  });

  it("a debit and a credit on the same account (a refund)", () => {
    expect(
      detect([
        leg("buy", "nordea", "2026-03-16", -4_990),
        leg("refund", "nordea", "2026-03-17", 4_990),
      ]).pairs,
    ).toEqual([]);
  });

  it("two debits, other currencies, other amounts or a zero amount", () => {
    expect(
      detect([
        leg("a", "nordea", "2026-03-16", -20_000),
        leg("b", "savings", "2026-03-16", -20_000),
        leg("c", "s-pankki", "2026-03-16", 20_000, { currency: "SEK" }),
        leg("d", "s-pankki", "2026-03-16", 20_001),
        leg("e", "nordea", "2026-03-16", 0),
        leg("f", "savings", "2026-03-16", 0),
      ]).pairs,
    ).toEqual([]);
  });

  it("a leg a rule put in a spending or income category", () => {
    // A grocery purchase that equals a payment a friend sent to savings.
    expect(
      detect([
        leg("groceries", "nordea", "2026-03-16", -4_500, {
          counterparty: "K-Market Kallio",
          eligible: false,
        }),
        leg("from-friend", "savings", "2026-03-16", 4_500),
      ]).pairs,
    ).toEqual([]);
    expect(
      detect([
        leg("out", "nordea", "2026-03-16", -4_500),
        leg("salary", "savings", "2026-03-16", 4_500, { eligible: false }),
      ]).pairs,
    ).toEqual([]);
  });

  it("two one-sided transfers do not merge", () => {
    expect(
      detect([
        leg("out", "nordea", "2026-03-16", -20_000, { transferGroupId: "g1" }),
        leg("in", "savings", "2026-03-16", 20_000, { transferGroupId: "g2" }),
      ]).pairs,
    ).toEqual([]);
  });
});

describe("transfers to an own IBAN", () => {
  it("pairs only with the named account, whatever its category", () => {
    const result = detect([
      leg("out", "nordea", "2026-03-16", -30_000, {
        description: `Siirto tilille ${normalizeIban(SAVINGS.iban!)}`,
        eligible: false,
      }),
      leg("decoy", "s-pankki", "2026-03-16", 30_000),
      leg("in", "savings", "2026-03-18", 30_000),
    ]);
    expect(result).toEqual({
      pairs: [{ ids: ["out", "in"], groupId: null }],
      oneSided: [],
    });
  });

  it("matches the IBAN with any spacing and case", () => {
    const result = detect([
      leg("out", "nordea", "2026-03-16", -30_000, {
        counterparty: "fi49 50009420028730",
      }),
    ]);
    expect(result).toEqual({ pairs: [], oneSided: ["out"] });
  });

  it("without a matching leg there it is a one-sided transfer", () => {
    expect(
      detect([
        leg("out", "nordea", "2026-03-16", -30_000, {
          counterparty: SPANKKI.iban,
        }),
        leg("elsewhere", "savings", "2026-03-16", 30_000),
      ]),
    ).toEqual({ pairs: [], oneSided: ["out"] });
  });

  it("a leg that names another account's IBAN is not a partner", () => {
    expect(
      detect([
        leg("out", "nordea", "2026-03-16", -30_000),
        leg("in", "savings", "2026-03-16", 30_000, {
          description: `From ${SPANKKI.iban}`,
        }),
      ]),
    ).toEqual({ pairs: [], oneSided: ["in"] });
  });

  it("ignores the account's own IBAN, missing and too short IBANs", () => {
    expect(
      detect(
        [
          leg("own", "nordea", "2026-03-16", -30_000, {
            description: NORDEA.iban,
          }),
          leg("short", "nordea", "2026-03-16", -30_000, {
            description: "FI12",
          }),
        ],
        [NORDEA, { id: "other", iban: null }, { id: "tiny", iban: "FI12" }],
      ),
    ).toEqual({ pairs: [], oneSided: [] });
  });

  it("a later partner joins the one-sided transfer's group", () => {
    const earlier = leg("out", "nordea", "2026-03-16", -30_000, {
      counterparty: SAVINGS.iban,
      transferGroupId: "group-1",
    });
    const arriving = leg("in", "savings", "2026-03-17", 30_000);
    expect(
      findTransfers({
        subjects: [arriving],
        pool: [earlier, arriving],
        accounts: ACCOUNTS,
      }),
    ).toEqual({
      pairs: [{ ids: ["out", "in"], groupId: "group-1" }],
      oneSided: [],
    });
    // Already one-sided and still alone: nothing new.
    expect(
      findTransfers({
        subjects: [earlier],
        pool: [earlier],
        accounts: ACCOUNTS,
      }),
    ).toEqual({ pairs: [], oneSided: [] });
  });
});
