import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CsvFormatError,
  guessMapping,
  readBankCsv,
} from "@/server/csv/bank-csv";
import { CsvSyntaxError, detectDelimiter, parseCsv } from "@/server/csv/parse";
import { decodeCsv, parseCsvAmount, parseCsvDate } from "@/server/csv/values";

// Synthetic exports in tests/fixtures/csv/ (never real bank data): the
// Nordea and S-Pankki layouts in Windows-1252 and UTF-8, a generic CSV and
// a file with unreadable rows.

function fixture(name: string): Uint8Array {
  return readFileSync(path.join("tests/fixtures/csv", name));
}

function encode1252(text: string): Uint8Array {
  // Every character used here is in Latin-1, where Windows-1252 agrees.
  return Uint8Array.from(Buffer.from(text, "latin1"));
}

describe("parseCsvAmount", () => {
  it.each([
    ["-12,50", -1_250],
    ["12,5", 1_250],
    ["+3500,00", 350_000],
    ["-1 234,56", -123_456],
    ["1 234,56", 123_456],
    ["1 234,56", 123_456],
    ["1.234,56", 123_456],
    ["1,234.56", 123_456],
    ["1'234.56", 123_456],
    ["12.50", 1_250],
    ["1.234", 123_400],
    ["1 000 000", 100_000_000],
    ["−12,00", -1_200],
    ["12,00-", -1_200],
    ["-0,00", 0],
    ["12,50 €", 1_250],
    ["-12,50 EUR", -1_250],
    ["7", 700],
  ])("%j is %d minor units", (value, expected) => {
    expect(parseCsvAmount(value)).toBe(expected);
  });

  it.each([
    "",
    "abc",
    "12,345,6",
    "1,234,56",
    "12,",
    "1.234,567",
    "1234,567",
    "--12",
    "-12,00-",
    "12a",
    "1.234.56,00",
    "99999999999999999999",
  ])("rejects %j", (value) => {
    expect(() => parseCsvAmount(value)).toThrow();
  });
});

describe("parseCsvDate", () => {
  it.each([
    ["05.01.2026", "2026-01-05"],
    ["5.1.2026", "2026-01-05"],
    [" 31.12.2025 ", "2025-12-31"],
    ["2026-03-02", "2026-03-02"],
    ["2026-03-02T10:15:00", "2026-03-02"],
    ["2026/03/02", "2026-03-02"],
    ["2026/3/2", "2026-03-02"],
    ["29.02.2024", "2024-02-29"],
  ])("%j is %s", (value, expected) => {
    expect(parseCsvDate(value)).toBe(expected);
  });

  it.each(["31.02.2026", "29.02.2025", "2026-13-01", "05/01/2026", "Varaus"])(
    "rejects %j",
    (value) => {
      expect(() => parseCsvDate(value)).toThrow();
    },
  );
});

describe("decodeCsv", () => {
  it("reads valid UTF-8 and drops the byte order mark", () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("Määrä"),
    ]);
    expect(decodeCsv(bytes)).toEqual({ text: "Määrä", encoding: "utf-8" });
  });

  it("falls back to Windows-1252, including the euro sign and dashes", () => {
    const bytes = new Uint8Array([0x4d, 0xe4, 0xe4, 0x80, 0x96, 0xbd]);
    expect(decodeCsv(bytes)).toEqual({
      text: "Mää€–½",
      encoding: "windows-1252",
    });
  });
});

