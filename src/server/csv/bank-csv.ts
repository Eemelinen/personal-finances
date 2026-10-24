import { normalizeIban, parseIban } from "@/server/iban";
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
// error with its line number, the rest are still read. The layouts were
// checked against real October 2026 exports (F-031, D-011 amendment).

export const CSV_FORMATS = [
  "nordea",
  "nordea-card",
  "s-pankki",
  "generic",
] as const;
export type CsvFormat = (typeof CSV_FORMATS)[number];

export const CSV_FORMAT_LABELS: Record<CsvFormat, string> = {
  nordea: "Nordea",
  "nordea-card": "Nordea credit card",
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
  /** The other side's account number, normalised. */
  counterpartyIban: string | null;
  description: string | null;
  /** The bank's id of the transaction (S-Pankki's `Arkistointitunnus`). */
  ref: string | null;
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
  /**
   * Lines the export repeats verbatim, balance included (a Nordea export
   * with `Saldo`): read once, these copies are left out of `rows`.
   */
  repeated: number;
  rows: CsvRow[];
  errors: CsvRowError[];
}

/** The file as a whole cannot be read (no header, wrong format, …). */
export class CsvFormatError extends Error {
  override readonly name = "CsvFormatError";
}

export interface ReadCsvOptions {
  /** `auto` (the default) recognises the bank layouts, else generic. */
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
  counterpartyIban?: (amountMinor: number) => string | null;
  description: string | null;
  ref?: string | null;
  /** What an empty booking date means (a card purchase not booked yet). */
  undatedMessage?: string;
}

