import { and, asc, desc, eq, max, ne, sql } from "drizzle-orm";
import { decryptSecret, DecryptionError, encryptSecret } from "@/server/crypto";
import { addDays, localDate } from "@/server/dates";
import { getDb, type Db } from "@/server/db/client";
import {
  accounts,
  connections,
  holdings,
  institutions,
  investmentTransactions,
} from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import { isProviderError } from "@/server/providers/errors";
import { krakenCredentials } from "@/server/providers/kraken";
import type {
  IsoDate,
  ProviderHolding,
  ProviderInvestmentHistory,
  ProviderSkippedEntry,
} from "@/server/providers/types";
import {
  syncBalances,
  type SyncBalancesResult,
} from "@/server/sync/sync-balances";
import {
  failNotActive,
  failRunOnBug,
  finishRun,
  openConnection,
  recordProviderFailure,
  startRun,
  type SyncFailure,
  type SyncOptions,
  type Tx,
} from "@/server/sync/runs";
import { findOrCreateAsset } from "./assets";
import { parseDecimal } from "./decimal";

// The Kraken sync (F-021, D-018; the worker's `kraken-sync` job). The key
// pair from `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` becomes a `kraken`
// connection with the credentials encrypted (`encryptSecret()`), so the
// sync reads it like a bank session. A sync is two runs: the balance sync
// (the crypto account and its EUR cash, F-008) and then the holdings run,
// which fetches `BalanceEx` and the ledger first and writes the holding
// snapshots and investment transactions in one database transaction.

const PROVIDER = "kraken";
export const KRAKEN_INSTITUTION_REF = "kraken";
/** Ledger entries are re-read this many days before the newest stored. */
const LEDGER_OVERLAP_DAYS = 7;
const INSERT_BATCH = 500;

type KrakenEnv = Partial<Pick<Env, "KRAKEN_API_KEY" | "KRAKEN_API_SECRET">>;

export interface EnsureKrakenOptions {
  db?: Db;
  env?: KrakenEnv;
  encrypt?: (plaintext: string) => string;
  decrypt?: (value: string) => string;
}

/**
 * The Kraken connection for the configured key pair, created on first use;
 * a changed key replaces the stored one and makes an expired connection
 * active again. Null when no key is configured.
 */
export async function ensureKrakenConnection(
  options: EnsureKrakenOptions = {},
): Promise<string | null> {
  const env = options.env ?? getEnv();
  if (!env.KRAKEN_API_KEY || !env.KRAKEN_API_SECRET) return null;
  const db = options.db ?? getDb();
  const encrypt = options.encrypt ?? ((value) => encryptSecret(value));
  const decrypt = options.decrypt ?? ((value) => decryptSecret(value));
  const plaintext = krakenCredentials({
    key: env.KRAKEN_API_KEY,
    secret: env.KRAKEN_API_SECRET,
  });

  return db.transaction(async (tx) => {
    await tx
      .insert(institutions)
      .values({
        name: "Kraken",
        country: "IE",
        provider: PROVIDER,
        providerRef: KRAKEN_INSTITUTION_REF,
      })
      .onConflictDoNothing({
        target: [institutions.provider, institutions.providerRef],
      });
    const [institution] = await tx
      .select({ id: institutions.id })
      .from(institutions)
      .where(
        and(
          eq(institutions.provider, PROVIDER),
          eq(institutions.providerRef, KRAKEN_INSTITUTION_REF),
        ),
      );
    const [existing] = await tx
      .select({ id: connections.id, sessionRef: connections.sessionRef })
      .from(connections)
      .where(
        and(
          eq(connections.institutionId, institution.id),
          ne(connections.status, "archived"),
        ),
      )
      .orderBy(asc(connections.createdAt))
      .limit(1);
    if (!existing) {
      const [created] = await tx
        .insert(connections)
        .values({
          institutionId: institution.id,
          provider: PROVIDER,
          sessionRef: encrypt(plaintext),
        })
        .returning({ id: connections.id });
      return created.id;
    }
    let same = false;
    try {
      same =
        existing.sessionRef !== null &&
        decrypt(existing.sessionRef) === plaintext;
    } catch (error) {
      // Encrypted under an older ENCRYPTION_KEY: store it again.
      if (!(error instanceof DecryptionError)) throw error;
    }
    if (!same) {
      await tx
        .update(connections)
        .set({
          sessionRef: encrypt(plaintext),
          status: "active",
          updatedAt: new Date(),
        })
        .where(eq(connections.id, existing.id));
    }
    return existing.id;
  });
}

