// Which of an account's ISO 20022 balance types the app shows as "the"
// balance. Syncs store every type the provider reports; this only decides
// which one a view picks.

/**
 * A balance the user typed for an account no connection syncs (F-029,
 * "Balance on date" under Settings → Accounts); not an ISO 20022 type. It
 * comes last in every list: a synced type of the same day wins.
 */
export const MANUAL_BALANCE_TYPE = "manual";

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
  MANUAL_BALANCE_TYPE,
];

/**
 * Booked before available: for Nordea `ITAV` differs from `ITBD` on a
 * normal day, and an S-Pankki card's `ITAV` includes its credit limit
 * (FIN-001 Findings). To be checked against the netbank in F-013.
 */
const BOOKED_FIRST: readonly string[] = [
  "ITBD",
  "CLBD",
  "ITAV",
  "CLAV",
  "XPCD",
  "OPBD",
  "OPAV",
  MANUAL_BALANCE_TYPE,
];

/**
 * Per-bank overrides, keyed by `institutions.provider_ref` (the ASPSP name
 * at Enable Banking); other banks use the default.
 */
export const BALANCE_TYPE_PREFERENCE_BY_INSTITUTION: Readonly<
  Record<string, readonly string[]>
> = {
  Nordea: BOOKED_FIRST,
  "S-Pankki": BOOKED_FIRST,
};

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
