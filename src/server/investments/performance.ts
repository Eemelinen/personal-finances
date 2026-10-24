// Portfolio performance (F-022): the value of the investment accounts over
// a range split into what was put in and what the market added. Pure;
// `queries/portfolio.ts` builds the inputs from `investmentAccountSeries()`.
//
// Contributed starts at the portfolio's value on the range's first day (0
// when nothing is known yet) and then moves with the external flows:
// deposits and withdrawals of cash, units transferred in or out at the day's
// price, and for accounts without transactions (manual wallets) the
// quantity changes between snapshots. An account whose value first becomes
// known within the range (a new account, or the first day of its data)
// brings that value in as a contribution, so adding an account is not a
// gain. Units an account holds on its first day (in the range or of its
// data) without a price yet are left out of that value and come in as a
// flow on the day they are first priced (`holdingsSeries()`). Everything
// else that changes the value (price moves, dividends, fees, buying below
// or above the close) is the market gain: value − contributed.

export interface PerformanceAccountInput {
  /** The account's value (cash + holdings) per day; null where unknown. */
  values: readonly (number | null)[];
  /** External flows per day in EUR minor units: + in, − out. */
  flows: readonly number[];
}

export interface PerformancePoint {
  /** Σ of the known account values; null on a day none is known. */
  valueMinor: number | null;
  /** Value at the start plus the net contributions since; null with it. */
  contributedMinor: number | null;
  /** Value − contributed; null with it. */
  gainMinor: number | null;
}

export interface PortfolioPerformance {
  points: PerformancePoint[];
  /** The value on the range's first day; null when unknown then. */
  startMinor: number | null;
  /** The value on the last day; null when unknown. */
  endMinor: number | null;
  /**
   * Net contributions after the first day (+ in, − out), an account's value
   * on the day it enters included: start + contributions + gain = end.
   */
  contributionsMinor: number;
  /** Market gain over the range: the last day's gain. */
  gainMinor: number | null;
}

/**
 * Value, contributed and gain per day over `dayCount` days. An account that
 * stops having a value (it cannot today: balances and holdings carry over)
 * takes its last value out as a withdrawal.
 */
export function portfolioPerformance(
  accounts: readonly PerformanceAccountInput[],
  dayCount: number,
): PortfolioPerformance {
  let contributed: number | null = null;
  const points: PerformancePoint[] = [];
  for (let day = 0; day < dayCount; day++) {
    let valueMinor: number | null = null;
    let change = 0;
    for (const account of accounts) {
      const value = account.values[day] ?? null;
      const previous = day > 0 ? (account.values[day - 1] ?? null) : null;
      if (value !== null) {
        valueMinor = (valueMinor ?? 0) + value;
        // Entering: its whole value comes in, the day's flows with it.
        change += previous === null ? value : (account.flows[day] ?? 0);
      } else if (previous !== null) {
        change -= previous;
      }
    }
    if (valueMinor !== null || contributed !== null) {
      contributed = (contributed ?? 0) + change;
    }
    points.push({
      valueMinor,
      contributedMinor: valueMinor === null ? null : contributed,
      gainMinor:
        valueMinor === null || contributed === null
          ? null
          : valueMinor - contributed,
    });
  }
  const startMinor = points[0]?.valueMinor ?? null;
  const last = points.at(-1);
  return {
    points,
    startMinor,
    endMinor: last?.valueMinor ?? null,
    contributionsMinor: (contributed ?? 0) - (startMinor ?? 0),
    gainMinor: last?.gainMinor ?? null,
  };
}
