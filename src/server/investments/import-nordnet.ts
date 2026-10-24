import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import {
  accounts,
  assets,
  holdings,
  institutions,
  investmentTransactions,
  prices,
} from "@/server/db/schema";
import { dedupeHash } from "@/server/dedupe-hash";
import type { Tx } from "@/server/sync/runs";
import { deriveHoldings } from "./holdings";
import type {
  NordnetRow,
  NordnetRowNote,
  NordnetSecurity,
  ParsedNordnetCsv,
} from "./nordnet-csv";

// Writes a parsed Nordnet export (F-020, D-017). Each portfolio (`Salkku`)
// is a brokerage account under the `csv` institution `nordnet`, created on
// its first import. Rows are insert-only and skip what is stored already:
// by Nordnet's transaction id and by a dedupe hash (numbered like the bank
// import for otherwise identical rows), so overlapping exports add nothing
// twice. The account's holdings are then derived again from all of its
// transactions, so an older export imported later corrects them.

export const NORDNET_INSTITUTION_REF = "nordnet";
/** `provider_account_ref` of the account when the export has no portfolio column. */
export const DEFAULT_PORTFOLIO_REF = "default";
/** `prices.source` of unit prices taken from imported trades. */
export const TRADE_PRICE_SOURCE = "nordnet_trade";

const ACCOUNT_CURRENCY = "EUR";
const INSERT_BATCH = 500;

export interface NordnetImportAccount {
  id: string;
  name: string;
  /** Created by this import. */
  created: boolean;
  inserted: number;
  duplicates: number;
}

export interface NordnetImportSummary {
  /** Data rows in the file. */
  rowsRead: number;
  inserted: number;
  /** Rows stored already (an earlier, overlapping import). */
  duplicates: number;
  skipped: NordnetRowNote[];
  errors: NordnetRowNote[];
  accounts: NordnetImportAccount[];
  /** Assets sold below zero: the export lacks their earlier buys. */
  oversold: string[];
}

function accountName(portfolio: string | null): string {
  return portfolio === null ? "Nordnet" : `Nordnet ${portfolio}`;
}

/** The identity of a row when Nordnet's id is missing or changes. */
export function nordnetDedupeHash(row: NordnetRow, occurrence: number): string {
  return dedupeHash({
    bookingDate: row.tradeDate,
    amountMinor: row.amountMinor,
    counterparty: `${row.nordnetType} ${row.security?.isin ?? row.security?.symbol ?? ""}`,
    description: `${row.quantity ?? ""} ${row.currency} ${row.description ?? ""}`,
    occurrence,
  });
}

/** Nordnet ids in numeric order when both are numbers, else as text. */
function compareRefs(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    return a.length - b.length || a.localeCompare(b);
  }
  return a.localeCompare(b);
}

/**
 * Rows with their dedupe hashes, numbered per portfolio: otherwise
 * identical rows (two equal buys on one day, which always share an export)
 * are numbered in Nordnet id order, not file order, so every export numbers
 * them the same way.
 */
export function identify(
  rows: readonly NordnetRow[],
): { row: NordnetRow; hash: string }[] {
  const keyed = rows.map((row, index) => ({
    row,
    index,
    base: `${row.portfolio ?? ""}\u001f${nordnetDedupeHash(row, 1)}`,
  }));
  const ordered = [...keyed].sort(
    (a, b) =>
      a.base.localeCompare(b.base) ||
      compareRefs(a.row.ref, b.row.ref) ||
      a.index - b.index,
  );
  const hashes = new Map<number, string>();
  let occurrence = 0;
  ordered.forEach((entry, i) => {
    occurrence =
      i > 0 && ordered[i - 1].base === entry.base ? occurrence + 1 : 1;
    hashes.set(entry.index, nordnetDedupeHash(entry.row, occurrence));
  });
  return keyed.map(({ row, index }) => ({ row, hash: hashes.get(index)! }));
}

async function nordnetInstitution(tx: Tx): Promise<string> {
  await tx
    .insert(institutions)
    .values({
      name: "Nordnet",
      country: "FI",
      provider: "csv",
      providerRef: NORDNET_INSTITUTION_REF,
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
        eq(institutions.providerRef, NORDNET_INSTITUTION_REF),
      ),
    );
  return institution.id;
}

async function portfolioAccount(
  tx: Tx,
  institutionId: string,
  portfolio: string | null,
): Promise<{ id: string; name: string; created: boolean }> {
  const ref = portfolio ?? DEFAULT_PORTFOLIO_REF;
  const [existing] = await tx
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(
      and(
        eq(accounts.institutionId, institutionId),
        eq(accounts.providerAccountRef, ref),
        eq(accounts.archived, false),
      ),
    )
    .orderBy(asc(accounts.createdAt))
    .limit(1);
  if (existing) return { ...existing, created: false };
  const [created] = await tx
    .insert(accounts)
    .values({
      institutionId,
      type: "brokerage",
      name: accountName(portfolio),
      currency: ACCOUNT_CURRENCY,
      providerAccountRef: ref,
    })
    .returning({ id: accounts.id, name: accounts.name });
  return { ...created, created: true };
}