interface BankLayout {
  required: string[];
  /** Cleans a non-empty, trimmed cell before it is read; null is empty. */
  clean?: (value: string) => string | null;
  /** Lines identical in every cell are one line repeated by the export. */
  dropsRepeatedLines?: (headers: Set<string>) => boolean;
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
 * Nordea's `Otsikko` names the kind of payment rather than the other party
 * for these (compared case-insensitively); a card purchase's `Otsikko` is
 * the merchant.
 */
const GENERIC_TITLES = new Set([
  "tilisiirto",
  "pikasiirto",
  "oma siirto",
  "viitesiirto",
  "e-lasku",
  "e-maksu",
  "suoramaksu",
  "verkkomaksu",
  "korttiosto",
  "maksu",
]);

function nordeaCounterparty(cell: Cell): string | null {
  const title = cell("otsikko");
  return (
    firstOf(cell, "saaja/maksaja", "nimi") ??
    (title !== null && !GENERIC_TITLES.has(title.toLowerCase()) ? title : null)
  );
}

/** A single-quoted S-Pankki cell (`'Wedding gift'`) unwrapped; `-` is empty. */
function cleanSPankkiCell(value: string): string | null {
  const unwrapped = /^'([\s\S]*)'$/.exec(value)?.[1].trim() ?? value;
  return unwrapped === "" || unwrapped === "-" ? null : unwrapped;
}

/**
 * The bank layouts, matched in this order (the card export also has
 * `Kirjauspäivä` and `Määrä`).
 *
 * Nordea credit card: `Tapahtumapäivä` (value date), `Kirjauspäivä`,
 * `Otsikko` (the text), `Määrä` in EUR with a decimal point (a purchase in
 * another currency has its own amount in `Alkuperäinen määrä`), `Valuutta`;
 * no counterparty.
 *
 * Nordea netbank: `Kirjauspäivä` (`yyyy/mm/dd`), `Määrä`, `Maksaja` and
 * `Maksunsaaja` holding account numbers (the other side's one, `Maksunsaaja`
 * for money out and `Maksaja` for money in, is the counterparty's IBAN), the
 * other party in `Nimi`, else `Otsikko` unless it is a payment kind, the
 * text in `Viesti`, else `Otsikko` (when it is not the counterparty), else
 * `Tapahtuma`, `Saldo`, `Valuutta`. An older layout's `Saaja/Maksaja` and
 * `Arvopäivä` are still read.
 *
 * S-Pankki: `Kirjauspäivä`, `Maksupäivä`, `Summa`, `Saajan nimi` for money
 * out and `Maksaja` for money in, `Saajan tilinumero` as the counterparty's
 * IBAN for money out (for money in it is the receiving, own account), the
 * text in `Viesti`, else `Tapahtumalaji`, and `Arkistointitunnus` as the
 * ref (the same id as the bank API's `entry_reference`).
 */
const BANK_LAYOUTS: Record<Exclude<CsvFormat, "generic">, BankLayout> = {
  "nordea-card": {
    required: ["tapahtumapäivä", "otsikko", "määrä"],
    read: (cell) => ({
      bookingDate: cell("kirjauspäivä"),
      valueDate: cell("tapahtumapäivä"),
      amount: cell("määrä"),
      currency: cell("valuutta"),
      counterparty: () => null,
      description: cell("otsikko"),
      undatedMessage:
        "A card purchase not booked yet: import it again once it is booked",
    }),
  },
  nordea: {
    required: ["kirjauspäivä", "määrä"],
    dropsRepeatedLines: (headers) => headers.has("saldo"),
    read: (cell) => {
      const counterparty = nordeaCounterparty(cell);
      const title = cell("otsikko");
      return {
        bookingDate: cell("kirjauspäivä"),
        valueDate: cell("arvopäivä"),
        amount: cell("määrä"),
        currency: cell("valuutta"),
        counterparty: () => counterparty,
        counterpartyIban: (amountMinor) =>
          parseIban(cell(amountMinor < 0 ? "maksunsaaja" : "maksaja")),
        description:
          cell("viesti") ??
          (title === counterparty ? null : title) ??
          cell("tapahtuma"),
      };
    },
  },
  "s-pankki": {
    required: ["kirjauspäivä", "summa"],
    clean: cleanSPankkiCell,
    read: (cell) => ({
      bookingDate: cell("kirjauspäivä"),
      valueDate: cell("maksupäivä"),
      amount: cell("summa"),
      currency: null,
      counterparty: (amountMinor) =>
        amountMinor < 0
          ? firstOf(cell, "saajan nimi", "maksaja")
          : firstOf(cell, "maksaja", "saajan nimi"),
      counterpartyIban: (amountMinor) => {
        const account = amountMinor < 0 ? cell("saajan tilinumero") : null;
        return account === null ? null : normalizeIban(account);
      },
      description: firstOf(cell, "viesti", "tapahtumalaji"),
      ref: cell("arkistointitunnus"),
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
    for (const format of ["nordea-card", "nordea", "s-pankki"] as const) {
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
  if (raw.bookingDate === null) {
    throw new Error(
      raw.valueDate !== null && raw.undatedMessage
        ? raw.undatedMessage
        : "The booking date is empty",
    );
  }
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
    counterpartyIban: raw.counterpartyIban?.(amountMinor) || null,
    description: text(raw.description),
    ref: text(raw.ref ?? null),
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
        repeated: 0,
        rows: [],
        errors: [],
      };
    }
  } else {
    layout = BANK_LAYOUTS[format].read;
  }
  const bank = format === "generic" ? null : BANK_LAYOUTS[format];
  const clean = bank?.clean ?? ((value: string) => value);
  const dropsRepeated =
    bank?.dropsRepeatedLines?.(new Set(columns.keys())) ?? false;

  const rows: CsvRow[] = [];
  const errors: CsvRowError[] = [];
  const seenLines = new Set<string>();
  let repeated = 0;
  for (const record of dataRecords) {
    if (dropsRepeated) {
      // The balance makes two real transactions differ; equal lines are one.
      const key = JSON.stringify(
        record.cells
          .slice(0, trimmedWidth(record.cells))
          .map((value) => value.trim()),
      );
      if (seenLines.has(key)) {
        repeated++;
        continue;
      }
      seenLines.add(key);
    }
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
      return value === "" ? null : clean(value);
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
    repeated,
    rows,
    errors,
  };
}
