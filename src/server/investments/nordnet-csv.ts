import {
  CSV_DELIMITERS,
  parseCsv,
  type CsvDelimiter,
} from "@/server/csv/parse";
import { decodeCsv, parseCsvDate, type CsvEncoding } from "@/server/csv/values";
import type { investmentTransactionType } from "@/server/db/schema";
import type {
  CurrencyCode,
  IsoDate,
  ProviderAssetClass,
} from "@/server/providers/types";
import {
  currencyExponent,
  divideRounded,
  formatDecimal,
  parseDecimal,
  pow10,
  SCALE_FACTOR,
} from "./decimal";

// Reads a Nordnet transaction export (Sivuni → Tapahtumat ja laskelmat →
// Vie CSV-tiedostoon; F-020, D-017) into investment transactions. Nordnet
// does not document the layout and it varies by language and over time, so
// the columns are found by their header names (Finnish, English or Swedish),
// the encoding (UTF-16, UTF-8 or Windows-1252) and the delimiter (tab, `;`
// or `,`) are detected, and a `Valuutta` column belongs to the value column
// before it. Rows that cannot be read are errors with their file line;
// cancelled rows and currency exchanges are skipped.

export type InvestmentTransactionType =
  (typeof investmentTransactionType.enumValues)[number];

/** Header names per field, compared trimmed, lower-cased, NFC. */
const HEADERS = {
  id: ["id"],
  bookingDate: ["kirjauspäivä", "booking day", "booking date", "bokföringsdag"],
  tradeDate: ["kauppapäivä", "trade day", "trade date", "affärsdag"],
  portfolio: ["salkku", "portfolio", "depå", "tili", "account"],
  type: ["tapahtumatyyppi", "transaction type", "transaktionstyp"],
  security: ["arvopaperi", "security", "värdepapper"],
  securityName: ["arvopaperin nimi", "security name"],
  instrumentType: ["instrumenttityyppi", "instrument type", "instrumenttyp"],
  isin: ["isin"],
  quantity: ["määrä", "quantity", "antal"],
  price: ["kurssi", "price", "kurs"],
  fees: ["kokonaiskulut", "total fees", "total avgift"],
  amount: ["summa", "amount", "belopp"],
  text: ["tapahtumateksti", "transaction text", "transaktionstext"],
  cancelled: ["mitätöintipäivä", "cancellation date", "makuleringsdatum"],
} as const;

type Field = keyof typeof HEADERS;

const CURRENCY_HEADERS = new Set(["valuutta", "currency", "valuta"]);

/** What a Nordnet transaction type means; null = not recorded (skipped). */
type Kind =
  | "buy"
  | "sell"
  | "dividend"
  | "tax"
  | "fee"
  | "deposit"
  | "withdrawal"
  | "interest"
  | "loan_interest"
  | null;

const TYPES: Record<string, Kind> = {
  OSTO: "buy",
  MERKINTÄ: "buy",
  BUY: "buy",
  KÖPT: "buy",
  MYYNTI: "sell",
  LUNASTUS: "sell",
  SELL: "sell",
  SÅLT: "sell",
  OSINKO: "dividend",
  DIVIDEND: "dividend",
  UTDELNING: "dividend",
  ENNAKKOPIDÄTYS: "tax",
  LÄHDEVERO: "tax",
  VERO: "tax",
  TAX: "tax",
  "WITHHOLDING TAX": "tax",
  KUPONGSKATT: "tax",
  PALKKIO: "fee",
  VÄLITYSPALKKIO: "fee",
  HALLINNOINTIPALKKIO: "fee",
  MAKSU: "fee",
  FEE: "fee",
  AVGIFT: "fee",
  TALLETUS: "deposit",
  DEPOSIT: "deposit",
  INSÄTTNING: "deposit",
  NOSTO: "withdrawal",
  WITHDRAWAL: "withdrawal",
  UTTAG: "withdrawal",
  KORKO: "interest",
  TALLETUSKORKO: "interest",
  INTEREST: "interest",
  RÄNTA: "interest",
  LAINAKORKO: "loan_interest",
  // Moves cash between the account's currencies; nothing enters or leaves.
  VALUUTANVAIHTO: null,
  "VALUUTAN OSTO": null,
  "VALUUTAN MYYNTI": null,
  "CURRENCY EXCHANGE": null,
  VALUTAVÄXLING: null,
};