/** Finds the asset by ISIN, else by symbol and currency; adds it if new. */
async function assetId(tx: Tx, security: NordnetSecurity): Promise<string> {
  const find = async () => {
    const [found] = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(
        security.isin !== null
          ? eq(assets.isin, security.isin)
          : and(
              isNull(assets.isin),
              eq(assets.symbol, security.symbol),
              eq(assets.currency, security.currency),
            ),
      )
      .limit(1);
    return found?.id;
  };
  const found = await find();
  if (found) return found;
  const [created] = await tx
    .insert(assets)
    .values({
      symbol: security.symbol,
      name: security.name,
      isin: security.isin,
      assetClass: security.assetClass,
      currency: security.currency,
    })
    .onConflictDoNothing()
    .returning({ id: assets.id });
  return created?.id ?? (await find())!;
}

/** Re-derives the account's holding snapshots from all its transactions. */
export async function rebuildHoldings(
  tx: Tx,
  accountId: string,
): Promise<string[]> {
  const rows = await tx
    .select({
      assetId: investmentTransactions.assetId,
      type: investmentTransactions.type,
      tradeDate: investmentTransactions.tradeDate,
      quantity: investmentTransactions.quantity,
      amountMinor: investmentTransactions.amountMinor,
      currency: investmentTransactions.currency,
    })
    .from(investmentTransactions)
    .where(eq(investmentTransactions.accountId, accountId));
  const derived = deriveHoldings(rows);
  await tx.delete(holdings).where(eq(holdings.accountId, accountId));
  for (let start = 0; start < derived.holdings.length; start += INSERT_BATCH) {
    await tx
      .insert(holdings)
      .values(
        derived.holdings
          .slice(start, start + INSERT_BATCH)
          .map((holding) => ({ ...holding, accountId })),
      );
  }
  return derived.oversold;
}

export async function importNordnetCsv(
  parsed: Pick<ParsedNordnetCsv, "rowsRead" | "rows" | "skipped" | "errors">,
  options: { db?: Db } = {},
): Promise<NordnetImportSummary> {
  const db = options.db ?? getDb();
  const { rows } = parsed;
  const result = await db.transaction(async (tx) => {
    const institutionId = await nordnetInstitution(tx);
    const portfolios = [...new Set(rows.map((row) => row.portfolio))];
    const summaries: NordnetImportAccount[] = [];
    const oversold = new Set<string>();
    const identified = identify(rows);
    const assetIds = new Map<string, string>();
    const assetOf = async (security: NordnetSecurity) => {
      const key = `${security.isin ?? ""}|${security.symbol}|${security.currency}`;
      let id = assetIds.get(key);
      if (!id) {
        id = await assetId(tx, security);
        assetIds.set(key, id);
      }
      return id;
    };

    for (const portfolio of portfolios) {
      const account = await portfolioAccount(tx, institutionId, portfolio);
      const own = identified.filter(({ row }) => row.portfolio === portfolio);
      const values = [];
      const tradePrices = new Map<string, typeof prices.$inferInsert>();
      for (const { row, hash } of own) {
        const asset = row.security ? await assetOf(row.security) : null;
        values.push({
          accountId: account.id,
          assetId: asset,
          type: row.type,
          providerTxnRef: row.ref,
          dedupeHash: hash,
          tradeDate: row.tradeDate,
          quantity: row.quantity,
          amountMinor: row.amountMinor,
          currency: row.currency,
          description:
            [row.nordnetType, row.description].filter(Boolean).join(" · ") ||
            null,
        });
        if (asset && row.priceMinor !== null && row.security) {
          // The day's last trade in the file wins.
          tradePrices.set(`${asset}|${row.tradeDate}`, {
            assetId: asset,
            date: row.tradeDate,
            priceMinor: row.priceMinor,
            currency: row.security.currency,
            source: TRADE_PRICE_SOURCE,
          });
        }
      }

      let inserted = 0;
      for (let start = 0; start < values.length; start += INSERT_BATCH) {
        const written = await tx
          .insert(investmentTransactions)
          .values(values.slice(start, start + INSERT_BATCH))
          // Either key: Nordnet's id or the dedupe hash.
          .onConflictDoNothing()
          .returning({ id: investmentTransactions.id });
        inserted += written.length;
      }
      if (tradePrices.size > 0) {
        // A fetched closing price of the day is never replaced.
        await tx
          .insert(prices)
          .values([...tradePrices.values()])
          .onConflictDoNothing({ target: [prices.assetId, prices.date] });
      }
      for (const asset of await rebuildHoldings(tx, account.id)) {
        oversold.add(asset);
      }
      summaries.push({
        ...account,
        inserted,
        duplicates: values.length - inserted,
      });
    }

    const oversoldSymbols = oversold.size
      ? (
          await tx
            .select({ symbol: assets.symbol })
            .from(assets)
            .where(inArray(assets.id, [...oversold]))
            .orderBy(asc(assets.symbol))
        ).map((asset) => asset.symbol)
      : [];
    return { summaries, oversold: oversoldSymbols };
  });

  const inserted = result.summaries.reduce((sum, a) => sum + a.inserted, 0);
  return {
    rowsRead: parsed.rowsRead,
    inserted,
    duplicates: rows.length - inserted,
    skipped: [...parsed.skipped].sort((a, b) => a.row - b.row),
    errors: [...parsed.errors].sort((a, b) => a.row - b.row),
    accounts: result.summaries,
    oversold: result.oversold,
  };
}
