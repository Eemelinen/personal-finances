"use server";

import { refresh } from "next/cache";
import { verifySession } from "@/lib/auth/session";
import {
  importNordnetCsv,
  type NordnetImportSummary,
} from "@/server/investments/import-nordnet";
import {
  NordnetFormatError,
  readNordnetCsv,
} from "@/server/investments/nordnet-csv";
import { MAX_CSV_BYTES } from "../import/limits";

// The /investments page's Nordnet import (F-020): reads the uploaded export
// and writes it in one step; a repeated or overlapping file adds nothing
// twice, so there is no preview.

export type NordnetImportResult =
  { ok: true; summary: NordnetImportSummary } | { ok: false; error: string };

export async function importNordnet(
  formData: FormData,
): Promise<NordnetImportResult> {
  await verifySession();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a Nordnet CSV file." };
  }
  if (file.size > MAX_CSV_BYTES) {
    return { ok: false, error: "The file is larger than 4 MB." };
  }
  try {
    const parsed = readNordnetCsv(new Uint8Array(await file.arrayBuffer()));
    const summary = await importNordnetCsv(parsed);
    console.info(
      `[nordnet-import] ${summary.inserted} inserted, ${summary.duplicates} duplicates, ${summary.skipped.length} skipped, ${summary.errors.length} errors`,
    );
    // The holdings table below the form changed.
    refresh();
    return { ok: true, summary };
  } catch (error) {
    if (error instanceof NordnetFormatError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
