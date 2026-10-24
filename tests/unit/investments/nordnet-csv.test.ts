import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeCsv } from "@/server/csv/values";
import { costBasis, deriveHoldings } from "@/server/investments/holdings";
import {
  identify,
  nordnetDedupeHash,
} from "@/server/investments/import-nordnet";
import {
  NordnetFormatError,
  parseNordnetDecimal,
  readNordnetCsv,
  type NordnetRow,
} from "@/server/investments/nordnet-csv";

// The synthetic Nordnet export in tests/fixtures/nordnet/ (UTF-16 LE with a
// byte order mark, tabs, Finnish headers; invented securities, never real
// account data) and small inline variants of it.

const FIXTURE = "tests/fixtures/nordnet/transactions-utf16.csv";

function fixture(): Uint8Array {
  return readFileSync(FIXTURE);
}

function fixtureText(): string {
  return decodeCsv(fixture()).text;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function byRef(rows: readonly NordnetRow[], ref: string): NordnetRow {
  const row = rows.find((r) => r.ref === ref);
  if (!row) throw new Error(`No row ${ref}`);
  return row;
}

const HEADER =
  "Id;Kauppapäivä;Salkku;Tapahtumatyyppi;Arvopaperi;ISIN;Määrä;Kurssi;Kokonaiskulut;Valuutta;Summa;Valuutta;Mitätöintipäivä";

describe("parseNordnetDecimal", () => {
  it.each([
    ["3,235", "3.235"],
    ["-1 259,00", "-1259"],
    ["1 234,5", "1234.5"],
    ["136,023", "136.023"],
    ["1.234,56", "1234.56"],
    ["12.5", "12.5"],
    ["+30", "30"],
    ["−7,50", "-7.5"],
    ["0", "0"],
  ])("reads %j as %s", (value, expected) => {
    expect(parseNordnetDecimal(value)).toBe(expected);
  });

  it.each(["", "abc", "1,2,3", "12e3", "1 234,56 €"])("rejects %j", (value) => {
    expect(() => parseNordnetDecimal(value)).toThrow(/Not a number/);
  });
});

describe("decodeCsv", () => {
  it("decodes UTF-16 LE and BE with a byte order mark", () => {
    expect(decodeCsv(fixture()).encoding).toBe("utf-16le");
    expect(fixtureText().startsWith("Id\tKirjauspäivä")).toBe(true);
    const be = Buffer.from("﻿Ää;1", "utf16le").swap16();
    expect(decodeCsv(be)).toEqual({ text: "Ää;1", encoding: "utf-16be" });
  });
});

describe("readNordnetCsv: the synthetic export", () => {
  const parsed = readNordnetCsv(fixture());

  it("reads every row, skipping the currency exchange and the cancelled buy", () => {
    expect(parsed.encoding).toBe("utf-16le");
    expect(parsed.delimiter).toBe("\t");
    expect(parsed.rowsRead).toBe(13);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(11);
    expect(parsed.skipped).toEqual([
      { row: 4, message: "OSTO: cancelled (2026-04-04)" },
      {
        row: 5,
        message:
          "VALUUTANVAIHTO: a currency exchange inside the account is not recorded",
      },
    ]);
  });

  it("maps a buy with its security, quantity, unit price and cash", () => {
    expect(byRef(parsed.rows, "1002")).toEqual({
      row: 13,
      ref: "1002",
      portfolio: "99990001",
      type: "buy",
      nordnetType: "OSTO",
      tradeDate: "2026-01-05",
      security: {
        symbol: "AAA1",
        name: null,
        isin: "FI4000000011",
        assetClass: "stock",
        currency: "EUR",
      },
      quantity: "100",
      priceMinor: "1250",
      amountMinor: -125_900,
      currency: "EUR",
      description: "Ostettu",
    });
  });

  it("uses the trade date, not the booking date", () => {
    expect(byRef(parsed.rows, "1005").tradeDate).toBe("2026-03-02");
  });

  it("signs sells negative in units and positive in cash", () => {
    const sell = byRef(parsed.rows, "1005");
    expect(sell.type).toBe("sell");
    expect(sell.quantity).toBe("-40");
    expect(sell.amountMinor).toBe(55_100);
  });

  it("reads fractional fund units, sub-cent prices and the fund class", () => {
    const fund = byRef(parsed.rows, "1003");
    expect(fund.quantity).toBe("3.235");
    expect(fund.priceMinor).toBe("13602.3");
    expect(fund.amountMinor).toBe(-44_003);
    expect(fund.security?.assetClass).toBe("fund");
    expect(fund.security?.symbol).toBe("NORDNET INDEKSI ESIM");
  });

  it("quotes a foreign security in its trade currency, cash in EUR", () => {
    const usx = byRef(parsed.rows, "1004");
    expect(usx.security?.currency).toBe("USD");
    expect(usx.priceMinor).toBe("5000");
    expect(usx.currency).toBe("EUR");
    expect(usx.amountMinor).toBe(-47_000);
  });

  it("maps dividends, withholding tax, fees, deposits and withdrawals", () => {
    const pick = (ref: string) => {
      const r = byRef(parsed.rows, ref);
      return [r.type, r.amountMinor, r.quantity, r.security?.symbol ?? null];
    };
    expect(pick("1006")).toEqual(["dividend", 3_000, null, "AAA1"]);
    expect(pick("1007")).toEqual(["fee", -750, null, "AAA1"]);
    expect(pick("1008")).toEqual(["fee", -200, null, null]);
    expect(pick("1009")).toEqual(["transfer", -50_000, null, null]);
    expect(pick("1001")).toEqual(["transfer", 500_000, null, null]);
  });
});

describe("readNordnetCsv: layouts and errors", () => {
  it("reads a semicolon UTF-8 export with Finnish dates and no Id column", () => {
    const parsed = readNordnetCsv(
      utf8(
        [
          "Kirjauspäivä;Kauppapäivä;Tapahtumatyyppi;Arvopaperi;ISIN;Määrä;Kurssi;Kokonaiskulut;Valuutta;Summa;Valuutta",
          "07.01.2026;05.01.2026;OSTO;AAA1;FI4000000011;100;12,50;9,00;EUR;-1 259,00;EUR",
        ].join("\n"),
      ),
    );
    expect(parsed.delimiter).toBe(";");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      ref: null,
      portfolio: null,
      tradeDate: "2026-01-05",
      quantity: "100",
      amountMinor: -125_900,
    });
  });

  it("reads the English headers", () => {
    const parsed = readNordnetCsv(
      utf8(
        [
          "Id\tBooking day\tTrade day\tPortfolio\tTransaction type\tSecurity\tISIN\tQuantity\tPrice\tTotal fees\tCurrency\tAmount\tCurrency",
          "7\t2026-03-04\t2026-03-02\t1\tSELL\tAAA1\tFI4000000011\t40\t14\t9\tEUR\t551\tEUR",
        ].join("\n"),
      ),
    );
    expect(parsed.rows[0]).toMatchObject({
      ref: "7",
      type: "sell",
      quantity: "-40",
      priceMinor: "1400",
      amountMinor: 55_100,
    });
  });

  it("finds the header below preamble lines", () => {
    const parsed = readNordnetCsv(
      utf8(`Nordnet\n\n${HEADER}\n1;2026-01-02;9;TALLETUS;;;;;;;100;EUR;\n`),
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].row).toBe(4);
  });

  it("lists unreadable rows by line and reads the rest", () => {
    const parsed = readNordnetCsv(
      utf8(
        [
          HEADER,
          "1;2026-01-02;9;TALLETUS;;;;;;;100;EUR;",
          "2;2026-01-05;9;OSTO;AAA1;FI4000000011;kymmenen;12,5;0;EUR;-125;EUR;",
          "3;2026-01-05;9;SPLITTI;AAA1;FI4000000011;2;;;;0;EUR;",
          "4;2026-02-30;9;TALLETUS;;;;;;;100;EUR;",
          "5;2026-01-05;9;OSTO;;;1;1;0;EUR;-1;EUR;",
          "6;2026-01-05;9;TALLETUS;;;;;;;100;;",
          "7;2026-01-05;9;OSTO;AAA1;NOTANISIN;1;1;0;EUR;-1;EUR;",
          "8;2026-01-05;9;OSTO;AAA1;FI4000000011;0;1;0;EUR;-1;EUR;",
          "9;2026-01-05;9;TALLETUS;;;;;;;100;EUR;;extra",
        ].join("\n"),
      ),
    );
    expect(parsed.rows.map((r) => r.ref)).toEqual(["1"]);
    expect(parsed.errors).toEqual([
      { row: 3, message: 'Not a number: "kymmenen"' },
      { row: 4, message: 'Unsupported transaction type "SPLITTI"' },
      { row: 5, message: 'Invalid booking date: "2026-02-30"' },
      { row: 6, message: "OSTO without a security" },
      { row: 7, message: "The amount has no currency" },
      { row: 8, message: 'Not an ISIN: "NOTANISIN"' },
      { row: 9, message: "The quantity is zero" },
      { row: 10, message: "Expected 13 columns, found 14" },
    ]);
  });

  it("rejects a file that is not a Nordnet export", () => {
    expect(() =>
      readNordnetCsv(
        utf8("Kirjauspäivä;Määrä;Saaja/Maksaja\n1.1.2026;-5,00;Kiosk\n"),
      ),
    ).toThrow(NordnetFormatError);
    expect(() => readNordnetCsv(utf8("  \n"))).toThrow("The file is empty.");
  });
});

