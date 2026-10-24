"use server";

import { refresh } from "next/cache";
import { verifySession } from "@/lib/auth/session";
import { CategoryManageError } from "@/server/categorization/manage";
import {
  markTransfer,
  setTransactionCategory,
  setTransactionNote,
  unlinkTransfer,
} from "@/server/categorization/transaction-edits";
import { isUuid } from "@/server/queries/transaction-filter";
import {
  userError,
  type ActionResult,
} from "../settings/categories/action-result";

// Edits of one transaction on /transactions (F-015). Creating a rule from a
// transaction is `addRule` in the settings actions.

function transactionId(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new CategoryManageError("The transaction is gone.");
  }
  return value.toLowerCase();
}

export async function changeCategory(
  id: string,
  choice: string,
): Promise<ActionResult> {
  await verifySession();
  try {
    if (choice !== "auto" && !isUuid(choice)) {
      throw new CategoryManageError("Choose a category.");
    }
    await setTransactionCategory(
      transactionId(id),
      choice === "auto" ? choice : choice.toLowerCase(),
    );
    refresh();
    return { ok: true };
  } catch (error) {
    return userError(error);
  }
}

export async function saveNote(
  id: string,
  note: string,
): Promise<ActionResult> {
  await verifySession();
  try {
    await setTransactionNote(transactionId(id), String(note ?? ""));
    refresh();
    return { ok: true };
  } catch (error) {
    return userError(error);
  }
}

export async function markAsTransfer(id: string): Promise<ActionResult> {
  await verifySession();
  try {
    await markTransfer(transactionId(id));
    refresh();
    return { ok: true };
  } catch (error) {
    return userError(error);
  }
}

export async function unlinkTransferAction(id: string): Promise<ActionResult> {
  await verifySession();
  try {
    await unlinkTransfer(transactionId(id));
    refresh();
    return { ok: true };
  } catch (error) {
    return userError(error);
  }
}
