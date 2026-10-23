import type {
  FinancialProvider,
  ProviderAccountRef,
  ProviderConnection,
  ProviderTransaction,
  TransactionRange,
} from "./types";

/** More pages than any real listing has: a provider that loops is a bug. */
export const MAX_TRANSACTION_PAGES = 1_000;

/**
 * Every transaction of `account` in `range`: requests page after page, one
 * at a time, until the provider returns no continuation key. A typed
 * provider error on any page rejects the whole listing.
 */
export async function fetchAllTransactions(
  provider: FinancialProvider,
  connection: ProviderConnection,
  account: ProviderAccountRef,
  range: TransactionRange,
  maxPages: number = MAX_TRANSACTION_PAGES,
): Promise<ProviderTransaction[]> {
  const transactions: ProviderTransaction[] = [];
  const seen = new Set<string>();
  let continuationKey: string | undefined;
  for (let page = 1; ; page++) {
    const result = await provider.getTransactions(
      connection,
      account,
      range,
      continuationKey,
    );
    transactions.push(...result.transactions);
    if (result.continuationKey === null) return transactions;
    if (seen.has(result.continuationKey) || page >= maxPages) {
      throw new Error(
        `${provider.id} kept paging the transactions of ${JSON.stringify(account)} (page ${page})`,
      );
    }
    seen.add(result.continuationKey);
    continuationKey = result.continuationKey;
  }
}
