"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { verifySession } from "@/lib/auth/session";
import {
  CsvFormatError,
  isCsvFormat,
  MAPPING_FIELDS,
  readBankCsv,
  type ColumnMapping,
  type CsvRow,
  type ParsedCsv,
} from "@/server/csv/bank-csv";
import {
  countCsvMatches,
  countNewAccountRows,
  ImportAccountError,
  importCsvIntoNewAccount,
  importCsvRows,
  type ImportCounts,
  type ImportSummary,
} from "@/server/csv/import-csv";
import { MAX_CSV_BYTES } from "./limits";

// The /import page's two steps (F-012). Both receive the file again, so the
// server keeps no upload state: preview parses it, import parses it the same
// way (the format and columns the preview settled on) and writes the rows.
// Between them `countCsv()` says, for the chosen account, how many rows it
// already has (F-032): the import's matching, without writing.

/** How many parsed rows the preview sends to the browser. */
const PREVIEW_ROWS = 200;

export interface CsvPreview {
  fileName: string;
  format: ParsedCsv["format"];
  encoding: ParsedCsv["encoding"];
  delimiter: ParsedCsv["delimiter"];
  headers: string[];
  mapping: ColumnMapping | null;
  needsMapping: boolean;
  rowsRead: number;
  /** Lines the file repeats verbatim, read once. */
  repeated: number;
  /** Readable rows in the file (the preview shows the first ones). */
  rowCount: number;
  rows: CsvRow[];
  errors: ParsedCsv["errors"];
}

export type PreviewResult =
  { ok: true; preview: CsvPreview } | { ok: false; error: string };

export type CountResult =
  { ok: true; counts: ImportCounts } | { ok: false; error: string };

export type ImportResult =
  | { ok: true; accountId: string; summary: ImportSummary }
  | { ok: false; error: string };

function readOptions(formData: FormData) {
  const format = String(formData.get("format") ?? "auto");
  if (format !== "auto" && !isCsvFormat(format)) {
    throw new CsvFormatError("Choose a file format.");
  }
  const mapping: Partial<ColumnMapping> = {};
  for (const field of MAPPING_FIELDS) {
    const value = formData.get(`mapping.${field}`);
    if (typeof value === "string") mapping[field] = value || null;
  }
  return { format, mapping } as const;
}

async function readUpload(formData: FormData): Promise<{
  name: string;
  parsed: ParsedCsv;
}> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new CsvFormatError("Choose a CSV file.");
  }
  if (file.size > MAX_CSV_BYTES) {
    throw new CsvFormatError("The file is larger than 4 MB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { name: file.name, parsed: readBankCsv(bytes, readOptions(formData)) };
}

function userError(error: unknown): string {
  if (error instanceof CsvFormatError || error instanceof ImportAccountError) {
    return error.message;
  }
  throw error;
}

export async function previewCsv(formData: FormData): Promise<PreviewResult> {
  await verifySession();
  try {
    const { name, parsed } = await readUpload(formData);
    return {
      ok: true,
      preview: {
        fileName: name,
        format: parsed.format,
        encoding: parsed.encoding,
        delimiter: parsed.delimiter,
        headers: parsed.headers,
        mapping: parsed.mapping,
        needsMapping: parsed.needsMapping,
        rowsRead: parsed.rowsRead,
        repeated: parsed.repeated,
        rowCount: parsed.rows.length,
        rows: parsed.rows.slice(0, PREVIEW_ROWS),
        errors: parsed.errors,
      },
    };
  } catch (error) {
    return { ok: false, error: userError(error) };
  }
}

export async function countCsv(formData: FormData): Promise<CountResult> {
  await verifySession();
  try {
    const { parsed } = await readUpload(formData);
    if (parsed.needsMapping) {
      throw new CsvFormatError("Choose the date and amount columns.");
    }
    const target = String(formData.get("account") ?? "");
    if (target === "new") {
      return { ok: true, counts: countNewAccountRows(parsed) };
    }
    if (!z.uuid().safeParse(target).success) {
      throw new ImportAccountError("Choose an account.");
    }
    return { ok: true, counts: await countCsvMatches(target, parsed) };
  } catch (error) {
    return { ok: false, error: userError(error) };
  }
}

export async function importCsv(formData: FormData): Promise<ImportResult> {
  await verifySession();
  try {
    const { parsed } = await readUpload(formData);
    if (parsed.needsMapping) {
      throw new CsvFormatError("Choose the date and amount columns.");
    }
    const target = String(formData.get("account") ?? "");
    let accountId: string;
    let summary: ImportSummary;
    if (target === "new") {
      const type = String(formData.get("newAccountType") ?? "checking");
      ({ accountId, summary } = await importCsvIntoNewAccount(
        {
          name: String(formData.get("newAccountName") ?? ""),
          type: type === "savings" ? "savings" : "checking",
          format: parsed.format,
        },
        parsed,
      ));
    } else if (z.uuid().safeParse(target).success) {
      accountId = target;
      summary = await importCsvRows(accountId, parsed);
    } else {
      throw new ImportAccountError("Choose an account.");
    }
    console.info(
      `[import] ${summary.inserted} inserted, ${summary.duplicates} duplicates, ${summary.repeated} repeated, ${summary.errors.length} errors`,
    );
    // The account list may have a new account.
    refresh();
    return { ok: true, accountId, summary };
  } catch (error) {
    return { ok: false, error: userError(error) };
  }
}
