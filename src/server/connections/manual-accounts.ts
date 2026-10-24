import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { reapplyRules } from "@/server/categorization/categorize";
import { insertManualAccount } from "@/server/csv/import-csv";
import { getDb, type Db } from "@/server/db/client";
import { accounts, balanceSnapshots, institutions } from "@/server/db/schema";
import type { IsoDate } from "@/server/providers/types";
import {
  MANUAL_BALANCE_TYPE,
  pickDisplayBalance,
} from "@/server/sync/balance-types";
import type { Tx } from "@/server/sync/runs";
import {
  AccountInputError,
  BANK_ACCOUNT_TYPES,
  type BankAccountType,
  type ManualBalance,
  type NewOwnAccount,
  type OwnAccountEdit,
} from "./account-input";

// Own accounts outside the bank connections (F-029, Settings → Accounts): a
// savings account the consent does not cover, an account at another bank,
// or one a CSV import created. They are the checking and savings accounts
// without a connection.
//
// - The IBAN is what makes the account count: transfer detection treats a
//   leg whose counterparty IBAN or texts name an own account's IBAN as an
//   own transfer (D-012, F-028). Saving an account therefore re-runs
//   categorisation over every transaction (`reapplyRules()`), so legs that
//   name it become one-sided transfers and leave income and spending.
// - An IBAN belongs to one account: one already stored (any account,
//   synced, manual or archived) is refused.
// - "Balance on date" stores one `balance_snapshots` row of type `manual`
//   for that day (D-009); the balance history and net worth read it like a
//   synced snapshot and carry it forward until a newer one.

export interface ManualAccountItem {
  id: string;
  name: string;
  institution: string;
  iban: string | null;
  type: BankAccountType;
  currency: string;
  /** The latest display balance; null when none was given or imported. */
  balance: { amountMinor: number; date: IsoDate } | null;
}

/** Manual checking and savings accounts that are not archived, by bank and name. */
export async function listManualAccounts(
  options: { db?: Db } = {},
): Promise<ManualAccountItem[]> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: institutions.name,
      iban: accounts.iban,
      type: accounts.type,
      currency: accounts.currency,
    })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(manualAccount())
    .orderBy(asc(institutions.name), asc(accounts.name), asc(accounts.id));
  if (rows.length === 0) return [];

  const snapshots = await db
    .select({
      accountId: balanceSnapshots.accountId,
      date: balanceSnapshots.date,
      amountMinor: balanceSnapshots.amountMinor,
      balanceType: balanceSnapshots.balanceType,
    })
    .from(balanceSnapshots)
    .where(
      inArray(
        balanceSnapshots.accountId,
        rows.map((row) => row.id),
      ),
    );
  return rows.map((row) => {
    const own = snapshots.filter((snapshot) => snapshot.accountId === row.id);
    const latestDay = own.reduce<IsoDate | null>(
      (latest, snapshot) =>
        latest === null || snapshot.date > latest ? snapshot.date : latest,
      null,
    );
    const balance = pickDisplayBalance(
      own.filter((snapshot) => snapshot.date === latestDay),
    );
    return {
      ...row,
      type: row.type as BankAccountType,
      balance: balance
        ? { amountMinor: balance.amountMinor, date: balance.date }
        : null,
    };
  });
}

/** What saving reports: the account and the transfers it newly linked. */
export interface ManualAccountSaved {
  accountId: string;
  /** Transactions newly linked as transfers (both legs of a pair count). */
  linked: number;
}

/**
 * Adds an own account with its IBAN (and balance), then re-runs
 * categorisation so transfers to and from it are linked.
 */
export async function addManualAccount(
  input: NewOwnAccount,
  options: { db?: Db } = {},
): Promise<ManualAccountSaved> {
  const db = options.db ?? getDb();
  const accountId = await db.transaction(async (tx) => {
    await lockAccountIbans(tx);
    await refuseUsedIban(tx, input.iban, null);
    const id = await insertManualAccount(tx, {
      name: input.name,
      type: input.type,
      iban: input.iban,
      institution: input.institution,
    });
    if (input.balance) await storeBalance(tx, id, input.balance);
    return id;
  });
  return { accountId, linked: await relink(db) };
}

/**
 * Sets a manual account's name, IBAN and type, stores the balance when one
 * is given, then re-runs categorisation.
 */
export async function updateManualAccount(
  accountId: string,
  input: OwnAccountEdit,
  options: { db?: Db } = {},
): Promise<ManualAccountSaved> {
  const db = options.db ?? getDb();
  await db.transaction(async (tx) => {
    await lockAccountIbans(tx);
    if (input.iban !== null) {
      await refuseUsedIban(tx, input.iban, accountId);
    }
    const updated = await tx
      .update(accounts)
      .set({ name: input.name, iban: input.iban, type: input.type })
      .where(and(eq(accounts.id, accountId), manualAccount()))
      .returning({ id: accounts.id });
    if (updated.length === 0) {
      throw new AccountInputError("This account no longer exists.");
    }
    if (input.balance) await storeBalance(tx, accountId, input.balance);
  });
  return { accountId, linked: await relink(db) };
}

/**
 * Archives a manual account: it leaves the lists, the dashboard and net
 * worth; its transactions stay, and its IBAN still marks own transfers.
 */
export async function archiveManualAccount(
  accountId: string,
  options: { db?: Db } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const archived = await db
    .update(accounts)
    .set({ archived: true })
    .where(and(eq(accounts.id, accountId), manualAccount()))
    .returning({ id: accounts.id });
  if (archived.length === 0) {
    throw new AccountInputError("This account no longer exists.");
  }
}

/** A checking or savings account without a connection, not archived. */
function manualAccount() {
  return and(
    isNull(accounts.connectionId),
    inArray(accounts.type, [...BANK_ACCOUNT_TYPES]),
    eq(accounts.archived, false),
  );
}

/** Any constant; serialises the duplicate-IBAN check and the write. */
const ACCOUNT_IBAN_LOCK = 0x46_02_9;

async function lockAccountIbans(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ACCOUNT_IBAN_LOCK})`);
}

/** Stored IBANs may carry spaces or lower case (a bank's own formatting). */
async function refuseUsedIban(
  tx: Tx,
  iban: string,
  exceptAccountId: string | null,
): Promise<void> {
  const [used] = await tx
    .select({ name: accounts.name })
    .from(accounts)
    .where(
      and(
        sql`upper(regexp_replace(${accounts.iban}, '\\s', '', 'g')) = ${iban}`,
        exceptAccountId === null ? undefined : ne(accounts.id, exceptAccountId),
      ),
    )
    .limit(1);
  if (used) {
    throw new AccountInputError(
      `The IBAN ${iban} is already used by the account “${used.name}”.`,
    );
  }
}

/** One `manual` snapshot for the day; saving the same day again replaces it. */
async function storeBalance(
  tx: Tx,
  accountId: string,
  balance: ManualBalance,
): Promise<void> {
  const [account] = await tx
    .select({ currency: accounts.currency })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  await tx
    .insert(balanceSnapshots)
    .values({
      accountId,
      date: balance.date,
      amountMinor: balance.amountMinor,
      currency: account.currency,
      balanceType: MANUAL_BALANCE_TYPE,
    })
    .onConflictDoUpdate({
      target: [
        balanceSnapshots.accountId,
        balanceSnapshots.date,
        balanceSnapshots.balanceType,
      ],
      set: { amountMinor: balance.amountMinor, updatedAt: sql`now()` },
    });
}

async function relink(db: Db): Promise<number> {
  return (await reapplyRules({ db })).transfers;
}
