import { describe, expect, it } from "vitest";
import {
  CSV_MATCH_DAYS,
  matchCsvRows,
  type MatchableTransaction,
} from "@/server/csv/match";
import { addDays } from "@/server/dates";
import { dedupeHash } from "@/server/dedupe-hash";
import type { ProviderTransaction } from "@/server/providers/types";
import { identifyTransactions } from "@/server/sync/transaction-merge";

// Synthetic rows: the CSV side goes through `identifyTransactions()` as an
// import does; the stored side is written out as a sync would store it.

function csv(rows: Partial<ProviderTransaction>[]) {
  return identifyTransactions(
    rows.map((row) => ({
      ref: null,
      bookingDate: "2026-03-10",
      valueDate: null,
      amountMinor: -1250,
      currency: "EUR",
      counterparty: "Kahvila Testi",
      counterpartyIban: null,
      description: null,
      status: "booked",
      ...row,
    })),
  );
}

let nextId = 1;

function stored(row: Partial<MatchableTransaction> = {}): MatchableTransaction {
  const values = {
    providerTxnRef: null,
    bookingDate: "2026-03-10",
    valueDate: null,
    amountMinor: -1250,
    currency: "EUR",
    counterparty: "KAHVILA TESTI OY",
    counterpartyIban: null,
    description: "Korttiosto",
    ...row,
  };
  return {
    id: `stored-${nextId++}`,
    dedupeHash: dedupeHash({ ...values, occurrence: nextId }),
    ...values,
  };
}

describe("matchCsvRows", () => {
  it("matches by ref even when the date, amount and texts differ", () => {
    const api = stored({
      providerTxnRef: "20260310123456789",
      bookingDate: "2026-02-01",
      amountMinor: -999,
    });
    const rows = csv([{ ref: "20260310123456789" }]);
    expect(matchCsvRows([api], rows)).toEqual({
      matches: [api.id],
      insert: [],
    });
  });

  it("matches by hash an earlier import of the same file", () => {
    const [row] = csv([{ bookingDate: "2026-01-01", amountMinor: 500 }]);
    const earlier = stored({
      dedupeHash: row.dedupeHash,
      bookingDate: "2026-06-01",
      amountMinor: 1,
    });
    expect(matchCsvRows([earlier], [row]).matches).toEqual([earlier.id]);
  });

  it("matches the same amount within the window of the booking date", () => {
    const rows = csv([
      { bookingDate: addDays("2026-03-10", -CSV_MATCH_DAYS) },
      { bookingDate: addDays("2026-03-10", CSV_MATCH_DAYS + 1) },
    ]);
    const api = stored({ bookingDate: "2026-03-10" });
    const result = matchCsvRows([api], rows);
    expect(result.matches).toEqual([api.id, null]);
    expect(result.insert).toEqual([rows[1]]);
  });

  it("measures the window from the value date too", () => {
    // Nordea: the API books a transfer a day after the export's date and
    // gives the export's date as the value date.
    const api = stored({ bookingDate: "2026-03-20", valueDate: "2026-03-14" });
    const rows = csv([{ bookingDate: "2026-03-11" }]);
    expect(matchCsvRows([api], rows).matches).toEqual([api.id]);
    const far = csv([{ bookingDate: "2026-03-10" }]);
    expect(matchCsvRows([api], far).matches).toEqual([null]);
  });

  it("never matches another amount or currency", () => {
    const rows = csv([{}]);
    expect(
      matchCsvRows(
        [stored({ amountMinor: -1251 }), stored({ currency: "SEK" })],
        rows,
      ).matches,
    ).toEqual([null]);
  });

  it("prefers the same counterparty IBAN over the text", () => {
    const iban = "FI2112345600000785";
    const sameText = stored({ counterparty: "Kahvila Testi" });
    const sameIban = stored({ counterparty: "Other", counterpartyIban: iban });
    const rows = csv([{ counterpartyIban: iban }]);
    expect(matchCsvRows([sameText, sameIban], rows).matches).toEqual([
      sameIban.id,
    ]);
  });

  it("prefers the more similar text over the nearer day", () => {
    const near = stored({
      counterparty: "Lähikauppa",
      bookingDate: "2026-03-10",
    });
    const similar = stored({
      counterparty: "Kahvila Testi",
      bookingDate: "2026-03-12",
    });
    const rows = csv([{ counterparty: "KAHVILA TESTI" }]);
    expect(matchCsvRows([near, similar], rows).matches).toEqual([similar.id]);
  });

  it("prefers the nearer day, then the oldest stored row", () => {
    const later = stored({ bookingDate: "2026-03-12" });
    const nearer = stored({ bookingDate: "2026-03-11" });
    const rows = csv([{ bookingDate: "2026-03-10" }]);
    expect(matchCsvRows([later, nearer], rows).matches).toEqual([nearer.id]);

    const older = stored({ bookingDate: "2026-03-11" });
    const newer = stored({ bookingDate: "2026-03-09" });
    expect(matchCsvRows([older, newer], rows).matches).toEqual([older.id]);
  });

  it("gives each row its best free match", () => {
    // The IBAN pair is the best one and is taken first; the first row still
    // gets the exact text instead of being left without a match.
    const iban = "FI2112345600000785";
    const exact = stored({ counterparty: "Vuokra", description: null });
    const byIban = stored({ counterparty: "X", counterpartyIban: iban });
    const rows = csv([
      { counterparty: "Vuokra" },
      { counterparty: "Y", counterpartyIban: iban },
    ]);
    expect(matchCsvRows([exact, byIban], rows).matches).toEqual([
      exact.id,
      byIban.id,
    ]);
  });

  it("uses each stored row once: two equal purchases match two, a third is new", () => {
    const first = stored();
    const second = stored();
    const rows = csv([{}, {}, {}]);
    const result = matchCsvRows([first, second], rows);
    expect(result.matches).toEqual([first.id, second.id, null]);
    expect(result.insert).toEqual([rows[2]]);
  });

  it("does not let a ref-matched row's stored row match again by amount", () => {
    const api = stored({ providerTxnRef: "A" });
    const rows = csv([{ ref: "A" }, {}]);
    expect(matchCsvRows([api], rows).matches).toEqual([api.id, null]);
  });

  it("gives a new row whose hash a stored row has the next free occurrence", () => {
    const [plain] = csv([{}]);
    // The stored row with this hash is the bank's ref A; the file's row has
    // no ref and another day can't match it by amount either.
    const api = stored({
      providerTxnRef: "A",
      dedupeHash: plain.dedupeHash,
      amountMinor: 1,
    });
    const rows = csv([{ ref: "A", amountMinor: 1 }, {}]);
    const result = matchCsvRows([api], rows);
    expect(result.matches).toEqual([api.id, null]);
    expect(result.insert).toHaveLength(1);
    expect(result.insert[0].dedupeHash).not.toBe(plain.dedupeHash);
    expect(result.insert[0].dedupeHash).toBe(
      dedupeHash({ ...plain, occurrence: 2 }),
    );
  });

  it("inserts everything into an empty account", () => {
    const rows = csv([{}, {}, { amountMinor: 100 }]);
    expect(matchCsvRows([], rows)).toEqual({
      matches: [null, null, null],
      insert: rows,
    });
  });
});
