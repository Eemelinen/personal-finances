import { describe, expect, it } from "vitest";
import { localDate } from "@/server/dates";
import { dedupeHash } from "@/server/dedupe-hash";
import type { ProviderTransaction } from "@/server/providers/types";
import {
  identifyTransactions,
  mergeTransactions,
  OVERLAP_DAYS,
  PENDING_MATCH_DAYS,
  syncWindowStart,
  type StoredTransaction,
  type TransactionValues,
} from "@/server/sync/transaction-merge";

const HELSINKI = "Europe/Helsinki";

function txn(
  overrides: Partial<ProviderTransaction> = {},
): ProviderTransaction {
  return {
    ref: "t1",
    bookingDate: "2026-03-10",
    valueDate: "2026-03-10",
    amountMinor: -1_250,
    currency: "EUR",
    counterparty: "Example Cafe",
    description: "Card purchase",
    status: "booked",
    ...overrides,
  };
}

function identified(overrides: Partial<ProviderTransaction> = {}) {
  return identifyTransactions([txn(overrides)])[0];
}

let nextId = 0;
function stored(values: TransactionValues): StoredTransaction {
  nextId++;
  return {
    id: `00000000-0000-0000-0000-${String(nextId).padStart(12, "0")}`,
    ...values,
  };
}

describe("syncWindowStart (overlap window)", () => {
  it("backfills an account that was never synced", () => {
    expect(
      syncWindowStart({
        syncedAt: null,
        oldestPendingDate: "2026-01-01",
        timeZone: HELSINKI,
      }),
    ).toBeUndefined();
  });

  it(`starts ${OVERLAP_DAYS} days before the last sync's local day`, () => {
    expect(
      syncWindowStart({
        syncedAt: new Date("2026-03-10T09:00:00Z"),
        oldestPendingDate: null,
        timeZone: HELSINKI,
      }),
    ).toBe("2026-03-03");
  });

  it("counts the day in the app's time zone, not UTC", () => {
    // 23:30 UTC on 9 March is already 10 March in Helsinki.
    const syncedAt = new Date("2026-03-09T23:30:00Z");

    expect(localDate(syncedAt, HELSINKI)).toBe("2026-03-10");
    expect(
      syncWindowStart({
        syncedAt,
        oldestPendingDate: null,
        timeZone: HELSINKI,
      }),
    ).toBe("2026-03-03");
    expect(
      syncWindowStart({ syncedAt, oldestPendingDate: null, timeZone: "UTC" }),
    ).toBe("2026-03-02");
  });

  it("crosses month and year boundaries", () => {
    expect(
      syncWindowStart({
        syncedAt: new Date("2026-01-03T12:00:00Z"),
        oldestPendingDate: null,
        timeZone: HELSINKI,
      }),
    ).toBe("2025-12-27");
  });

  it("reaches back to an older pending transaction, never forward", () => {
    const syncedAt = new Date("2026-03-20T09:00:00Z");

    expect(
      syncWindowStart({
        syncedAt,
        oldestPendingDate: "2026-03-01",
        timeZone: HELSINKI,
      }),
    ).toBe("2026-03-01");
    expect(
      syncWindowStart({
        syncedAt,
        oldestPendingDate: "2026-03-19",
        timeZone: HELSINKI,
      }),
    ).toBe("2026-03-13");
  });
});

