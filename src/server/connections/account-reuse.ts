import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { accounts, connections } from "@/server/db/schema";
import type { ProviderAccount } from "@/server/providers/types";
import type { Tx } from "@/server/sync/runs";
import { BANK_ACCOUNT_TYPES } from "./account-input";
import { matchRenewedAccounts, type AccountMatch } from "./account-matching";

// A bank connected anew (instead of renewed) lists accounts the app may
// already hold (F-033): the accounts of an archived connection, or a manual
// account (one a CSV import or Settings → Accounts created, or one Remove
// kept for its imported rows). Such an account is attached to the new
// connection instead of adding a second one beside it, whose overlapping
// history would count twice in the reports. Only the IBAN identifies it:
// provider account ids are per session. Accounts of a connection that is
// not archived are never taken, even when the IBAN is the same.

/**
 * The checking and savings accounts with an IBAN that a new connection may
 * take over, oldest first, locked until the transaction ends.
 */
async function loadReusableAccounts(tx: Tx) {
  return tx
    .select({ id: accounts.id, iban: accounts.iban })
    .from(accounts)
    .leftJoin(connections, eq(connections.id, accounts.connectionId))
    .where(
      and(
        isNotNull(accounts.iban),
        inArray(accounts.type, [...BANK_ACCOUNT_TYPES]),
        or(isNull(accounts.connectionId), eq(connections.status, "archived")),
      ),
    )
    .orderBy(asc(accounts.createdAt), asc(accounts.id))
    .for("update", { of: accounts });
}

/**
 * Pairs `listed` (accounts new to `connectionId`) with the reusable
 * accounts of the same IBAN and attaches each pair's account to the
 * connection: its provider ref, IBAN and currency from the bank, not
 * archived, and its transactions backfilled by the next sync (whose merge
 * matches the rows already stored). Its name and type stay the user's
 * (D-024). Returns the matches in `listed`'s order; unmatched ones are for
 * the caller to insert.
 */
export async function reuseAccounts<T extends ProviderAccount>(
  tx: Tx,
  connectionId: string,
  institutionId: string,
  listed: readonly T[],
): Promise<AccountMatch<T>[]> {
  if (listed.length === 0) return [];
  const reusable = (await loadReusableAccounts(tx)).map((account) => ({
    ...account,
    // The IBAN only: an old session's account id says nothing here.
    providerAccountRef: null,
  }));
  const matches = matchRenewedAccounts(reusable, listed);
  for (const { account, existingId } of matches) {
    if (existingId === null) continue;
    await tx
      .update(accounts)
      .set({
        connectionId,
        institutionId,
        providerAccountRef: account.ref,
        iban: account.iban,
        currency: account.currency,
        archived: false,
        transactionsSyncedAt: null,
      })
      .where(eq(accounts.id, existingId));
  }
  return matches;
}
