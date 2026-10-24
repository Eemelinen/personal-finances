"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/auth/session";
import {
  BankConnectionError,
  startBankConnection,
} from "@/server/connections/authorization";
import {
  archiveConnection,
  removeConnection,
  updateBankAccount,
} from "@/server/connections/manage";
import { isProviderError } from "@/server/providers/errors";
import { isUuid } from "@/server/queries/transaction-filter";

// /connections (F-007): connect a bank, rename an account, remove or archive
// a connection. The callback from the bank is ./callback/route.ts.

export type ActionResult = { ok: true } | { ok: false; error: string };

function userError(error: unknown): { ok: false; error: string } {
  if (error instanceof BankConnectionError) {
    return { ok: false, error: error.message };
  }
  if (isProviderError(error)) {
    return {
      ok: false,
      error: "The bank service is not reachable right now. Try again later.",
    };
  }
  throw error;
}

function requireId(value: unknown, what: string): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new BankConnectionError(`Choose ${what}.`);
  }
  return value.toLowerCase();
}

/** Sends the browser to the bank; returns only when that cannot start. */
export async function connectBank(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await verifySession();
  let url: string;
  try {
    ({ url } = await startBankConnection(String(formData.get("bank") ?? "")));
  } catch (error) {
    return userError(error);
  }
  redirect(url);
}

export async function saveAccount(
  id: string,
  input: { name: string; type: string },
): Promise<ActionResult> {
  await verifySession();
  try {
    await updateBankAccount(requireId(id, "an account"), {
      name: String(input.name ?? ""),
      type: String(input.type ?? ""),
    });
    refresh();
    return { ok: true };
  } catch (error) {
    return userError(error);
  }
}

export async function removeConnectionAction(
  id: string,
): Promise<ActionResult> {
  await verifySession();
  try {
    await removeConnection(requireId(id, "a connection"));
    refresh();
    return { ok: true };
  } catch (error) {
    return userError(error);
  }
}

export async function archiveConnectionAction(
  id: string,
): Promise<ActionResult> {
  await verifySession();
  try {
    await archiveConnection(requireId(id, "a connection"));
    refresh();
    return { ok: true };
  } catch (error) {
    return userError(error);
  }
}