/** Cash-flow sign by kind: buys, costs and withdrawals take money out. */
const AMOUNT_SIGN: Record<Exclude<Kind, null | "interest">, 1 | -1> = {
  buy: -1,
  sell: 1,
  dividend: 1,
  tax: -1,
  fee: -1,
  deposit: 1,
  withdrawal: -1,
  loan_interest: -1,
};

export interface NordnetSecurity {
  /** The `Arvopaperi` cell: Nordnet's short name (a ticker for most stocks). */
  symbol: string;
  name: string | null;
  isin: string | null;
  assetClass: ProviderAssetClass;
  /** The price's currency, which the asset is quoted in. */
  currency: CurrencyCode;
}

export interface NordnetRow {
  /** The file line the row starts on. */
  row: number;
  /** Nordnet's transaction id (`Id`); null when the file has none. */
  ref: string | null;
  /** The `Salkku` (account number); null when the file has no such column. */
  portfolio: string | null;
  type: InvestmentTransactionType;
  /** The transaction type as Nordnet wrote it, e.g. `OSTO`. */
  nordnetType: string;
  tradeDate: IsoDate;
  security: NordnetSecurity | null;
  /** Signed change in units held (buys +, sells −); null otherwise. */
  quantity: string | null;
  /** Unit price in minor units of the security's currency (buys, sells). */
  priceMinor: string | null;
  /** Signed cash effect in integer minor units of `currency`. */
  amountMinor: number;
  currency: CurrencyCode;
  description: string | null;
}

export interface NordnetRowNote {
  row: number;
  message: string;
}

export interface ParsedNordnetCsv {
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
  /** Data rows below the header (blank lines not counted). */
  rowsRead: number;
  rows: NordnetRow[];
  /** Rows deliberately not recorded (cancelled, currency exchange). */
  skipped: NordnetRowNote[];
  errors: NordnetRowNote[];
}

/** The file as a whole is not a Nordnet export. */
export class NordnetFormatError extends Error {
  override readonly name = "NordnetFormatError";
}

function headerKey(value: string): string {
  return value.replace(/^﻿/, "").normalize("NFC").trim().toLowerCase();
}

/**
 * A Nordnet number cell as a canonical decimal string. The comma is the
 * decimal separator (`3,235` is 3.235); spaces group thousands; a point
 * alone is a decimal point, beside a comma a thousands separator.
 */
export function parseNordnetDecimal(value: string): string {
  let compact = value.replace(/[\s  ']/g, "").replace("−", "-");
  if (compact.includes(",")) compact = compact.replace(/\./g, "");
  compact = compact.replace(",", ".");
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(compact)) {
    throw new Error(`Not a number: ${JSON.stringify(value)}`);
  }
  return formatDecimal(parseDecimal(compact.replace(/^\+/, "")));
}

/** A decimal in major units as minor units of `currency`, exact. */
function toMinorDecimal(decimal: string, currency: CurrencyCode): string {
  return formatDecimal(
    parseDecimal(decimal) * pow10(currencyExponent(currency)),
  );
}

/** A decimal in major units as integer minor units, rounded half away. */
function toMinorUnits(decimal: string, currency: CurrencyCode): number {
  const units = divideRounded(
    parseDecimal(decimal) * pow10(currencyExponent(currency)),
    SCALE_FACTOR,
  );
  const result = Number(units);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`Amount out of range: ${decimal}`);
  }
  return result === 0 ? 0 : result;
}

