import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { assets } from "@/server/db/schema";
import type { ProviderAsset } from "@/server/providers/types";
import type { Tx } from "@/server/sync/runs";

// Matches a provider's asset to an `assets` row (D-016): by ISIN, else by
// CoinGecko id, else by symbol, currency and class among assets without an
// ISIN (preferring one with a CoinGecko id); adds it when there is none.
// Used by the Kraken sync and manual holdings (F-021); the Nordnet import
// has its own rule for quote currencies.

async function find(tx: Tx, asset: ProviderAsset) {
  const where =
    asset.isin !== null
      ? eq(assets.isin, asset.isin)
      : asset.coingeckoId !== null
        ? eq(assets.coingeckoId, asset.coingeckoId)
        : and(
            isNull(assets.isin),
            eq(assets.symbol, asset.symbol),
            eq(assets.currency, asset.currency),
            eq(assets.assetClass, asset.assetClass),
          );
  const [found] = await tx
    .select({ id: assets.id })
    .from(assets)
    .where(where)
    // A symbol shared by several: the one with a price feed.
    .orderBy(sql`${assets.coingeckoId} is null`, asc(assets.createdAt))
    .limit(1);
  return found;
}

/** An asset of the symbol that has no CoinGecko id yet. */
async function findUnmapped(tx: Tx, asset: ProviderAsset) {
  const [found] = await tx
    .select({ id: assets.id })
    .from(assets)
    .where(
      and(
        isNull(assets.isin),
        isNull(assets.coingeckoId),
        eq(assets.symbol, asset.symbol),
        eq(assets.currency, asset.currency),
        eq(assets.assetClass, asset.assetClass),
      ),
    )
    .orderBy(asc(assets.createdAt))
    .limit(1);
  return found;
}

/**
 * The asset's id. A coin first stored without a CoinGecko id (a manual
 * holding of an unknown symbol) gets the id when a later source knows it.
 */
export async function findOrCreateAsset(
  tx: Tx,
  asset: ProviderAsset,
): Promise<string> {
  const found = await find(tx, asset);
  if (found) return found.id;
  if (asset.isin === null && asset.coingeckoId !== null) {
    const unmapped = await findUnmapped(tx, asset);
    if (unmapped) {
      await tx
        .update(assets)
        .set({ coingeckoId: asset.coingeckoId, updatedAt: new Date() })
        .where(eq(assets.id, unmapped.id));
      return unmapped.id;
    }
  }
  const [created] = await tx
    .insert(assets)
    .values({
      symbol: asset.symbol,
      name: asset.name,
      isin: asset.isin,
      coingeckoId: asset.coingeckoId,
      assetClass: asset.assetClass,
      currency: asset.currency,
    })
    .onConflictDoNothing()
    .returning({ id: assets.id });
  return created?.id ?? (await find(tx, asset))!.id;
}
