"use server";

import { refresh } from "next/cache";
import { verifySession } from "@/lib/auth/session";
import { localDate } from "@/server/dates";
import { getEnv } from "@/server/env";
import {
  importNordnetCsv,
  type NordnetImportSummary,
} from "@/server/investments/import-nordnet";
import {
  ManualHoldingError,
  setManualHolding,
} from "@/server/investments/manual-holdings";
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

// Manual crypto holdings (F-021): the wallet's quantity of a coin today.

export type ManualHoldingResult =
  | {
      ok: true;
      wallet: string;
      symbol: string;
      quantity: string;
      priced: boolean;
    }
  | { ok: false; error: string };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function saveManualHolding(
  formData: FormData,
): Promise<ManualHoldingResult> {
  await verifySession();
  const input = {
    wallet: field(formData, "wallet"),
    symbol: field(formData, "symbol"),
    coingeckoId: field(formData, "coingeckoId") || null,
    quantity: field(formData, "quantity"),
    date: localDate(new Date(), getEnv().APP_TIMEZONE),
  };
  try {
    const saved = await setManualHolding(input);
    console.info(
      `[manual-holding] ${saved.created ? "new wallet, " : ""}${saved.quantity} units saved`,
    );
    // The holdings table above the form changed.
    refresh();
    return {
      ok: true,
      wallet: input.wallet.trim(),
      symbol: input.symbol.trim().toUpperCase(),
      quantity: saved.quantity,
      priced: saved.coingeckoId !== null,
    };
  } catch (error) {
    if (error instanceof ManualHoldingError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