function absolute(decimal: string): string {
  return decimal.replace(/^-/, "");
}

function negate(decimal: string): string {
  return decimal.startsWith("-") || decimal === "0" ? decimal : `-${decimal}`;
}

function assetClass(instrumentType: string | null): ProviderAssetClass {
  const type = instrumentType?.toLowerCase() ?? "";
  if (/etf|pörssinoteerattu/.test(type)) return "etf";
  if (/rahasto|fund|fond/.test(type)) return "fund";
  return "stock";
}

interface Layout {
  /** Column index of each field found. */
  columns: Partial<Record<Field, number>>;
  /** Column index of the currency belonging to each value column. */
  currencies: Map<number, number>;
}

function findLayout(cells: readonly string[]): Layout | null {
  const keys = cells.map(headerKey);
  const columns: Partial<Record<Field, number>> = {};
  for (const field of Object.keys(HEADERS) as Field[]) {
    const index = keys.findIndex((key) =>
      (HEADERS[field] as readonly string[]).includes(key),
    );
    if (index >= 0) columns[field] = index;
  }
  if (
    columns.type === undefined ||
    columns.amount === undefined ||
    (columns.tradeDate === undefined && columns.bookingDate === undefined)
  ) {
    return null;
  }
  const currencies = new Map<number, number>();
  let owner = -1;
  keys.forEach((key, index) => {
    if (CURRENCY_HEADERS.has(key)) {
      if (owner >= 0 && !currencies.has(owner)) currencies.set(owner, index);
    } else {
      owner = index;
    }
  });
  return { columns, currencies };
}

function currencyCode(value: string | null, what: string): CurrencyCode | null {
  const code = value?.trim().toUpperCase() || null;
  if (code !== null && !/^[A-Z]{3}$/.test(code)) {
    throw new Error(
      `Not a currency code for the ${what}: ${JSON.stringify(value)}`,
    );
  }
  return code;
}

type Read =
  | { kind: "row"; row: Omit<NordnetRow, "row"> }
  | { kind: "skipped"; message: string };

