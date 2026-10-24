import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { categoryRules, transactions } from "@/server/db/schema";
import type { Tx } from "@/server/sync/runs";
import {
  categorizeTransactions,
  lockCategorization,
  transfersCategoryId,
} from "./categorize";
import { categoryExists, CategoryManageError } from "./manage";
import { compileRules, matchRule } from "./rules";

// What the user changes on one transaction in /transactions (F-015, D-013).
// Every edit leaves the transaction `manual` (except "automatic"), so the
// rules, re-apply and transfer detection never undo it (D-012):
//
// - category: the chosen category, `manual`; `auto` hands it back to the
//   engine (rules, then transfer detection; a transfer leg gets Transfers).
// - note: the user's own text; syncs and imports never write it.
// - mark as transfer: a one-sided transfer (e.g. to an account that is not
//   connected): its own transfer group and the Transfers category, `manual`.
// - unlink: every leg of the group leaves it and gets the category its first
//   matching rule gives (or none), `manual`, so detection does not pair it
//   again.

export const MAX_NOTE_LENGTH = 1_000;

/** `auto`: back to the rules. */
export type CategoryChoice = string | "auto";

async function load(tx: Db | Tx, id: string) {
  const [row] = await tx
    .select({
      id: transactions.id,
      amountMinor: transactions.amountMinor,
      counterparty: transactions.counterparty,
      description: transactions.description,
      transferGroupId: transactions.transferGroupId,
    })
    .from(transactions)
    .where(eq(transactions.id, id));
  if (!row) throw new CategoryManageError("The transaction is gone.");
  return row;
}

export async function setTransactionCategory(
  id: string,
  choice: CategoryChoice,
  options: { db?: Db } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db.transaction(async (tx) => {
    // Lock before writing the row (see the lock): "auto" re-categorises, and
    // a running re-apply must not overwrite a manual choice it read before.
    await lockCategorization(tx);
    const row = await load(tx, id);
    if (choice !== "auto") {
      if (!(await categoryExists(tx, choice))) {
        throw new CategoryManageError("The category is gone.");
      }
      await tx
        .update(transactions)
        .set({ categoryId: choice, categorySource: "manual" })
        .where(eq(transactions.id, id));
      return;
    }
    if (row.transferGroupId !== null) {
      await tx
        .update(transactions)
        .set({
          categoryId: await transfersCategoryId(tx),
          categorySource: "rule",
        })
        .where(eq(transactions.id, id));
      return;
    }
    await tx
      .update(transactions)
      .set({ categoryId: null, categorySource: "none" })
      .where(eq(transactions.id, id));
    await categorizeTransactions(tx, [id]);
  });
}

export async function setTransactionNote(
  id: string,
  note: string,
  options: { db?: Db } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const text = note.trim();
  if (text.length > MAX_NOTE_LENGTH) {
    throw new CategoryManageError(
      `The note is longer than ${MAX_NOTE_LENGTH} characters.`,
    );
  }
  await load(db, id);
  await db
    .update(transactions)
    .set({ note: text === "" ? null : text })
    .where(eq(transactions.id, id));
}

/** Marks a transaction that is in no group as a one-sided transfer. */
export async function markTransfer(
  id: string,
  options: { db?: Db } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db.transaction(async (tx) => {
    // Writes the transfer group: lock before reading the row, so a running
    // re-apply or sync cannot link it (or its legs) in between.
    await lockCategorization(tx);
    const row = await load(tx, id);
    if (row.transferGroupId !== null) {
      throw new CategoryManageError("The transaction is already a transfer.");
    }
    await tx
      .update(transactions)
      .set({
        transferGroupId: randomUUID(),
        categoryId: await transfersCategoryId(tx),
        categorySource: "manual",
      })
      .where(eq(transactions.id, id));
  });
}

/** Takes every leg of the transaction's transfer group out of it. */
export async function unlinkTransfer(
  id: string,
  options: { db?: Db } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db.transaction(async (tx) => {
    // Writes the transfer group: lock before reading the row, so a running
    // re-apply or sync cannot link it (or its legs) in between.
    await lockCategorization(tx);
    const row = await load(tx, id);
    if (row.transferGroupId === null) {
      throw new CategoryManageError("The transaction is not a transfer.");
    }
    const legs = await tx
      .select({
        id: transactions.id,
        amountMinor: transactions.amountMinor,
        counterparty: transactions.counterparty,
        description: transactions.description,
      })
      .from(transactions)
      .where(eq(transactions.transferGroupId, row.transferGroupId));
    const rules = compileRules(await tx.select().from(categoryRules));
    for (const leg of legs) {
      await tx
        .update(transactions)
        .set({
          transferGroupId: null,
          categoryId: matchRule(rules, leg)?.categoryId ?? null,
          categorySource: "manual",
        })
        .where(eq(transactions.id, leg.id));
    }
  });
}
