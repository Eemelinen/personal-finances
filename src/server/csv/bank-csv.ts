import type { IsoDate } from "@/server/providers/types";
import {
  CSV_DELIMITERS,
  detectDelimiter,
  modalWidth,
  parseCsv,
  trimmedWidth,
  type CsvDelimiter,
  type CsvRecord,
} from "./parse";
import {
  decodeCsv,
  parseCsvAmount,
  parseCsvDate,
  type CsvEncoding,
} from "./values";

// Reads a netbank CSV export into normalised rows (F-012, D-011). The Nordea
// and S-Pankki layouts are recognised by their Finnish header names, so the
// column order, the delimiter (`;`, tab or `,`), preamble lines above the
// header and the encoding (UTF-8 or Windows-1252) may vary; any other CSV is
// read with a chosen column mapping. A row that cannot be read becomes an
// error with its line number, the rest are still read.

export const CSV_FORMATS = ["nordea", "s-pankki", "generic"] as const;
export type CsvFormat = (typeof CSV_FORMATS)[number];

export const CSV_FORMAT_LABELS: Record<CsvFormat, string> = {
  nordea: "Nordea",
  "s-pankki": "S-Pankki",
  generic: "Other CSV (choose the columns)",
};

export function isCsvFormat(value: string): value is CsvFormat {
  return (CSV_FORMATS as readonly string[]).includes(value);
}

/** The generic layout: header names of the columns to read. */
export interface ColumnMapping {
  bookingDate: string | null;
  amount: string | null;
  counterparty: string | null;
  description: string | null;
}

export const MAPPING_FIELDS = [
  "bookingDate",
  "amount",
  "counterparty",
  "description",
] as const satisfies readonly (keyof ColumnMapping)[];

/** One readable transaction row, before it is matched to an account. */
export interface CsvRow {
  /** The file line the row starts on. */
  row: number;
  bookingDate: IsoDate;
  valueDate: IsoDate | null;
  /** Signed integer minor units: negative is money out. */
  amountMinor: number;
  /** From a currency column; null when the file has none (the account's). */
  currency: string | null;
  counterparty: string | null;
  description: string | null;
}

export interface CsvRowError {
  row: number;
  message: string;
}

export interface ParsedCsv {
  format: CsvFormat;
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
  headers: string[];
  /** The generic layout's columns (null for the bank formats). */
  mapping: ColumnMapping | null;
  /** Generic layout without a date or amount column: nothing was read. */
  needsMapping: boolean;
  /** Data rows below the header (blank lines not counted). */
  rowsRead: number;
  rows: CsvRow[];
  errors: CsvRowError[];
}

/** The file as a whole cannot be read (no header, wrong format, …). */
export class CsvFormatError extends Error {
  override readonly name = "CsvFormatError";
}

export interface ReadCsvOptions {
  /** `auto` (the default) recognises Nordea and S-Pankki, else generic. */
  format?: CsvFormat | "auto";
  /** For `generic`; missing columns are guessed from the header names. */
  mapping?: Partial<ColumnMapping>;
}

/** Header names compare trimmed, case-insensitively, NFC-normalised. */
function headerKey(value: string): string {
  return value.replace(/^﻿/, "").normalize("NFC").trim().toLowerCase();
}

type Cell = (header: string) => string | null;

interface RawRow {
  bookingDate: string | null;
  valueDate: string | null;
  amount: string | null;
  currency: string | null;
  counterparty: (amountMinor: number) => string | null;
  description: string | null;
}

interface BankLayout {
  required: string[];
  read(cell: Cell): RawRow;
}

function firstOf(cell: Cell, ...headers: string[]): string | null {
  for (const header of headers) {
    const value = cell(header);
    if (value !== null) return value;
  }
  return null;
}

/**
 * The bank layouts. Nordea: `Kirjauspäivä`, `Arvopäivä`, `Määrä`, the other
 * party in `Saaja/Maksaja` (or `Maksunsaaja` for money out and `Maksaja` for
 * money in, else `Nimi`), the text in `Viesti` or `Otsikko`, else
 * `Tapahtuma`, an optional `Valuutta`. S-Pankki: `Kirjauspäivä`,
 * `Maksupäivä`, `Summa`, `Saajan nimi` for money out and `Maksaja` for money
 * in, the text in `Viesti`, else `Tapahtumalaji`.
 */
