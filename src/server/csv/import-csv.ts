import { and, asc, eq } from "drizzle-orm";
import { categorizeTransactions } from "@/server/categorization/categorize";
import { getDb, type Db } from "@/server/db/client";
import { accounts, institutions, transactions } from "@/server/db/schema";
import type { ProviderTransaction } from "@/server/providers/types";
import type { Tx } from "@/server/sync/runs";
import type { CategorizeHook } from "@/server/sync/sync-transactions";
import {
  identifyTransactions,
  type TransactionValues,
} from "@/server/sync/transaction-merge";
import type { CsvFormat, CsvRowError, ParsedCsv } from "./bank-csv";

// Writes parsed CSV rows into an account (F-012, D-011). The rows take the
// bank sync's identity path: `identifyTransactions()` numbers otherwise
// identical rows the way a sync numbers them, so a row hashes like the same
// transaction from an earlier import or from the bank API, and the unique
// `(account_id, dedupe_hash)` key skips it, as the `(account_id,
// provider_txn_ref)` key skips a row whose bank id (S-Pankki's archive id,
// F-031) is already stored. An import only inserts: it never
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
  /** Lines the file itself repeats verbatim, imported once (Nordea). */
  repeated: number;
  /** Rows not imported, by file line. */
  errors: CsvRowError[];
}

export interface ImportOptions {
  db?: Db;
  /**
   * Runs inside the import's transaction with the new ids; defaults to the
   * rule engine and transfer detection (F-014).
   */
  categorize?: CategorizeHook;
}

/** Rows per insert statement, well below Postgres' parameter limit. */
const INSERT_BATCH = 500;

export async function importCsvRows(
  accountId: string,
  parsed: Pick<ParsedCsv, "rowsRead" | "repeated" | "rows" | "errors">,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const db = options.db ?? getDb();
  const [account] = await db
    .select({ currency: accounts.currency, archived: accounts.archived })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!account || account.archived) {
    throw new ImportAccountError("The account does not exist or is archived.");
  }
  const { values, errors } = prepareRows(parsed, account.currency);
  const inserted = await db.transaction((tx) =>
    insertRows(tx, accountId, values, options),
  );
  return summarise(parsed, values.length, inserted, errors);
}

/**
 * Creates a manual account (see `createManualAccount()`) and imports into
 * it in one transaction, so a failed import leaves no empty account behind;
 * a file without a single importable row creates none.
 */
export async function importCsvIntoNewAccount(
  input: NewManualAccount,
  parsed: Pick<ParsedCsv, "rowsRead" | "repeated" | "rows" | "errors">,
  options: ImportOptions = {},
): Promise<{ accountId: string; summary: ImportSummary }> {
  const db = options.db ?? getDb();
  const name = checkName(input.name);
  const { values, errors } = prepareRows(parsed, MANUAL_CURRENCY);
  if (values.length === 0) {
    throw new ImportAccountError(
      "No row can be imported, so no account was created.",
    );
  }
  return db.transaction(async (tx) => {
    const accountId = await insertManualAccount(tx, { ...input, name });
    const inserted = await insertRows(tx, accountId, values, options);
    return {
      accountId,
      summary: summarise(parsed, values.length, inserted, errors),
    };
  });
}

/** Rows in another currency than the account's become errors. */
function prepareRows(
  parsed: Pick<ParsedCsv, "rows" | "errors">,
  currency: string,
): { values: TransactionValues[]; errors: CsvRowError[] } {
  const errors = [...parsed.errors];
  const listing: ProviderTransaction[] = [];
  for (const row of parsed.rows) {
    if (row.currency !== null && row.currency !== currency) {
      errors.push({
        row: row.row,
        message: `The currency ${row.currency} is not the account's ${currency}`,
      });
      continue;
    }
    listing.push({
      ref: row.ref,
      bookingDate: row.bookingDate,
      valueDate: row.valueDate,
      amountMinor: row.amountMinor,
      currency,
      counterparty: row.counterparty,
      counterpartyIban: row.counterpartyIban,
      description: row.description,
      status: "booked",
    });
  }
  return { values: identifyTransactions(listing), errors };
}

