"use server";

import { redirect } from "next/navigation";
import { verifySession } from "@/lib/auth/session";
import {
  BankConnectionError,
  startConnectionRenewal,
} from "@/server/connections/authorization";
import { isProviderError } from "@/server/providers/errors";
import { isUuid } from "@/server/queries/transaction-filter";

// Renew (F-011): the consent banner on every page and the cards on
// /connections send the user to the bank to renew a connection's consent;
// the callback attaches the new session to the same connection.

export type RenewResult = { ok: false; error: string };

/** Sends the browser to the bank; returns only when that cannot start. */
export async function renewConnectionAction(
  _previous: RenewResult | null,
  formData: FormData,
): Promise<RenewResult> {
  await verifySession();
  const connectionId = formData.get("connection");
  if (typeof connectionId !== "string" || !isUuid(connectionId)) {
    return { ok: false, error: "Choose a connection to renew." };
  }
  let url: string;
  try {
    ({ url } = await startConnectionRenewal(connectionId.toLowerCase()));
  } catch (error) {
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
  redirect(url);
}