const BANK_LAYOUTS: Record<Exclude<CsvFormat, "generic">, BankLayout> = {
  nordea: {
    required: ["kirjauspäivä", "määrä"],
    read: (cell) => ({
      bookingDate: cell("kirjauspäivä"),
      valueDate: cell("arvopäivä"),
      amount: cell("määrä"),
      currency: cell("valuutta"),
      counterparty: (amountMinor) =>
        firstOf(
          cell,
          "saaja/maksaja",
          amountMinor < 0 ? "maksunsaaja" : "maksaja",
          "nimi",
        ),
      description: firstOf(cell, "viesti", "otsikko", "tapahtuma"),
    }),
  },
  "s-pankki": {
    required: ["kirjauspäivä", "summa"],
    read: (cell) => ({
      bookingDate: cell("kirjauspäivä"),
      valueDate: cell("maksupäivä"),
      amount: cell("summa"),
      currency: null,
      counterparty: (amountMinor) =>
        amountMinor < 0
          ? firstOf(cell, "saajan nimi", "maksaja")
          : firstOf(cell, "maksaja", "saajan nimi"),
      description: firstOf(cell, "viesti", "tapahtumalaji"),
    }),
  },
};

function matchesLayout(layout: BankLayout, headers: Set<string>): boolean {
  return layout.required.every((header) => headers.has(header));
}

const GUESSES: Record<keyof ColumnMapping, string[]> = {
  bookingDate: [
    "kirjauspäivä",
    "päivämäärä",
    "pvm",
    "booking date",
    "date",
    "datum",
  ],
  amount: ["määrä", "summa", "amount", "belopp", "sum"],
  counterparty: [
    "saaja/maksaja",
    "nimi",
    "counterparty",
    "payee",
    "name",
    "merchant",
  ],
  description: ["viesti", "selite", "description", "message", "memo", "text"],
};

/** Preselects generic columns by their header names (exact names only). */
export function guessMapping(headers: readonly string[]): ColumnMapping {
  const byKey = new Map(headers.map((header) => [headerKey(header), header]));
  const pick = (field: keyof ColumnMapping) =>
    GUESSES[field].map((name) => byKey.get(name)).find(Boolean) ?? null;
  return {
    bookingDate: pick("bookingDate"),
    amount: pick("amount"),
    counterparty: pick("counterparty"),
    description: pick("description"),
  };
}

function detectBankFormat(
  records: readonly CsvRecord[],
): { format: Exclude<CsvFormat, "generic">; headerIndex: number } | null {
  for (const [index, record] of records.entries()) {
    const headers = new Set(record.cells.map(headerKey));
    for (const format of ["nordea", "s-pankki"] as const) {
      if (matchesLayout(BANK_LAYOUTS[format], headers)) {
        return { format, headerIndex: index };
      }
    }
  }
  return null;
}

function tryParse(content: string, delimiter: string): CsvRecord[] | null {
  try {
    return parseCsv(content, delimiter);
  } catch {
    return null;
  }
}