/** Inserts what is not stored yet; returns how many rows were inserted. */
async function insertRows(
  tx: Tx,
  accountId: string,
  values: readonly TransactionValues[],
  options: ImportOptions,
): Promise<number> {
  const categorize = options.categorize ?? categorizeTransactions;
  const ids: string[] = [];
  for (let start = 0; start < values.length; start += INSERT_BATCH) {
    const rows = await tx
      .insert(transactions)
      .values(
        values
          .slice(start, start + INSERT_BATCH)
          .map((value) => ({ ...value, accountId })),
      )
      // Either unique key: the same hash or the same bank ref.
      .onConflictDoNothing()
      .returning({ id: transactions.id });
    ids.push(...rows.map((row) => row.id));
  }
  if (ids.length > 0) await categorize(tx, ids);
  return ids.length;
}

function summarise(
  parsed: Pick<ParsedCsv, "rowsRead" | "repeated">,
  importable: number,
  inserted: number,
  errors: CsvRowError[],
): ImportSummary {
  return {
    rowsRead: parsed.rowsRead,
    inserted,
    duplicates: importable - inserted,
    repeated: parsed.repeated,
    errors: errors.sort((a, b) => a.row - b.row),
  };
}

/** The institution a new manual account of each format belongs to. */
const MANUAL_INSTITUTIONS: Record<CsvFormat, string> = {
  nordea: "Nordea",
  "nordea-card": "Nordea",
  "s-pankki": "S-Pankki",
  generic: "Other bank",
};

const MANUAL_CURRENCY = "EUR";

export type ManualAccountType = "checking" | "savings";

/**
 * A manual account's institution: a CSV import's export format (provider
 * `csv`), or the bank name the user typed under Settings → Accounts
 * (provider `manual`, `provider_ref` `bank:<name>`, one institution row
 * per name, F-029).
 */
export type ManualInstitution = { format: CsvFormat } | { institution: string };

export type NewManualAccount = {
  name: string;
  type: ManualAccountType;
  /** Normalised; null or left out when not known (a CSV import). */
  iban?: string | null;
} & ManualInstitution;

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new ImportAccountError("Name the new account.");
  return trimmed;
}

/** A manual account (no connection) in EUR. */
export async function createManualAccount(
  input: NewManualAccount,
  options: { db?: Db } = {},
): Promise<string> {
  const db = options.db ?? getDb();
  const name = checkName(input.name);
  return db.transaction((tx) => insertManualAccount(tx, { ...input, name }));
}

function institutionKey(input: ManualInstitution) {
  return "format" in input
    ? {
        name: MANUAL_INSTITUTIONS[input.format],
        provider: "csv",
        providerRef: input.format,
      }
    : {
        name: input.institution,
        provider: "manual",
        // Prefixed: the crypto wallets' institution is `manual` / `manual`.
        providerRef: `bank:${input.institution}`,
      };
}

/** `createManualAccount()` inside the caller's transaction. */
export async function insertManualAccount(
  tx: Tx,
  input: NewManualAccount,
): Promise<string> {
  const key = institutionKey(input);
  await tx
    .insert(institutions)
    .values({ ...key, country: "FI" })
    .onConflictDoNothing({
      target: [institutions.provider, institutions.providerRef],
    });
  const [institution] = await tx
    .select({ id: institutions.id })
    .from(institutions)
    .where(
      and(
        eq(institutions.provider, key.provider),
        eq(institutions.providerRef, key.providerRef),
      ),
    );
  const [account] = await tx
    .insert(accounts)
    .values({
      institutionId: institution.id,
      type: input.type,
      name: input.name,
      iban: input.iban ?? null,
      currency: MANUAL_CURRENCY,
    })
    .returning({ id: accounts.id });
  return account.id;
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
