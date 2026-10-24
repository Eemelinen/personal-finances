import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { accounts, holdings, institutions } from "@/server/db/schema";
import type { IsoDate } from "@/server/providers/types";
import type { Tx } from "@/server/sync/runs";
import { findOrCreateAsset } from "./assets";
import { KNOWN_COINS } from "./coins";
import { formatDecimal, parseDecimal } from "./decimal";

// Manual crypto holdings (F-021, D-018) for wallets without an API (a
// hardware wallet, an exchange without a read-only key): each wallet is a
// `crypto` account under the `manual` institution, and every save writes
// that day's quantity snapshot, so the holding is valued like a synced
// one. A quantity of 0 records that the coins are gone.

export const MANUAL_INSTITUTION_REF = "manual";
const CURRENCY = "EUR";

export class ManualHoldingError extends Error {
  override readonly name = "ManualHoldingError";
}

export interface ManualHoldingInput {
  /** The wallet's name, e.g. `Ledger`; one account per name. */
  wallet: string;
  /** Coin symbol, e.g. `BTC`. */
  symbol: string;
  /** Optional for the coins in `KNOWN_COINS`. */
  coingeckoId: string | null;
  /** Units held, a decimal string. */
  quantity: string;
  date: IsoDate;
}

export interface ManualHolding {
  accountId: string;
  assetId: string;
  /** The wallet's account was created by this save. */
  created: boolean;
  quantity: string;
  coingeckoId: string | null;
}

const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,19}$/;
const COINGECKO_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** The input, trimmed and checked; throws `ManualHoldingError`. */
export function normaliseManualHolding(
  input: ManualHoldingInput,
): ManualHoldingInput {
  const wallet = input.wallet.trim();
  if (wallet.length === 0 || wallet.length > 80) {
    throw new ManualHoldingError("Name the wallet (at most 80 characters).");
  }
  const symbol = input.symbol.trim().toUpperCase();
  if (!SYMBOL.test(symbol)) {
    throw new ManualHoldingError(
      "The coin symbol takes letters and digits, e.g. BTC.",
    );
  }
  const given = input.coingeckoId?.trim().toLowerCase() || null;
  if (given !== null && !COINGECKO_ID.test(given)) {
    throw new ManualHoldingError(
      "The CoinGecko id takes lowercase letters, digits and dashes, e.g. bitcoin.",
    );
  }
  let units: bigint;
  try {
    units = parseDecimal(input.quantity.trim().replace(",", "."));
  } catch {
    throw new ManualHoldingError(
      "The quantity must be a number with at most 18 decimals.",
    );
  }
  if (units < BigInt(0)) {
    throw new ManualHoldingError("The quantity cannot be negative.");
  }
  return {
    wallet,
    symbol,
    coingeckoId: given ?? KNOWN_COINS[symbol]?.coingeckoId ?? null,
    quantity: formatDecimal(units),
    date: input.date,
  };
}

async function manualInstitution(tx: Tx): Promise<string> {
  await tx
    .insert(institutions)
    .values({
      name: "Manual",
      country: "FI",
      provider: "manual",
      providerRef: MANUAL_INSTITUTION_REF,
    })
    .onConflictDoNothing({
      target: [institutions.provider, institutions.providerRef],
    });
  const [institution] = await tx
    .select({ id: institutions.id })
    .from(institutions)
    .where(
      and(
        eq(institutions.provider, "manual"),
        eq(institutions.providerRef, MANUAL_INSTITUTION_REF),
      ),
    );
  return institution.id;
}

/** Stores the wallet's quantity of the coin on `date`. */
export async function setManualHolding(
  input: ManualHoldingInput,
  options: { db?: Db } = {},
): Promise<ManualHolding> {
  const db = options.db ?? getDb();
  const holding = normaliseManualHolding(input);
  return db.transaction(async (tx) => {
    const institutionId = await manualInstitution(tx);
    const [existing] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.institutionId, institutionId),
          eq(accounts.name, holding.wallet),
          eq(accounts.archived, false),
        ),
      )
      .orderBy(asc(accounts.createdAt))
      .limit(1);
    const account =
      existing ??
      (
        await tx
          .insert(accounts)
          .values({
            institutionId,
            type: "crypto",
            name: holding.wallet,
            currency: CURRENCY,
          })
          .returning({ id: accounts.id })
      )[0];
    const assetId = await findOrCreateAsset(tx, {
      symbol: holding.symbol,
      name: KNOWN_COINS[holding.symbol]?.name ?? null,
      isin: null,
      coingeckoId: holding.coingeckoId,
      assetClass: "crypto",
      currency: CURRENCY,
    });
    await tx
      .insert(holdings)
      .values({
        accountId: account.id,
        assetId,
        date: holding.date,
        quantity: holding.quantity,
      })
      .onConflictDoUpdate({
        target: [holdings.accountId, holdings.assetId, holdings.date],
        set: { quantity: sql`excluded.quantity`, updatedAt: sql`now()` },
      });
    return {
      accountId: account.id,
      assetId,
      created: !existing,
      quantity: holding.quantity,
      coingeckoId: holding.coingeckoId,
    };
  });
}