export interface KrakenAccountCounts {
  accountId: string;
  /** Positions `BalanceEx` reported. */
  holdings: number;
  /** Assets that dropped out and got a 0 snapshot. */
  zeroed: number;
  /** Ledger entries mapped to transactions. */
  fetched: number;
  /** New investment transactions (the rest were stored already). */
  inserted: number;
  skipped: ProviderSkippedEntry[];
}

export type KrakenHoldingsResult =
  | {
      runId: string;
      status: "succeeded";
      error: null;
      accounts: KrakenAccountCounts[];
    }
  | ({ runId: string; accounts: [] } & SyncFailure);

export interface KrakenSyncResult {
  connectionId: string;
  balances: SyncBalancesResult;
  /** Null when the balance sync failed, so the holdings were not fetched. */
  holdings: KrakenHoldingsResult | null;
}

export interface KrakenSyncOptions extends SyncOptions {
  /** The calendar day of the snapshots; defaults to `APP_TIMEZONE`. */
  timeZone?: string;
}

interface Fetched {
  accountId: string;
  holdings: ProviderHolding[];
  history: ProviderInvestmentHistory;
}

/** The newest stored trade day of the account, less the overlap. */
async function ledgerStart(db: Db, accountId: string): Promise<IsoDate | null> {
  const [row] = await db
    .select({ latest: max(investmentTransactions.tradeDate) })
    .from(investmentTransactions)
    .where(eq(investmentTransactions.accountId, accountId));
  return row?.latest ? addDays(row.latest, -LEDGER_OVERLAP_DAYS) : null;
}

/**
 * Upserts today's snapshots and writes an explicit 0 for every asset the
 * account held before but `BalanceEx` no longer lists (D-016), then adds
 * the new ledger entries (Kraken's ledger id is the identity).
 */
async function storeAccount(
  tx: Tx,
  fetched: Fetched,
  today: IsoDate,
): Promise<KrakenAccountCounts> {
  const { accountId } = fetched;
  const held = new Set<string>();
  for (const holding of fetched.holdings) {
    const assetId = await findOrCreateAsset(tx, holding);
    held.add(assetId);
    await tx
      .insert(holdings)
      .values({
        accountId,
        assetId,
        date: holding.date,
        quantity: holding.quantity,
      })
      .onConflictDoUpdate({
        target: [holdings.accountId, holdings.assetId, holdings.date],
        set: { quantity: sql`excluded.quantity`, updatedAt: sql`now()` },
      });
  }

  const latest = await tx
    .selectDistinctOn([holdings.assetId], {
      assetId: holdings.assetId,
      quantity: holdings.quantity,
    })
    .from(holdings)
    .where(eq(holdings.accountId, accountId))
    .orderBy(asc(holdings.assetId), desc(holdings.date));
  let zeroed = 0;
  for (const row of latest) {
    if (held.has(row.assetId) || parseDecimal(row.quantity) === BigInt(0)) {
      continue;
    }
    await tx
      .insert(holdings)
      .values({ accountId, assetId: row.assetId, date: today, quantity: "0" })
      .onConflictDoUpdate({
        target: [holdings.accountId, holdings.assetId, holdings.date],
        set: { quantity: "0", updatedAt: sql`now()` },
      });
    zeroed++;
  }

  const values = [];
  for (const transaction of fetched.history.transactions) {
    values.push({
      accountId,
      assetId: transaction.asset
        ? await findOrCreateAsset(tx, transaction.asset)
        : null,
      type: transaction.type,
      providerTxnRef: transaction.ref,
      dedupeHash: `${PROVIDER}:${transaction.ref}`,
      tradeDate: transaction.tradeDate,
      quantity: transaction.quantity,
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
      description: transaction.description,
    });
  }
  let inserted = 0;
  for (let start = 0; start < values.length; start += INSERT_BATCH) {
    const written = await tx
      .insert(investmentTransactions)
      .values(values.slice(start, start + INSERT_BATCH))
      .onConflictDoNothing()
      .returning({ id: investmentTransactions.id });
    inserted += written.length;
  }

  return {
    accountId,
    holdings: fetched.holdings.length,
    zeroed,
    fetched: values.length,
    inserted,
    skipped: fetched.history.skipped,
  };
}