describe("parseCsv", () => {
  it("reads quoted fields with delimiters, escaped quotes and line breaks", () => {
    const text = 'a;"b;c";"say ""hi"""\r\n"multi\r\nline";x;\r\n\r\nlast;1;2';
    expect(parseCsv(text, ";")).toEqual([
      { line: 1, cells: ["a", "b;c", 'say "hi"'] },
      { line: 2, cells: ["multi\r\nline", "x", ""] },
      { line: 5, cells: ["last", "1", "2"] },
    ]);
  });

  it("handles LF and CR line endings and a missing final newline", () => {
    expect(parseCsv("a,b\nc,d\re,f", ",")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["c", "d"] },
      { line: 3, cells: ["e", "f"] },
    ]);
  });

  it("rejects an unterminated quote with its line", () => {
    expect(() => parseCsv('a;b\nc;"open\nmore', ";")).toThrow(CsvSyntaxError);
    expect(() => parseCsv('a;b\nc;"open\nmore', ";")).toThrow(/^Line 2/);
  });

  it.each([
    ["a;b;c\n1;2,5;3\n", ";"],
    ["a\tb\tc\n1\t2,5\t3\n", "\t"],
    ["a,b,c\n1,2.5,3\n", ","],
    ["Tilinumero\tFI00\n\na\tb\tc\n1\t2\t3\n4\t5\t6\n", "\t"],
  ])("detects the delimiter of %j", (text, expected) => {
    expect(detectDelimiter(text)).toBe(expected);
  });
});

describe("readBankCsv: Nordea", () => {
  it("reads the Windows-1252, tab-separated export with its preamble", () => {
    const parsed = readBankCsv(fixture("nordea.csv"));
    expect(parsed).toMatchObject({
      format: "nordea",
      encoding: "windows-1252",
      delimiter: "\t",
      mapping: null,
      needsMapping: false,
      rowsRead: 6,
      errors: [],
    });
    expect(parsed.headers[0]).toBe("Kirjauspäivä");
    expect(parsed.rows).toEqual([
      {
        row: 4,
        bookingDate: "2026-01-02",
        valueDate: "2026-01-02",
        amountMinor: -95_000,
        currency: null,
        counterparty: "Esimerkki Asunnot Oy",
        description: "Vuokra tammikuu",
      },
      {
        row: 5,
        bookingDate: "2026-01-05",
        valueDate: "2026-01-05",
        amountMinor: -450,
        currency: null,
        counterparty: "Kahvila Määränpää",
        description: "Korttiosto",
      },
      {
        row: 6,
        bookingDate: "2026-01-05",
        valueDate: "2026-01-05",
        amountMinor: -450,
        currency: null,
        counterparty: "Kahvila Määränpää",
        description: "Korttiosto",
      },
      {
        row: 7,
        bookingDate: "2026-01-15",
        valueDate: "2026-01-15",
        amountMinor: 350_000,
        currency: null,
        counterparty: "Esimerkki Työnantaja Oy",
        description: "Palkka tammikuu",
      },
      {
        row: 8,
        bookingDate: "2026-01-20",
        valueDate: "2026-01-20",
        amountMinor: -123_456,
        currency: null,
        counterparty: "Lähikauppa Öljymäki",
        description: "Korttiosto",
      },
      {
        row: 9,
        bookingDate: "2026-01-31",
        valueDate: "2026-01-31",
        amountMinor: -1_290,
        currency: null,
        counterparty: "Äänikirjapalvelu Esimerkki",
        description: "Kuukausimaksu 12,90 € – ½ hinnalla",
      },
    ]);
  });

  it("reads the UTF-8, semicolon layout with payer and payee columns", () => {
    const parsed = readBankCsv(fixture("nordea-utf8.csv"));
    expect(parsed).toMatchObject({
      format: "nordea",
      encoding: "utf-8",
      delimiter: ";",
      rowsRead: 4,
    });
    expect(parsed.rows).toEqual([
      {
        row: 2,
        bookingDate: "2026-03-02",
        valueDate: null,
        amountMinor: -1_520,
        currency: "EUR",
        counterparty: "Ravintola Esimerkki",
        description: "Korttiosto",
      },
      {
        row: 3,
        bookingDate: "2026-03-05",
        valueDate: null,
        amountMinor: 250_000,
        currency: "EUR",
        counterparty: "Esimerkki Työnantaja Oy",
        description: "Palkka maaliskuu",
      },
      {
        row: 4,
        bookingDate: "2026-03-09",
        valueDate: null,
        amountMinor: -4_200,
        currency: "EUR",
        counterparty: "Sähköyhtiö Esimerkki Oy",
        description: "E-lasku",
      },
    ]);
    // A card reservation has no booking day yet.
    expect(parsed.errors).toEqual([
      { row: 5, message: expect.stringMatching(/pending reservation/) },
    ]);
  });

  it("finds the columns by name in any order and case", () => {
    const parsed = readBankCsv(
      encode1252(
        "VIESTI;määrä;SAAJA/MAKSAJA;kirjauspäivä\nOsto;-1,00;Kauppa Ä;1.2.2026\n",
      ),
    );
    expect(parsed.format).toBe("nordea");
    expect(parsed.rows).toEqual([
      {
        row: 2,
        bookingDate: "2026-02-01",
        valueDate: null,
        amountMinor: -100,
        currency: null,
        counterparty: "Kauppa Ä",
        description: "Osto",
      },
    ]);
  });
});

