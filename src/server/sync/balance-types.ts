// Which of an account's ISO 20022 balance types the app shows as "the"
// balance. Syncs store every type the provider reports; this only decides
// which one a view picks.

/**
 * Most preferred first: what is available now, then what is booked now,
 * then the closing balances of the previous day, then the opening ones.
 */
export const DEFAULT_BALANCE_TYPE_PREFERENCE: readonly string[] = [
  "ITAV",
  "CLAV",
  "ITBD",
  "CLBD",
  "XPCD",
  "OPAV",
  "OPBD",
];

/**
 * Per-bank overrides, keyed by `institutions.provider_ref` (the ASPSP name
 * at Enable Banking). Empty until the F-001 findings record which type each
 * bank fills reliably; every bank uses the default until then.
 */
export const BALANCE_TYPE_PREFERENCE_BY_INSTITUTION: Readonly<
  Record<string, readonly string[]>
> = {};

export function balanceTypePreference(
  institutionRef: string | null | undefined,
): readonly string[] {
  return (
    (institutionRef
      ? BALANCE_TYPE_PREFERENCE_BY_INSTITUTION[institutionRef]
      : undefined) ?? DEFAULT_BALANCE_TYPE_PREFERENCE
  );
}

interface BalanceLike {
  balanceType: string;
  /** `YYYY-MM-DD`. */
  date: string;
}

/**
 * The balance to display: the most preferred type the account has (types
 * not in the list come last, in code order), and of that type the latest
 * day. Undefined when there are no balances.
 */
export function pickDisplayBalance<T extends BalanceLike>(
  balances: readonly T[],
  preference: readonly string[] = DEFAULT_BALANCE_TYPE_PREFERENCE,
): T | undefined {
  const rank = (type: string) => {
    const index = preference.indexOf(type);
    return index === -1 ? preference.length : index;
  };
  let best: T | undefined;
  for (const balance of balances) {
    if (!best) {
      best = balance;
      continue;
    }
    const byRank = rank(balance.balanceType) - rank(best.balanceType);
    const better =
      byRank < 0 ||
      (byRank === 0 &&
        (balance.balanceType < best.balanceType ||
          (balance.balanceType === best.balanceType &&
            balance.date > best.date)));
    if (better) best = balance;
  }
  return best;
}