/** The holdings run of one connection, after its balance sync. */
async function syncConnectionHoldings(
  connectionId: string,
  options: KrakenSyncOptions,
): Promise<KrakenHoldingsResult> {
  const db = options.db ?? getDb();
  const now = options.now ?? (() => new Date());
  const timeZone = options.timeZone ?? getEnv().APP_TIMEZONE;
  const { connection, runId } = await startRun(
    db,
    connectionId,
    "holdings",
    now,
  );
  const failed = (failure: SyncFailure): KrakenHoldingsResult => ({
    runId,
    accounts: [],
    ...failure,
  });

  try {
    if (connection.status !== "active") {
      return failed(await failNotActive(db, runId, connection, now));
    }
    const accountRows = await db
      .select({ id: accounts.id, ref: accounts.providerAccountRef })
      .from(accounts)
      .where(
        and(
          eq(accounts.connectionId, connection.id),
          eq(accounts.archived, false),
        ),
      )
      .orderBy(asc(accounts.createdAt));

    const fetched: Fetched[] = [];
    try {
      const { provider, session } = openConnection(connection, options);
      if (!provider.getHoldings || !provider.getInvestmentTransactions) {
        throw new Error(`Provider ${provider.id} has no holdings`);
      }
      for (const account of accountRows) {
        if (account.ref === null) continue;
        const from = await ledgerStart(db, account.id);
        fetched.push({
          accountId: account.id,
          holdings: await provider.getHoldings(session, account.ref),
          history: await provider.getInvestmentTransactions(
            session,
            account.ref,
            from ? { from } : {},
          ),
        });
      }
    } catch (error) {
      if (!isProviderError(error)) throw error;
      return failed(
        await recordProviderFailure(db, runId, connection.id, error, now),
      );
    }

    return await db.transaction(async (tx) => {
      const today = localDate(now(), timeZone);
      const counts: KrakenAccountCounts[] = [];
      for (const account of fetched) {
        counts.push(await storeAccount(tx, account, today));
      }
      const finishedAt = now();
      await finishRun(tx, runId, finishedAt, {
        status: "succeeded",
        accountsCount: counts.length,
        fetchedCount: counts.reduce((n, c) => n + c.holdings + c.fetched, 0),
        insertedCount: counts.reduce((n, c) => n + c.inserted, 0),
        updatedCount: counts.reduce((n, c) => n + c.holdings + c.zeroed, 0),
      });
      await tx
        .update(connections)
        .set({ lastSyncedAt: finishedAt })
        .where(eq(connections.id, connection.id));
      return {
        runId,
        status: "succeeded" as const,
        error: null,
        accounts: counts,
      };
    });
  } catch (error) {
    await failRunOnBug(db, runId, error, now);
    throw error;
  }
}

/**
 * Syncs one Kraken connection: the account and its EUR cash, then the
 * holdings and the ledger. Provider failures are results, not exceptions;
 * an auth failure marks the connection `expired` (a new key reactivates
 * it through `ensureKrakenConnection()`).
 */
export async function syncKrakenConnection(
  connectionId: string,
  options: KrakenSyncOptions = {},
): Promise<KrakenSyncResult> {
  const balances = await syncBalances(connectionId, options);
  if (balances.status === "failed") {
    return { connectionId, balances, holdings: null };
  }
  return {
    connectionId,
    balances,
    holdings: await syncConnectionHoldings(connectionId, options),
  };
}

/** Every active Kraken connection, after storing the configured key. */
export async function syncKraken(
  options: KrakenSyncOptions &
    Pick<EnsureKrakenOptions, "env" | "encrypt"> = {},
): Promise<KrakenSyncResult[]> {
  const db = options.db ?? getDb();
  await ensureKrakenConnection({ ...options, db });
  const active = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(eq(connections.provider, PROVIDER), eq(connections.status, "active")),
    )
    .orderBy(asc(connections.createdAt));
  const results: KrakenSyncResult[] = [];
  for (const connection of active) {
    results.push(await syncKrakenConnection(connection.id, { ...options, db }));
  }
  return results;
}