describe("readBankCsv: S-Pankki", () => {
  it("reads the Windows-1252, semicolon export with quoted messages", () => {
    const parsed = readBankCsv(fixture("s-pankki.csv"));
    expect(parsed).toMatchObject({
      format: "s-pankki",
      encoding: "windows-1252",
      delimiter: ";",
      rowsRead: 5,
      errors: [],
    });
    expect(
      parsed.rows.map((row) => [
        row.row,
        row.bookingDate,
        row.valueDate,
        row.amountMinor,
        row.counterparty,
        row.description,
      ]),
    ).toEqual([
      [
        2,
        "2026-02-03",
        "2026-02-03",
        -2_340,
        "S-Market Esimerkki",
        "KORTTIOSTO",
      ],
      [
        3,
        "2026-02-10",
        "2026-02-10",
        15_000,
        "Matti Meikäläinen",
        'Lainan lyhennys; kiitos "pikaisesta"',
      ],
      [
        4,
        "2026-02-14",
        "2026-02-14",
        -100_000,
        "Säästötili Esimerkki",
        "Säästö",
      ],
      // A message over two lines is one row; whitespace runs become a space.
      [
        5,
        "2026-02-14",
        "2026-02-14",
        -800,
        "Pysäköinti Esimerkki",
        "Rivi yksi rivi kaksi",
      ],
      // The row after it starts on line 7.
      [
        7,
        "2026-02-28",
        "2026-02-27",
        -5_999,
        "Sähköyhtiö Esimerkki Oy",
        "E-LASKU",
      ],
    ]);
  });

  it("reports unreadable rows by line and still reads the rest", () => {
    const parsed = readBankCsv(fixture("s-pankki-errors.csv"));
    expect(parsed.format).toBe("s-pankki");
    expect(parsed.rowsRead).toBe(5);
    expect(parsed.rows.map((row) => [row.row, row.amountMinor])).toEqual([
      [2, -1_000],
      [6, 2_000],
    ]);
    expect(parsed.errors).toEqual([
      { row: 3, message: 'Invalid booking date: "31.02.2026"' },
      { row: 4, message: 'Not an amount: "kymmenen"' },
      { row: 5, message: "The amount is empty" },
    ]);
  });

  it("rejects rows with more columns than the header", () => {
    const parsed = readBankCsv(
      encode1252("Kirjauspäivä;Summa;Viesti\n1.2.2026;-1,00;a;extra\n"),
    );
    expect(parsed.errors).toEqual([
      { row: 2, message: "Expected 3 columns, found 4" },
    ]);
  });
});