describe("identifyTransactions (missing provider ids)", () => {
  it("hashes every transaction, with or without a ref", () => {
    const [withRef, withoutRef] = identifyTransactions([
      txn(),
      txn({ ref: null, amountMinor: -500 }),
    ]);

    expect(withRef.providerTxnRef).toBe("t1");
    expect(withRef.dedupeHash).toBe(dedupeHash(txn()));
    expect(withoutRef.providerTxnRef).toBeNull();
    expect(withoutRef.dedupeHash).toBe(dedupeHash(txn({ amountMinor: -500 })));
  });

  it("numbers identical transactions so each gets its own hash", () => {
    const listing = identifyTransactions([
      txn({ ref: null }),
      txn({ ref: null }),
      txn({ ref: null }),
    ]);
    const hashes = listing.map((row) => row.dedupeHash);

    expect(new Set(hashes).size).toBe(3);
    expect(hashes[0]).toBe(dedupeHash(txn()));
    expect(hashes[1]).toBe(dedupeHash({ ...txn(), occurrence: 2 }));
    // The same listing again hashes the same: a re-sync finds them.
    expect(
      identifyTransactions([
        txn({ ref: null }),
        txn({ ref: null }),
        txn({ ref: null }),
      ]).map((row) => row.dedupeHash),
    ).toEqual(hashes);
  });

  it("numbers identical transactions by ref, whatever order they come in", () => {
    const forward = identifyTransactions([
      txn({ ref: "a" }),
      txn({ ref: "b" }),
    ]);
    const backward = identifyTransactions([
      txn({ ref: "b" }),
      txn({ ref: "a" }),
    ]);
    const hashOf = (rows: TransactionValues[], ref: string) =>
      rows.find((row) => row.providerTxnRef === ref)!.dedupeHash;

    expect(hashOf(forward, "a")).toBe(hashOf(backward, "a"));
    expect(hashOf(forward, "b")).toBe(hashOf(backward, "b"));
    expect(hashOf(forward, "a")).not.toBe(hashOf(forward, "b"));
  });

  it("keeps the last version of a ref listed twice", () => {
    const listing = identifyTransactions([
      txn({ status: "pending" }),
      txn({ ref: "t2", amountMinor: -10 }),
      txn({ status: "booked" }),
    ]);

    expect(listing.map((row) => [row.providerTxnRef, row.status])).toEqual([
      ["t2", "booked"],
      ["t1", "booked"],
    ]);
  });
});

describe("mergeTransactions", () => {
  it("inserts what is new and leaves identical rows alone", () => {
    const known = stored(identified());
    const plan = mergeTransactions(
      [known],
      identifyTransactions([txn(), txn({ ref: "t2", amountMinor: -99 })]),
    );

    expect(plan.unchanged).toBe(1);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.insert.map((row) => row.providerTxnRef)).toEqual(["t2"]);
  });

  it("updates a row matched by its ref in place", () => {
    const known = stored(identified({ description: "Card purchase" }));
    const plan = mergeTransactions(
      [known],
      identifyTransactions([txn({ description: "CARD PURCHASE 1234" })]),
    );

    expect(plan.insert).toEqual([]);
    expect(plan.update).toEqual([
      {
        id: known.id,
        values: expect.objectContaining({ description: "CARD PURCHASE 1234" }),
        rekey: true,
      },
    ]);
  });

  it("matches a transaction without a ref by its hash", () => {
    const known = stored(identified({ ref: null }));
    const plan = mergeTransactions(
      [known],
      identifyTransactions([txn({ ref: null })]),
    );

    expect(plan).toEqual({ insert: [], update: [], remove: [], unchanged: 1 });
  });

  it("adopts the provider's ref for a row stored without one", () => {
    const known = stored(identified({ ref: null }));
    const plan = mergeTransactions(
      [known],
      identifyTransactions([txn({ ref: "late" })]),
    );

    expect(plan.update).toEqual([
      {
        id: known.id,
        values: expect.objectContaining({ providerTxnRef: "late" }),
        rekey: true,
      },
    ]);
  });

  it("keeps a stored ref when a later listing drops it", () => {
    const known = stored(identified({ ref: "t1" }));
    const plan = mergeTransactions(
      [known],
      identifyTransactions([txn({ ref: null })]),
    );

    expect(plan).toEqual({ insert: [], update: [], remove: [], unchanged: 1 });
  });

  it("inserts the second of two identical transactions without refs", () => {
    const first = stored(identified({ ref: null }));
    const plan = mergeTransactions(
      [first],
      identifyTransactions([txn({ ref: null }), txn({ ref: null })]),
    );

    expect(plan.unchanged).toBe(1);
    expect(plan.insert).toHaveLength(1);
    expect(plan.insert[0].dedupeHash).not.toBe(first.dedupeHash);
  });

  it("gives a ref match the next free hash when an unmatched row has it", () => {
    // The bank changed the text of t1 to exactly that of an older row
    // without a ref: both stay, with different hashes.
    const old = stored(identified({ ref: null, description: "Card purchase" }));
    const t1 = stored(identified({ description: "Pending" }));
    const plan = mergeTransactions([old, t1], identifyTransactions([txn()]));

    expect(plan.insert).toEqual([]);
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0].id).toBe(t1.id);
    expect(plan.update[0].values.dedupeHash).toBe(
      dedupeHash({ ...txn(), occurrence: 2 }),
    );
    expect(plan.update[0].values.dedupeHash).not.toBe(old.dedupeHash);
  });
});

