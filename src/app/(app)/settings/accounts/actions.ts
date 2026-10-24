"use server";

import { refresh } from "next/cache";
import { verifySession } from "@/lib/auth/session";
import {
  AccountInputError,
  parseNewOwnAccount,
  parseOwnAccountEdit,
} from "@/server/connections/account-input";
import {
  addManualAccount,
  archiveManualAccount,
  updateManualAccount,
} from "@/server/connections/manual-accounts";
import { localDate } from "@/server/dates";
import { getEnv } from "@/server/env";
import { isUuid } from "@/server/queries/transaction-filter";

// /settings/accounts (F-029): add, edit and archive own accounts outside the
// bank connections. Saving re-runs categorisation; the result says how many
// transactions it linked as transfers.

export type ManualAccountResult =
  { ok: true; linked: number } | { ok: false; error: string };

function userError(error: unknown): { ok: false; error: string } {
  if (error instanceof AccountInputError) {
    return { ok: false, error: error.message };
  }
  throw error;
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new AccountInputError("Choose an account.");
  }
  return value.toLowerCase();
}

function today(): string {
  return localDate(new Date(), getEnv().APP_TIMEZONE);
}

export async function addManualAccountAction(
  form: FormData,
): Promise<ManualAccountResult> {
  await verifySession();
  try {
    const input = parseNewOwnAccount(Object.fromEntries(form), today());
    const { linked } = await addManualAccount(input);
    refresh();
    return { ok: true, linked };
  } catch (error) {
    return userError(error);
  }
}

export async function updateManualAccountAction(
  id: string,
  form: FormData,
): Promise<ManualAccountResult> {
  await verifySession();
  try {
    const input = parseOwnAccountEdit(Object.fromEntries(form), today());
    const { linked } = await updateManualAccount(requireId(id), input);
    refresh();
    return { ok: true, linked };
  } catch (error) {
    return userError(error);
  }
}

export async function archiveManualAccountAction(
  id: string,
): Promise<ManualAccountResult> {
  await verifySession();
  try {
    await archiveManualAccount(requireId(id));
    refresh();
    return { ok: true, linked: 0 };
  } catch (error) {
    return userError(error);
  }
}
