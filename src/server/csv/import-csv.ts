import { and, asc, eq, gte, inArray, lte, or } from "drizzle-orm";
import {
  categorizeTransactions,
  lockCategorization,
} from "@/server/categorization/categorize";
import { getDb, type Db } from "@/server/db/client";
import { accounts, institutions, transactions } from "@/server/db/schema";
import type { ProviderTransaction } from "@/server/providers/types";
import type { Tx } from "@/server/sync/runs";
import type { CategorizeHook } from "@/server/sync/sync-transactions";
import {
  identifyTransactions,
  type TransactionValues,
} from "@/server/sync/transaction-merge";
import { addDays } from "@/server/dates";
import type { CsvFormat, CsvRowError, ParsedCsv } from "./bank-csv";
import {
  CSV_MATCH_DAYS,
  matchCsvRows,
  type MatchableTransaction,
} from "./match";

// Writes parsed CSV rows into an account (F-012, D-011). The rows are
// identified as a sync identifies a listing (`identifyTransactions()`
// numbers otherwise identical rows), then matched to the account's stored
// rows (`matchCsvRows()`, F-032): by ref (S-Pankki's archive id is the
// bank's id, F-031), by hash (an earlier import of the same file) or by
// amount within a few days, since the export's texts and dates differ from
// the bank API's and a synced row seldom hashes like its CSV row. A matched
// row is a duplicate; only the rest are inserted, as `csv`. An import never
// changes, books or removes a stored transaction (a later bank sync merges
// its own data over imported rows, F-009). The preview runs the same
// matching read-only (`countCsvMatches()`).

export class ImportAccountError extends Error {
  override readonly name = "ImportAccountError";
}

export interface ImportSummary {
  /** Data rows in the file. */
  rowsRead: number;
  inserted: number;
  /**
   * Rows already stored for the account (earlier imports or bank sync),
   * matched by `matchCsvRows()`.
   */
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
  const inserted = await db.transaction(async (tx) => {
    // A sync writes an account's rows under this lock: the matching sees
    // either all of them or none.
    await lockCategorization(tx);
    const stored = await loadMatchable(tx, accountId, values);
    return insertRows(
      tx,
      accountId,
      matchCsvRows(stored, values).insert,
      options,
    );
  });
  return summarise(parsed, values.length, inserted, errors);
}

/** What an import into the account would do; writes nothing. */
export interface ImportCounts {
  /** Rows the account already has (`ImportSummary.duplicates`). */
  present: number;
  /** Rows an import would insert. */
  new: number;
  /** Rows not importable, the account's other currency included. */
  errors: number;
}

/**
 * The preview's counts for an existing account (F-032): `importCsvRows()`'s
 * matching, read-only. A new manual account has no stored rows.
 */
export async function countCsvMatches(
  accountId: string,
  parsed: Pick<ParsedCsv, "rows" | "errors">,
  options: { db?: Db } = {},
): Promise<ImportCounts> {
  const db = options.db ?? getDb();
  const [account] = await db
    .select({ currency: accounts.currency, archived: accounts.archived })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!account || account.archived) {
    throw new ImportAccountError("The account does not exist or is archived.");
  }
  const { values, errors } = prepareRows(parsed, account.currency);
  const stored = await loadMatchable(db, accountId, values);
  const { insert } = matchCsvRows(stored, values);
  return {
    present: values.length - insert.length,
    new: insert.length,
    errors: errors.length,
  };
}

/** `countCsvMatches()` for a new manual account: every readable row is new. */
export function countNewAccountRows(
  parsed: Pick<ParsedCsv, "rows" | "errors">,
): ImportCounts {
  const { values, errors } = prepareRows(parsed, MANUAL_CURRENCY);
  return { present: 0, new: values.length, errors: errors.length };
}

/** Values per `IN (…)` list, well below Postgres' parameter limit. */
const LOOKUP_BATCH = 1_000;

/**
 * What `matchCsvRows()` needs, oldest first: the account's rows dated (by
 * booking or value date) within `CSV_MATCH_DAYS` of the file's dates and
 * every row sharing a ref with it.
 */
async function loadMatchable(
  db: Pick<Tx, "select">,
  accountId: string,
  values: readonly TransactionValues[],
): Promise<MatchableTransaction[]> {
  if (values.length === 0) return [];
  const days = values.map((value) => value.bookingDate).sort();
  const from = addDays(days[0], -CSV_MATCH_DAYS);
  const to = addDays(days[days.length - 1], CSV_MATCH_DAYS);
  const refs = values.flatMap((value) =>
    value.providerTxnRef === null ? [] : [value.providerTxnRef],
  );
  const filters = [
    and(gte(transactions.bookingDate, from), lte(transactions.bookingDate, to)),
    and(gte(transactions.valueDate, from), lte(transactions.valueDate, to)),
  ];
  for (let start = 0; start < refs.length; start += LOOKUP_BATCH) {
    filters.push(
      inArray(
        transactions.providerTxnRef,
        refs.slice(start, start + LOOKUP_BATCH),
      ),
    );
  }
  return db
    .select({
      id: transactions.id,
      providerTxnRef: transactions.providerTxnRef,
      dedupeHash: transactions.dedupeHash,
      bookingDate: transactions.bookingDate,
      valueDate: transactions.valueDate,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      counterparty: transactions.counterparty,
      counterpartyIban: transactions.counterpartyIban,
      description: transactions.description,
    })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), or(...filters)))
    .orderBy(
      asc(transactions.bookingDate),
      asc(transactions.createdAt),
      asc(transactions.id),
    );
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

/** Inserts unmatched rows; returns how many rows were inserted. */
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
          .map((value) => ({ ...value, accountId, source: "csv" as const })),
      )
      // Either unique key, for a row a concurrent sync wrote meanwhile.
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