function text(value: string | null): string | null {
  const trimmed = value?.replace(/\s+/g, " ").trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function parseValueDate(value: string): IsoDate {
  try {
    return parseCsvDate(value);
  } catch {
    throw new Error(`Unrecognised value date: ${JSON.stringify(value)}`);
  }
}

function readRow(raw: RawRow): Omit<CsvRow, "row"> {
  if (raw.bookingDate === null) throw new Error("The booking date is empty");
  if (raw.amount === null) throw new Error("The amount is empty");
  // Nordea lists card reservations with `Varaus` instead of a booking date.
  if (/^varaus$/i.test(raw.bookingDate)) {
    throw new Error(
      "A pending reservation (Varaus): import it again once it is booked",
    );
  }
  const bookingDate = parseCsvDate(raw.bookingDate);
  const amountMinor = parseCsvAmount(raw.amount);
  const currency = raw.currency?.trim().toUpperCase() || null;
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Not a currency code: ${JSON.stringify(raw.currency)}`);
  }
  return {
    bookingDate,
    valueDate: raw.valueDate === null ? null : parseValueDate(raw.valueDate),
    amountMinor,
    currency,
    counterparty: text(raw.counterparty(amountMinor)),
    description: text(raw.description),
  };
}

/** Reads an uploaded export; throws `CsvFormatError` for an unusable file. */
export function readBankCsv(
  bytes: Uint8Array,
  options: ReadCsvOptions = {},
): ParsedCsv {
  const { text: content, encoding } = decodeCsv(bytes);
  const requested = options.format ?? "auto";
  // A bank header settles the delimiter; otherwise the most regular one.
  let delimiter: CsvDelimiter | undefined;
  let records: CsvRecord[] = [];
  let detected: ReturnType<typeof detectBankFormat> = null;
  if (requested !== "generic") {
    for (const candidate of CSV_DELIMITERS) {
      const parsed = tryParse(content, candidate);
      detected = parsed && detectBankFormat(parsed);
      if (detected) {
        delimiter = candidate;
        records = parsed!;
        break;
      }
    }
  }
  if (delimiter === undefined) {
    delimiter = detectDelimiter(content);
    try {
      records = parseCsv(content, delimiter);
    } catch (error) {
      throw new CsvFormatError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (records.length === 0) throw new CsvFormatError("The file is empty.");
  if (requested !== "auto" && requested !== "generic") {
    if (detected?.format !== requested) {
      throw new CsvFormatError(
        `This is not a ${CSV_FORMAT_LABELS[requested]} export: its header row was not found.`,
      );
    }
  }
  const format: CsvFormat = detected?.format ?? "generic";

  let headerIndex: number;
  if (detected) {
    headerIndex = detected.headerIndex;
  } else {
    const { width } = modalWidth(records);
    headerIndex = records.findIndex((record) => record.cells.length === width);
    if (width === 0 || headerIndex < 0) {
      throw new CsvFormatError(
        "No header row found: the file needs at least two columns.",
      );
    }
  }

  const headers = records[headerIndex].cells
    .slice(0, trimmedWidth(records[headerIndex].cells))
    .map((header) => header.trim());
  const dataRecords = records.slice(headerIndex + 1);
  const columns = new Map<string, number>();
  headers.forEach((header, index) => {
    const key = headerKey(header);
    if (key !== "" && !columns.has(key)) columns.set(key, index);
  });

  let mapping: ColumnMapping | null = null;
  let layout: BankLayout["read"];
  if (format === "generic") {
    const guessed = guessMapping(headers);
    mapping = { ...guessed };
    for (const field of MAPPING_FIELDS) {
      if (options.mapping?.[field] === undefined) continue;
      const chosen = options.mapping[field]?.trim() || null;
      if (chosen !== null && !columns.has(headerKey(chosen))) {
        throw new CsvFormatError(
          `The file has no column ${JSON.stringify(chosen)}.`,
        );
      }
      mapping[field] = chosen;
    }
    const chosen = mapping;
    layout = (cell) => ({
      bookingDate: chosen.bookingDate && cell(chosen.bookingDate),
      valueDate: null,
      amount: chosen.amount && cell(chosen.amount),
      currency: null,
      counterparty: () => chosen.counterparty && cell(chosen.counterparty),
      description: chosen.description && cell(chosen.description),
    });
    if (mapping.bookingDate === null || mapping.amount === null) {
      return {
        format,
        encoding,
        delimiter,
        headers,
        mapping,
        needsMapping: true,
        rowsRead: dataRecords.length,
        rows: [],
        errors: [],
      };
    }
  } else {
    layout = BANK_LAYOUTS[format].read;
  }

  const rows: CsvRow[] = [];
  const errors: CsvRowError[] = [];
  for (const record of dataRecords) {
    if (trimmedWidth(record.cells) > headers.length) {
      errors.push({
        row: record.line,
        message: `Expected ${headers.length} columns, found ${trimmedWidth(record.cells)}`,
      });
      continue;
    }
    const cell: Cell = (header) => {
      const index = columns.get(headerKey(header));
      if (index === undefined) return null;
      const value = record.cells[index]?.trim() ?? "";
      return value === "" ? null : value;
    };
    try {
      rows.push({ row: record.line, ...readRow(layout(cell)) });
    } catch (error) {
      errors.push({
        row: record.line,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    format,
    encoding,
    delimiter,
    headers,
    mapping,
    needsMapping: false,
    rowsRead: dataRecords.length,
    rows,
    errors,
  };
}