describe("nordnetDedupeHash", () => {
  const rows = readNordnetCsv(fixture()).rows;

  it("tells identical rows apart only by their occurrence", () => {
    const [a, b] = [byRef(rows, "1012"), byRef(rows, "1013")];
    expect(nordnetDedupeHash(a, 1)).toBe(nordnetDedupeHash(b, 1));
    expect(nordnetDedupeHash(a, 2)).not.toBe(nordnetDedupeHash(a, 1));
  });

  it("numbers identical rows in id order, whatever the file order", () => {
    const [a, b] = [byRef(rows, "1012"), byRef(rows, "1013")];
    const hashes = (list: NordnetRow[]) =>
      Object.fromEntries(
        identify(list).map(({ row, hash }) => [row.ref, hash]),
      );
    expect(hashes([b, a])).toEqual(hashes([a, b]));
    expect(hashes([b, a])["1012"]).toBe(nordnetDedupeHash(a, 1));
    expect(hashes([b, a])["1013"]).toBe(nordnetDedupeHash(b, 2));
    // Ids compare as numbers: 999 before 1000.
    expect(
      hashes([
        { ...b, ref: "1000" },
        { ...a, ref: "999" },
      ])["999"],
    ).toBe(nordnetDedupeHash(a, 1));
  });

  it("ignores Nordnet's id, so a re-export with new ids still matches", () => {
    const row = byRef(rows, "1002");
    expect(nordnetDedupeHash({ ...row, ref: "other" }, 1)).toBe(
      nordnetDedupeHash(row, 1),
    );
    expect(nordnetDedupeHash({ ...row, amountMinor: -1 }, 1)).not.toBe(
      nordnetDedupeHash(row, 1),
    );
  });
});

