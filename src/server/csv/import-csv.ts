import { and, asc, eq } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { accounts, institutions, transactions } from "@/server/db/schema";
import type { ProviderTransaction } from "@/server/providers/types";
import {
  noCategorization,
  type CategorizeHook,
} from "@/server/sync/sync-transactions";
import { identifyTransactions } from "@/server/sync/transaction-merge";
import type { CsvFormat, CsvRowError, ParsedCsv } from "./bank-csv";

// Writes parsed CSV rows into an account (F-012, D-011). The rows take the
// bank sync's identity path: `identifyTransactions()` numbers otherwise
// identical rows the way a sync numbers them, so a row hashes like the same
// transaction from an earlier import or from the bank API, and the unique
// `(account_id, dedupe_hash)` key skips it. An import only inserts: it never
// changes, books or removes a stored transaction (a later bank sync merges
// its own data over imported rows, F-009).

export class ImportAccountError extends Error {
  override readonly name = "ImportAccountError";
}

export interface ImportSummary {
  /** Data rows in the file. */
  rowsRead: number;
  inserted: number;
  /** Rows already stored for the account (earlier imports or bank sync). */
  duplicates: number;
  /** Rows not imported, by file line. */
  errors: CsvRowError[];
}

export interface ImportOptions {
  db?: Db;
  /** Runs inside the import's transaction with the new ids (F-014). */
  categorize?: CategorizeHook;
}

/** Rows per insert statement, well below Postgres' parameter limit. */
const INSERT_BATCH = 500;

export async function importCsvRows(
  accountId: string,
  parsed: Pick<ParsedCsv, "rowsRead" | "rows" | "errors">,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const db = options.db ?? getDb();
  const categorize = options.categorize ?? noCategorization;
  const [account] = await db
    .select({ currency: accounts.currency, archived: accounts.archived })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!account || account.archived) {
    throw new ImportAccountError("The account does not exist or is archived.");
  }

  const errors = [...parsed.errors];
  const listing: ProviderTransaction[] = [];
  for (const row of parsed.rows) {
    if (row.currency !== null && row.currency !== account.currency) {
      errors.push({
        row: row.row,
        message: `The currency ${row.currency} is not the account's ${account.currency}`,
      });
      continue;
    }
    listing.push({
      ref: null,
      bookingDate: row.bookingDate,
      valueDate: row.valueDate,
      amountMinor: row.amountMinor,
      currency: account.currency,
      counterparty: row.counterparty,
      description: row.description,
      status: "booked",
    });
  }
  const values = identifyTransactions(listing);

  const inserted = await db.transaction(async (tx) => {
    const ids: string[] = [];
    for (let start = 0; start < values.length; start += INSERT_BATCH) {
      const rows = await tx
        .insert(transactions)
        .values(
          values
            .slice(start, start + INSERT_BATCH)
            .map((value) => ({ ...value, accountId })),
        )
        .onConflictDoNothing({
          target: [transactions.accountId, transactions.dedupeHash],
        })
        .returning({ id: transactions.id });
      ids.push(...rows.map((row) => row.id));
    }
    if (ids.length > 0) await categorize(tx, ids);
    return ids.length;
  });

  return {
    rowsRead: parsed.rowsRead,
    inserted,
    duplicates: values.length - inserted,
    errors: errors.sort((a, b) => a.row - b.row),
  };
}

/** The institution a new manual account of each format belongs to. */
const MANUAL_INSTITUTIONS: Record<CsvFormat, string> = {
  nordea: "Nordea",
  "s-pankki": "S-Pankki",
  generic: "Other bank",
};

export type ManualAccountType = "checking" | "savings";

/**
 * A manual account (no connection) for imports, under the `csv`
 * institution of the export's format, in EUR.
 */
export async function createManualAccount(
  input: { name: string; type: ManualAccountType; format: CsvFormat },
  options: { db?: Db } = {},
): Promise<string> {
  const db = options.db ?? getDb();
  const name = input.name.trim();
  if (name === "") throw new ImportAccountError("Name the new account.");
  return db.transaction(async (tx) => {
    await tx
      .insert(institutions)
      .values({
        name: MANUAL_INSTITUTIONS[input.format],
        country: "FI",
        provider: "csv",
        providerRef: input.format,
      })
      .onConflictDoNothing({
        target: [institutions.provider, institutions.providerRef],
      });
    const [institution] = await tx
      .select({ id: institutions.id })
      .from(institutions)
      .where(
        and(
          eq(institutions.provider, "csv"),
          eq(institutions.providerRef, input.format),
        ),
      );
    const [account] = await tx
      .insert(accounts)
      .values({
        institutionId: institution.id,
        type: input.type,
        name,
        currency: "EUR",
      })
      .returning({ id: accounts.id });
    return account.id;
  });
}

export interface ImportAccount {
  id: string;
  name: string;
  institution: string;
  currency: string;
  /** No bank connection: filled by imports only. */
  manual: boolean;
}

/** Accounts an import can write to: every non-archived one. */
export async function listImportAccounts(
  options: { db?: Db } = {},
): Promise<ImportAccount[]> {
  const db = options.db ?? getDb();
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: institutions.name,
      currency: accounts.currency,
      connectionId: accounts.connectionId,
    })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(accounts.archived, false))
    .orderBy(asc(institutions.name), asc(accounts.name), asc(accounts.id));
  return rows.map(({ connectionId, ...row }) => ({
    ...row,
    manual: connectionId === null,
  }));
}