describe("readBankCsv: format choice and generic CSV", () => {
  it("refuses a file that is not the chosen bank's export", () => {
    expect(() =>
      readBankCsv(fixture("s-pankki.csv"), { format: "nordea" }),
    ).toThrow(CsvFormatError);
    expect(() =>
      readBankCsv(fixture("generic.csv"), { format: "s-pankki" }),
    ).toThrow(/not a S-Pankki export/);
  });

  it("refuses an empty file and one without columns", () => {
    expect(() => readBankCsv(new Uint8Array())).toThrow(/empty/);
    expect(() => readBankCsv(encode1252("just\ntext\n"))).toThrow(
      /No header row/,
    );
    expect(() => readBankCsv(encode1252('a;b\n"open'))).toThrow(CsvFormatError);
  });

  it("reads an unknown layout with the guessed columns", () => {
    const parsed = readBankCsv(fixture("generic.csv"));
    expect(parsed).toMatchObject({
      format: "generic",
      delimiter: ",",
      headers: ["Date", "Amount", "Payee", "Memo", "Balance"],
      mapping: {
        bookingDate: "Date",
        amount: "Amount",
        counterparty: "Payee",
        description: "Memo",
      },
      needsMapping: false,
      rowsRead: 4,
    });
    expect(parsed.rows).toEqual([
      {
        row: 2,
        bookingDate: "2026-04-01",
        valueDate: null,
        amountMinor: -1_234,
        currency: null,
        counterparty: "Example Shop",
        description: "Groceries, weekly",
      },
      {
        row: 3,
        bookingDate: "2026-04-02",
        valueDate: null,
        amountMinor: 123_456,
        currency: null,
        counterparty: "Example Employer",
        description: "Salary",
      },
      {
        row: 4,
        bookingDate: "2026-04-03",
        valueDate: null,
        amountMinor: -350,
        currency: null,
        counterparty: "Example Cafe",
        description: "Coffee",
      },
    ]);
    expect(parsed.errors).toEqual([
      { row: 5, message: 'Unrecognised booking date: "not a date"' },
    ]);
  });

  it("uses the chosen columns, also for a bank export read as generic", () => {
    const parsed = readBankCsv(fixture("generic.csv"), {
      format: "generic",
      mapping: {
        amount: "Balance",
        counterparty: "Memo",
        description: null,
      },
    });
    expect(parsed.rows[0]).toMatchObject({
      amountMinor: 98_766,
      counterparty: "Groceries, weekly",
      description: null,
    });

    const nordea = readBankCsv(fixture("nordea.csv"), {
      format: "generic",
      mapping: { counterparty: "Tapahtuma", description: "" },
    });
    expect(nordea.format).toBe("generic");
    expect(nordea.mapping).toEqual({
      bookingDate: "Kirjauspäivä",
      amount: "Määrä",
      counterparty: "Tapahtuma",
      description: null,
    });
    expect(nordea.rows[0]).toMatchObject({
      amountMinor: -95_000,
      counterparty: "Tilisiirto",
      description: null,
    });
  });

  it("asks for a mapping when the date or amount column is unknown", () => {
    const parsed = readBankCsv(encode1252("When;How much\n1.2.2026;5,00\n"));
    expect(parsed).toMatchObject({
      format: "generic",
      needsMapping: true,
      mapping: { bookingDate: null, amount: null },
      rowsRead: 1,
      rows: [],
      errors: [],
    });
    const mapped = readBankCsv(encode1252("When;How much\n1.2.2026;5,00\n"), {
      mapping: { bookingDate: "When", amount: "How much" },
    });
    expect(mapped.rows).toMatchObject([
      { bookingDate: "2026-02-01", amountMinor: 500 },
    ]);
  });

  it("refuses a mapping to a column the file does not have", () => {
    expect(() =>
      readBankCsv(fixture("generic.csv"), { mapping: { amount: "Summa" } }),
    ).toThrow(/no column "Summa"/);
  });

  it("guesses Finnish and English header names", () => {
    expect(guessMapping(["Päivämäärä", "Summa", "Nimi", "Selite"])).toEqual({
      bookingDate: "Päivämäärä",
      amount: "Summa",
      counterparty: "Nimi",
      description: "Selite",
    });
    expect(guessMapping(["x", "y"])).toEqual({
      bookingDate: null,
      amount: null,
      counterparty: null,
      description: null,
    });
  });
});