describe("mergeTransactions (pending to booked)", () => {
  it("books a pending row with the same ref", () => {
    const pending = stored(identified({ status: "pending" }));
    const plan = mergeTransactions([pending], identifyTransactions([txn()]));

    expect(plan.update).toEqual([
      {
        id: pending.id,
        values: expect.objectContaining({ status: "booked" }),
        rekey: false,
      },
    ]);
    expect(plan.insert).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("replaces a pending row without a ref by its booked version with a new ref, date and text", () => {
    const pending = stored(
      identified({
        ref: null,
        status: "pending",
        bookingDate: "2026-03-08",
        description: "Pending card purchase",
      }),
    );
    const plan = mergeTransactions(
      [pending],
      identifyTransactions([
        txn({ ref: "booked-1", bookingDate: "2026-03-10" }),
      ]),
    );

    expect(plan.insert).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.update).toEqual([
      {
        id: pending.id,
        values: expect.objectContaining({
          providerTxnRef: "booked-1",
          bookingDate: "2026-03-10",
          status: "booked",
          description: "Card purchase",
        }),
        rekey: true,
      },
    ]);
  });

  it("prefers the pending row with the same counterparty, then the nearest day", () => {
    const otherShop = stored(
      identified({
        ref: null,
        status: "pending",
        counterparty: "Example Pharmacy",
        bookingDate: "2026-03-10",
      }),
    );
    const far = stored(
      identified({
        ref: null,
        status: "pending",
        bookingDate: "2026-03-05",
        description: "a",
      }),
    );
    const near = stored(
      identified({
        ref: null,
        status: "pending",
        bookingDate: "2026-03-09",
        description: "b",
      }),
    );
    const plan = mergeTransactions(
      [otherShop, far, near],
      identifyTransactions([txn({ ref: "booked" })]),
    );

    expect(plan.update.map((update) => update.id)).toEqual([near.id]);
    expect(plan.remove.sort()).toEqual([otherShop.id, far.id].sort());
  });

  it("does not match a pending row with another amount, currency or too far away", () => {
    const rows = [
      stored(identified({ ref: null, status: "pending", amountMinor: -1_251 })),
      stored(
        identified({
          ref: null,
          status: "pending",
          currency: "SEK",
          description: "kronor",
        }),
      ),
      stored(
        identified({
          ref: null,
          status: "pending",
          bookingDate: "2026-03-02",
          description: "old",
        }),
      ),
    ];
    const plan = mergeTransactions(
      rows,
      identifyTransactions([txn({ ref: "b" })]),
    );

    expect(PENDING_MATCH_DAYS).toBe(7);
    expect(plan.insert).toHaveLength(1);
    expect(plan.update).toEqual([]);
    expect(plan.remove.sort()).toEqual(rows.map((row) => row.id).sort());
  });

  it("never matches a booked row by amount alone", () => {
    const booked = stored(identified({ ref: "x", description: "other" }));
    const plan = mergeTransactions(
      [booked],
      identifyTransactions([txn({ ref: "y" })]),
    );

    expect(plan.insert).toHaveLength(1);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("does not let a fuzzy match take a pending row that is still listed", () => {
    const pending = stored(identified({ status: "pending" }));
    const plan = mergeTransactions(
      [pending],
      identifyTransactions([
        txn({ ref: "other", status: "booked", description: "x" }),
        txn({ status: "pending" }),
      ]),
    );

    expect(plan.unchanged).toBe(1);
    expect(plan.insert.map((row) => row.providerTxnRef)).toEqual(["other"]);
    expect(plan.remove).toEqual([]);
  });

  it("removes pending rows the listing no longer has and keeps booked ones", () => {
    const stale = stored(
      identified({ ref: "gone", status: "pending", amountMinor: -7 }),
    );
    const booked = stored(identified({ ref: "kept", amountMinor: -8 }));
    const plan = mergeTransactions([stale, booked], []);

    expect(plan).toEqual({
      insert: [],
      update: [],
      remove: [stale.id],
      unchanged: 0,
    });
  });
});
