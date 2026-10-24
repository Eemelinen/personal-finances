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
// a file with unreadable rows, and (`*-2026.csv`) the headers and quoting
// of real October 2026 S-Pankki, Nordea netbank and Nordea card exports.

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
        counterpartyIban: null,
        ref: null,
      },
      {
        row: 5,
        bookingDate: "2026-01-05",
        valueDate: "2026-01-05",
        amountMinor: -450,
        currency: null,
        counterparty: "Kahvila Määränpää",
        description: "Korttiosto",
        counterpartyIban: null,
        ref: null,
      },
      {
        row: 6,
        bookingDate: "2026-01-05",
        valueDate: "2026-01-05",
        amountMinor: -450,
        currency: null,
        counterparty: "Kahvila Määränpää",
        description: "Korttiosto",
        counterpartyIban: null,
        ref: null,
      },
      {
        row: 7,
        bookingDate: "2026-01-15",
        valueDate: "2026-01-15",
        amountMinor: 350_000,
        currency: null,
        counterparty: "Esimerkki Työnantaja Oy",
        description: "Palkka tammikuu",
        counterpartyIban: null,
        ref: null,
      },
      {
        row: 8,
        bookingDate: "2026-01-20",
        valueDate: "2026-01-20",
        amountMinor: -123_456,
        currency: null,
        counterparty: "Lähikauppa Öljymäki",
        description: "Korttiosto",
        counterpartyIban: null,
        ref: null,
      },
      {
        row: 9,
        bookingDate: "2026-01-31",
        valueDate: "2026-01-31",
        amountMinor: -1_290,
        currency: null,
        counterparty: "Äänikirjapalvelu Esimerkki",
        description: "Kuukausimaksu 12,90 € – ½ hinnalla",
        counterpartyIban: null,
        ref: null,
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
        counterpartyIban: null,
        ref: null,
      },
      {
        row: 3,
        bookingDate: "2026-03-05",
        valueDate: null,
        amountMinor: 250_000,
        currency: "EUR",
        counterparty: "Esimerkki Työnantaja Oy",
        description: "Palkka maaliskuu",
        counterpartyIban: null,
        ref: null,
      },
      {
        row: 4,
        bookingDate: "2026-03-09",
        valueDate: null,
        amountMinor: -4_200,
        currency: "EUR",
        counterparty: "Sähköyhtiö Esimerkki Oy",
        description: "E-lasku",
        counterpartyIban: null,
        ref: null,
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
        counterpartyIban: null,
        ref: null,
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

// The layouts of real October 2026 exports (F-031), with made-up rows.
describe("readBankCsv: real S-Pankki export", () => {
  it("unwraps quoted cells, empties placeholders and keeps the archive id", () => {
    const parsed = readBankCsv(fixture("s-pankki-2026.csv"));
    expect(parsed).toMatchObject({
      format: "s-pankki",
      encoding: "utf-8",
      delimiter: ";",
      rowsRead: 4,
      repeated: 0,
      errors: [],
    });
    expect(parsed.rows).toEqual([
      {
        row: 2,
        bookingDate: "2026-10-01",
        valueDate: "2026-10-01",
        amountMinor: -2_340,
        currency: null,
        counterparty: "S-MARKET ESIMERKKI",
        // `-` in the account and message columns is empty.
        counterpartyIban: null,
        description: "KORTTIOSTO",
        ref: "20261001TEST00000001",
      },
      {
        row: 3,
        bookingDate: "2026-10-03",
        valueDate: "2026-10-03",
        amountMinor: 15_000,
        currency: null,
        counterparty: "MAIJA ESIMERKKI",
        // Money in: the account column is the receiving (own) account.
        counterpartyIban: null,
        description: "Wedding gift",
        ref: "20261003TEST00000002",
      },
      {
        row: 4,
        bookingDate: "2026-10-05",
        valueDate: "2026-10-05",
        amountMinor: -100_000,
        currency: null,
        counterparty: "SÄÄSTÖTILI ESIMERKKI",
        counterpartyIban: "FI5939000000000006",
        description: "Säästö lokakuu",
        ref: "20261005TEST00000003",
      },
      {
        row: 5,
        bookingDate: "2026-10-09",
        valueDate: "2026-10-08",
        amountMinor: -5_999,
        currency: null,
        counterparty: "SÄHKÖYHTIÖ ESIMERKKI OY",
        counterpartyIban: "FI3210000000000002",
        // `'-'` is empty too, so the transaction type is the text.
        description: "E-LASKU",
        ref: "20261009TEST00000004",
      },
    ]);
  });

  it("reads the same layout in Windows-1252", () => {
    const parsed = readBankCsv(
      encode1252(
        "Kirjauspäivä;Maksupäivä;Summa;Tapahtumalaji;Maksaja;Saajan nimi;Saajan tilinumero;Saajan BIC-tunnus;Viitenumero;Viesti;Arkistointitunnus\r\n" +
          "01.10.2026;01.10.2026;-5,00;TILISIIRTO;TESTI HENKILÖ;'Kioski Ä';'fi59 3900 0000 0000 06 ';'-';-;'';'20261001TEST00000009'\r\n",
      ),
    );
    expect(parsed.encoding).toBe("windows-1252");
    expect(parsed.rows).toMatchObject([
      {
        counterparty: "Kioski Ä",
        counterpartyIban: "FI5939000000000006",
        description: "TILISIIRTO",
        ref: "20261001TEST00000009",
      },
    ]);
  });
});

describe("readBankCsv: real Nordea netbank export", () => {
  it("reads account numbers as IBANs and drops lines the export repeats", () => {
    const parsed = readBankCsv(fixture("nordea-2026.csv"));
    expect(parsed).toMatchObject({
      format: "nordea",
      encoding: "utf-8",
      delimiter: ";",
      headers: [
        "Kirjauspäivä",
        "Määrä",
        "Maksaja",
        "Maksunsaaja",
        "Nimi",
        "Otsikko",
        "Viesti",
        "Viitenumero",
        "Saldo",
        "Valuutta",
      ],
      rowsRead: 8,
      repeated: 1,
      errors: [],
    });
    expect(parsed.rows).toEqual([
      {
        row: 2,
        bookingDate: "2026-10-01",
        valueDate: null,
        amountMinor: -1_520,
        currency: "EUR",
        // No name: a card purchase's title is the merchant.
        counterparty: "RAVINTOLA ESIMERKKI",
        counterpartyIban: null,
        description: null,
        ref: null,
      },
      {
        row: 3,
        bookingDate: "2026-10-02",
        valueDate: null,
        amountMinor: -95_000,
        currency: "EUR",
        counterparty: "Esimerkki Asunnot Oy",
        counterpartyIban: "FI0510000000000003",
        description: "Vuokra lokakuu",
        ref: null,
      },
      {
        row: 4,
        bookingDate: "2026-10-05",
        valueDate: null,
        amountMinor: 250_000,
        currency: "EUR",
        counterparty: "Esimerkki Työnantaja Oy",
        // Money in: the payer's account.
        counterpartyIban: "FI7510000000000004",
        description: "Palkka lokakuu",
        ref: null,
      },
      // Line 5 repeats line 4, balance included: one transaction.
      {
        row: 6,
        bookingDate: "2026-10-09",
        valueDate: null,
        amountMinor: -4_200,
        currency: "EUR",
        counterparty: "Sähköyhtiö Esimerkki Oy",
        counterpartyIban: "FI3210000000000002",
        description: "E-lasku",
        ref: null,
      },
      // Two equal coffees with different balances are two transactions.
      {
        row: 7,
        bookingDate: "2026-10-12",
        valueDate: null,
        amountMinor: -450,
        currency: "EUR",
        counterparty: "KAHVILA ESIMERKKI",
        counterpartyIban: null,
        description: null,
        ref: null,
      },
      {
        row: 8,
        bookingDate: "2026-10-12",
        valueDate: null,
        amountMinor: -450,
        currency: "EUR",
        counterparty: "KAHVILA ESIMERKKI",
        counterpartyIban: null,
        description: null,
        ref: null,
      },
      {
        row: 9,
        bookingDate: "2026-10-15",
        valueDate: null,
        amountMinor: -20_000,
        currency: "EUR",
        // `Tilisiirto` is the kind of payment, not a name.
        counterparty: null,
        counterpartyIban: "FI3239000000000007",
        description: "Säästöön",
        ref: null,
      },
    ]);
  });

  it("never takes an account number column as the counterparty", () => {
    const parsed = readBankCsv(
      encode1252(
        "Kirjauspäivä;Määrä;Maksaja;Maksunsaaja;Nimi;Otsikko;Viesti;Viitenumero;Saldo;Valuutta;\r\n" +
          "2026/10/03;-10,00;FI59 1000 0000 0000 01;FI05 1000 0000 0000 03;;TILISIIRTO;;;90,00;EUR;\r\n",
      ),
    );
    expect(parsed.rows).toMatchObject([
      {
        counterparty: null,
        counterpartyIban: "FI0510000000000003",
        description: "TILISIIRTO",
      },
    ]);
  });
});

describe("readBankCsv: Nordea credit card export", () => {
  it("reads quoted cells, decimal points and the purchase day", () => {
    const parsed = readBankCsv(fixture("nordea-card-2026.csv"));
    expect(parsed).toMatchObject({
      format: "nordea-card",
      encoding: "utf-8",
      delimiter: ";",
      rowsRead: 4,
      repeated: 0,
    });
    expect(parsed.rows).toEqual([
      {
        row: 2,
        bookingDate: "2026-10-01",
        valueDate: "2026-09-30",
        amountMinor: -2_345,
        currency: "EUR",
        counterparty: null,
        counterpartyIban: null,
        description: "K-MARKET ESIMERKKI",
        ref: null,
      },
      {
        row: 3,
        bookingDate: "2026-10-05",
        valueDate: "2026-10-02",
        // The EUR amount, not the original 50.00 USD.
        amountMinor: -4_612,
        currency: "EUR",
        counterparty: null,
        counterpartyIban: null,
        description: "EXAMPLE STORE, NEW YORK",
        ref: null,
      },
      {
        row: 4,
        bookingDate: "2026-10-10",
        valueDate: "2026-10-10",
        amountMinor: 50_000,
        currency: "EUR",
        counterparty: null,
        counterpartyIban: null,
        description: "Maksu, kiitos",
        ref: null,
      },
    ]);
    expect(parsed.errors).toEqual([
      { row: 5, message: expect.stringMatching(/not booked yet/) },
    ]);
  });

  it("is its own format: a Nordea netbank choice refuses it", () => {
    expect(() =>
      readBankCsv(fixture("nordea-card-2026.csv"), { format: "nordea" }),
    ).toThrow(/not a Nordea export/);
    expect(
      readBankCsv(fixture("nordea-card-2026.csv"), { format: "nordea-card" })
        .rows,
    ).toHaveLength(3);
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
        counterpartyIban: null,
        ref: null,
      },
      {
        row: 3,
        bookingDate: "2026-04-02",
        valueDate: null,
        amountMinor: 123_456,
        currency: null,
        counterparty: "Example Employer",
        description: "Salary",
        counterpartyIban: null,
        ref: null,
      },
      {
        row: 4,
        bookingDate: "2026-04-03",
        valueDate: null,
        amountMinor: -350,
        currency: null,
        counterparty: "Example Cafe",
        description: "Coffee",
        counterpartyIban: null,
        ref: null,
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