describe("deriveHoldings and costBasis", () => {
  const rows = readNordnetCsv(fixture()).rows.map((r) => ({
    assetId: r.security?.isin ?? null,
    type: r.type,
    tradeDate: r.tradeDate,
    quantity: r.quantity,
    amountMinor: r.amountMinor,
    currency: r.currency,
  }));

  it("writes the units held at the end of each trade day", () => {
    expect(deriveHoldings(rows)).toEqual({
      holdings: [
        { assetId: "FI4000000011", date: "2026-01-05", quantity: "100" },
        { assetId: "FI4000000011", date: "2026-03-02", quantity: "60" },
        { assetId: "FI4000000011", date: "2026-04-07", quantity: "80" },
        { assetId: "IE0000000019", date: "2026-01-05", quantity: "3.235" },
        { assetId: "US0000000018", date: "2026-02-10", quantity: "10" },
      ],
      oversold: [],
    });
  });

  it("counts a same-day buy before a sell and clamps an oversold asset at 0", () => {
    const tx = (date: string, quantity: string) => ({
      assetId: "x",
      type: quantity.startsWith("-") ? ("sell" as const) : ("buy" as const),
      tradeDate: date,
      quantity,
      amountMinor: 0,
      currency: "EUR",
    });
    expect(
      deriveHoldings([tx("2026-01-01", "-5"), tx("2026-01-01", "5")]),
    ).toEqual({
      holdings: [{ assetId: "x", date: "2026-01-01", quantity: "0" }],
      oversold: [],
    });
    expect(
      deriveHoldings([tx("2026-01-01", "-5"), tx("2026-01-02", "3")]),
    ).toEqual({
      holdings: [
        { assetId: "x", date: "2026-01-01", quantity: "0" },
        { assetId: "x", date: "2026-01-02", quantity: "3" },
      ],
      oversold: ["x"],
    });
  });

  it("keeps the average cost of the units still held, fees included", () => {
    const bases = costBasis(rows, "2026-10-24");
    // 1 259,00 for 100; 40 sold remove 503,60; two buys of 139,00 add 278,00.
    expect(bases.get("FI4000000011")).toEqual({
      quantity: "80",
      costMinor: 103_340,
      currency: "EUR",
    });
    expect(bases.get("US0000000018")).toEqual({
      quantity: "10",
      costMinor: 47_000,
      currency: "EUR",
    });
    expect(costBasis(rows, "2026-02-01").get("FI4000000011")).toEqual({
      quantity: "100",
      costMinor: 125_900,
      currency: "EUR",
    });
  });

  it("has no basis for an asset bought in two currencies", () => {
    const buy = (currency: string) => ({
      assetId: "x",
      type: "buy" as const,
      tradeDate: "2026-01-01",
      quantity: "1",
      amountMinor: -100,
      currency,
    });
    expect(
      costBasis([buy("EUR"), buy("USD")], "2026-01-02").get("x"),
    ).toBeNull();
  });
});
