import { normaliseDate } from "@/server/dedupe-hash";
import type { IsoDate } from "@/server/providers/types";

// Decoding an uploaded file and reading Finnish-formatted cells (F-012):
// UTF-8, UTF-16 or Windows-1252 text, `-1 234,56` amounts, `dd.mm.yyyy`
// dates.

export type CsvEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

/**
 * Decodes an upload. UTF-16 when it starts with a UTF-16 byte order mark
 * (Nordnet exports, F-020); UTF-8 (with or without a byte order mark) when
 * the bytes are valid UTF-8, otherwise Windows-1252, which older netbank
 * exports use (and which covers ISO-8859-1 for every letter Finnish needs).
 */
export function decodeCsv(bytes: Uint8Array): {
  text: string;
  encoding: CsvEncoding;
} {
  const utf16: CsvEncoding | null =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : null;
  if (utf16) {
    // The decoder drops the byte order mark.
    return { text: new TextDecoder(utf16).decode(bytes), encoding: utf16 };
  }
  try {
    // `ignoreBOM: false` (the default) drops a leading UTF-8 BOM.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, encoding: "utf-8" };
  } catch {
    return {
      text: new TextDecoder("windows-1252").decode(bytes),
      encoding: "windows-1252",
    };
  }
}

const SIGNS = /^([+\-−]?)(.*?)(-?)$/;
const GROUPED = /^\d{1,3}([.,])\d{3}(?:\1\d{3})*$/;

/**
 * An amount cell as signed integer minor units (two decimals, EUR). Accepts
 * a decimal comma or point, space, no-break space, apostrophe, point or
 * comma as thousands separators, a leading `+`, `-` or `−`, a trailing `-`
 * and a `€` or `EUR` suffix: `-1 234,56`, `+12,5`, `1.234,00`, `12.50 €`.
 * A lone separator followed by exactly three digits groups thousands
 * (`1.234` is 1234). Throws on anything else, including a third decimal.
 */
export function parseCsvAmount(value: string): number {
  const compact = value
    .replace(/[\s  ']/g, "")
    .replace(/(?:€|EUR)$/i, "")
    .replace(/^(?:€|EUR)/i, "");
  const [, leading = "", body = "", trailing = ""] = SIGNS.exec(compact) ?? [];
  if (!/^\d[\d.,]*$/.test(body) || (leading !== "" && trailing !== "")) {
    throw new Error(`Not an amount: ${JSON.stringify(value)}`);
  }

  const separator = Math.max(body.lastIndexOf(","), body.lastIndexOf("."));
  const decimals = separator < 0 ? 0 : body.length - separator - 1;
  const hasFraction = separator >= 0 && decimals > 0 && decimals !== 3;
  const integer = hasFraction ? body.slice(0, separator) : body;
  const fraction = hasFraction ? body.slice(separator + 1) : "";
  if (
    fraction.length > 2 ||
    (/[.,]/.test(integer) && !GROUPED.test(integer)) ||
    // `1.234,567.89`-style mixes: the groups must use the other separator.
    (hasFraction && integer.includes(body[separator]))
  ) {
    throw new Error(`Not an amount: ${JSON.stringify(value)}`);
  }

  const minor =
    BigInt(integer.replace(/[.,]/g, "")) * BigInt(100) +
    BigInt(fraction.padEnd(2, "0") || "0");
  const signed = leading === "-" || leading === "−" || trailing === "-";
  const result = Number(signed ? -minor : minor);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`Amount out of range: ${JSON.stringify(value)}`);
  }
  // `-0,00` is zero.
  return result === 0 ? 0 : result;
}

const SLASHED_ISO = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;

/**
 * A date cell as `YYYY-MM-DD`: `dd.mm.yyyy` (also `d.m.yyyy`), ISO
 * `yyyy-mm-dd` (a time after it is ignored) or `yyyy/mm/dd`. Throws on
 * anything else and on days that do not exist.
 */
export function parseCsvDate(value: string): IsoDate {
  const trimmed = value.trim();
  const slashed = SLASHED_ISO.exec(trimmed);
  return normaliseDate(
    slashed
      ? `${slashed[1]}-${slashed[2].padStart(2, "0")}-${slashed[3].padStart(2, "0")}`
      : trimmed,
  );
}