function readRecord(cells: readonly string[], layout: Layout): Read {
  const at = (index: number | undefined): string | null => {
    if (index === undefined) return null;
    const value = cells[index]?.replace(/\s+/g, " ").trim() ?? "";
    return value === "" ? null : value;
  };
  const cell = (field: Field) => at(layout.columns[field]);
  const currencyOf = (field: Field) => {
    const column = layout.columns[field];
    return column === undefined ? null : at(layout.currencies.get(column));
  };

  const nordnetType = cell("type")?.normalize("NFC").toUpperCase() ?? null;
  if (nordnetType === null) throw new Error("The transaction type is empty");
  const cancelled = cell("cancelled");
  if (cancelled !== null) {
    return {
      kind: "skipped",
      message: `${nordnetType}: cancelled (${cancelled})`,
    };
  }
  if (!(nordnetType in TYPES)) {
    throw new Error(
      `Unsupported transaction type ${JSON.stringify(nordnetType)}`,
    );
  }
  const kind = TYPES[nordnetType];
  if (kind === null) {
    return {
      kind: "skipped",
      message: `${nordnetType}: a currency exchange inside the account is not recorded`,
    };
  }

  const dateCell = cell("tradeDate") ?? cell("bookingDate");
  if (dateCell === null) throw new Error("The trade date is empty");
  const tradeDate = parseCsvDate(dateCell);

  const amountCell = cell("amount");
  if (amountCell === null) throw new Error("The amount is empty");
  const amount = parseNordnetDecimal(amountCell);
  const currency =
    currencyCode(currencyOf("amount"), "amount") ??
    currencyCode(currencyOf("fees"), "amount");
  if (currency === null) throw new Error("The amount has no currency");
  const signed =
    kind === "interest"
      ? amount
      : AMOUNT_SIGN[kind] < 0
        ? negate(absolute(amount))
        : absolute(amount);
  const amountMinor = toMinorUnits(signed, currency);

  const symbol = cell("security");
  const isin = cell("isin")?.toUpperCase() ?? null;
  if (isin !== null && !/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) {
    throw new Error(`Not an ISIN: ${JSON.stringify(isin)}`);
  }
  const trade = kind === "buy" || kind === "sell";
  if (trade && symbol === null && isin === null) {
    throw new Error(`${nordnetType} without a security`);
  }
  const priceCurrency =
    currencyCode(currencyOf("price"), "price") ??
    currencyCode(currencyOf("fees"), "price") ??
    currency;
  const security: NordnetSecurity | null =
    symbol !== null || isin !== null
      ? {
          symbol: symbol ?? isin!,
          name: cell("securityName"),
          isin,
          assetClass: assetClass(cell("instrumentType")),
          currency: priceCurrency,
        }
      : null;

  let quantity: string | null = null;
  let priceMinor: string | null = null;
  if (trade) {
    const quantityCell = cell("quantity");
    if (quantityCell === null) throw new Error("The quantity is empty");
    const units = absolute(parseNordnetDecimal(quantityCell));
    if (units === "0") throw new Error("The quantity is zero");
    quantity = kind === "sell" ? negate(units) : units;
    const priceCell = cell("price");
    priceMinor =
      priceCell === null
        ? null
        : toMinorDecimal(
            absolute(parseNordnetDecimal(priceCell)),
            priceCurrency,
          );
  }

  const type: InvestmentTransactionType =
    kind === "buy" || kind === "sell" || kind === "dividend" || kind === "fee"
      ? kind
      : kind === "tax" || kind === "loan_interest"
        ? "fee"
        : kind === "interest"
          ? amountMinor < 0
            ? "fee"
            : "dividend"
          : "transfer";

  return {
    kind: "row",
    row: {
      ref: cell("id"),
      portfolio: cell("portfolio"),
      type,
      nordnetType,
      tradeDate,
      security,
      quantity,
      priceMinor,
      amountMinor,
      currency,
      description: cell("text"),
    },
  };
}

/** Reads an uploaded Nordnet export; throws `NordnetFormatError` if it is none. */
export function readNordnetCsv(bytes: Uint8Array): ParsedNordnetCsv {
  const { text, encoding } = decodeCsv(bytes);
  for (const delimiter of ["\t", ...CSV_DELIMITERS.filter((d) => d !== "\t")]) {
    let records;
    try {
      records = parseCsv(text, delimiter);
    } catch {
      continue;
    }
    const headerIndex = records.findIndex((record) => findLayout(record.cells));
    if (headerIndex < 0) continue;
    const layout = findLayout(records[headerIndex].cells)!;
    const width = records[headerIndex].cells.length;
    const data = records.slice(headerIndex + 1);
    const rows: NordnetRow[] = [];
    const skipped: NordnetRowNote[] = [];
    const errors: NordnetRowNote[] = [];
    for (const record of data) {
      const extra = record.cells.slice(width).some((c) => c.trim() !== "");
      if (extra) {
        errors.push({
          row: record.line,
          message: `Expected ${width} columns, found ${record.cells.length}`,
        });
        continue;
      }
      try {
        const read = readRecord(record.cells, layout);
        if (read.kind === "row") rows.push({ row: record.line, ...read.row });
        else skipped.push({ row: record.line, message: read.message });
      } catch (error) {
        errors.push({
          row: record.line,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      encoding,
      delimiter: delimiter as CsvDelimiter,
      rowsRead: data.length,
      rows,
      skipped,
      errors,
    };
  }
  if (text.trim() === "") throw new NordnetFormatError("The file is empty.");
  throw new NordnetFormatError(
    "This is not a Nordnet transaction export: no header row with Tapahtumatyyppi, Summa and a date was found.",
  );
}
