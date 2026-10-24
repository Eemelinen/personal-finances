import { normalizeIban } from "@/server/iban";
import type { IsoDate } from "@/server/providers/types";

// Own-transfer detection (F-014, D-012), pure. A debit on one own account
// and a credit of the same absolute amount and currency on another own
// account at most 3 days apart are the two legs of one transfer. A leg whose
// counterparty account (`counterpartyIban`, F-028) or, failing that, whose
// counterparty or description text names the IBAN of another own account is
// a transfer to that account: it pairs only with a leg there, and stays a
// one-sided transfer when that account has no matching leg (yet).
//
// Guards against equal amounts that are not transfers: both legs on one
// account never pair (a refund), and a leg a rule put into any category but
// Transfers (`eligible: false`, e.g. a grocery purchase that happens to
// equal a payment a friend sent to the savings account) pairs only when an
// IBAN names one of them. Each leg is used once: the pairs closest in days
// are taken first, then the earlier ones.

export const TRANSFER_WINDOW_DAYS = 3;

export { normalizeIban };

/** IBANs shorter than this (normalised) are never searched for in texts. */
const MIN_IBAN_LENGTH = 15;

export interface TransferCandidate {
  id: string;
  accountId: string;
  bookingDate: IsoDate;
  amountMinor: number;
  currency: string;
  counterparty: string | null;
  /** The counterparty's IBAN, normalised, when the bank gave it. */
  counterpartyIban: string | null;
  description: string | null;
  /** Set on a one-sided transfer: a partner found later joins its group. */
  transferGroupId: string | null;
  /** False when a rule put it in a category other than Transfers. */
  eligible: boolean;
}

export interface OwnAccount {
  id: string;
  iban: string | null;
}

export interface TransferPair {
  /** The debit's id first. */
  ids: [debit: string, credit: string];
  /** The group of a one-sided leg the pair grows from; null: a new group. */
  groupId: string | null;
}

export interface TransferMatches {
  pairs: TransferPair[];
  /** Legs to an own IBAN without a partner: transfers on their own. */
  oneSided: string[];
}

const DAY_MS = 86_400_000;

function dayNumber(date: IsoDate): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

/**
 * Finds the transfers `subjects` take part in. `pool` holds every
 * transaction a subject may pair with (subjects may be in it too); the
 * caller passes only legs that are free: not manual, and not in a group or
 * the only member of one.
 */
export function findTransfers(input: {
  subjects: readonly TransferCandidate[];
  pool: readonly TransferCandidate[];
  accounts: readonly OwnAccount[];
}): TransferMatches {
  const ibans = input.accounts.flatMap((account) => {
    const iban = account.iban === null ? "" : normalizeIban(account.iban);
    return iban.length >= MIN_IBAN_LENGTH ? [{ id: account.id, iban }] : [];
  });
  /**
   * The other own account the leg's counterparty account is, else the one
   * whose IBAN its texts name, if any.
   */
  const namedAccount = (leg: TransferCandidate): string | null => {
    if (ibans.length === 0) return null;
    if (leg.counterpartyIban !== null) {
      const iban = normalizeIban(leg.counterpartyIban);
      const own = ibans.find(
        (account) => account.id !== leg.accountId && account.iban === iban,
      );
      if (own) return own.id;
    }
    const text = normalizeIban(
      `${leg.counterparty ?? ""}|${leg.description ?? ""}`,
    );
    const named = ibans.find(
      (account) => account.id !== leg.accountId && text.includes(account.iban),
    );
    return named?.id ?? null;
  };

  /**
   * Opposite amounts on two accounts within the window, and either both
   * eligible or one naming the other's IBAN (and neither another one's).
   */
  const distanceIfPair = (
    a: TransferCandidate,
    b: TransferCandidate,
  ): number | null => {
    if (
      a.id === b.id ||
      a.accountId === b.accountId ||
      a.amountMinor === 0 ||
      a.amountMinor !== -b.amountMinor ||
      a.currency !== b.currency ||
      (a.transferGroupId !== null && b.transferGroupId !== null)
    ) {
      return null;
    }
    const distance = Math.abs(
      dayNumber(a.bookingDate) - dayNumber(b.bookingDate),
    );
    if (distance > TRANSFER_WINDOW_DAYS) return null;
    const aNames = namedAccount(a);
    const bNames = namedAccount(b);
    if (aNames !== null && aNames !== b.accountId) return null;
    if (bNames !== null && bNames !== a.accountId) return null;
    if (aNames === null && bNames === null && !(a.eligible && b.eligible)) {
      return null;
    }
    return distance;
  };

  // Every possible pair, nearest first; then each leg is used once. The
  // pool is indexed by amount and currency, so only opposite legs are tried.
  const byAmount = new Map<string, TransferCandidate[]>();
  for (const leg of input.pool) {
    const key = `${leg.amountMinor}|${leg.currency}`;
    const legs = byAmount.get(key);
    if (legs) legs.push(leg);
    else byAmount.set(key, [leg]);
  }
  const edges = new Map<
    string,
    { debit: TransferCandidate; credit: TransferCandidate; distance: number }
  >();
  for (const subject of input.subjects) {
    const opposite = byAmount.get(
      `${-subject.amountMinor}|${subject.currency}`,
    );
    for (const leg of opposite ?? []) {
      const distance = distanceIfPair(subject, leg);
      if (distance === null) continue;
      const [debit, credit] =
        subject.amountMinor < 0 ? [subject, leg] : [leg, subject];
      edges.set(`${debit.id}|${credit.id}`, { debit, credit, distance });
    }
  }
  const ordered = [...edges.values()].sort(
    (a, b) =>
      a.distance - b.distance ||
      byDayThenId(a.debit, b.debit) ||
      byDayThenId(a.credit, b.credit),
  );

  const used = new Set<string>();
  const matches: TransferMatches = { pairs: [], oneSided: [] };
  for (const { debit, credit } of ordered) {
    if (used.has(debit.id) || used.has(credit.id)) continue;
    used.add(debit.id).add(credit.id);
    matches.pairs.push({
      ids: [debit.id, credit.id],
      groupId: debit.transferGroupId ?? credit.transferGroupId,
    });
  }
  for (const subject of [...input.subjects].sort(byDayThenId)) {
    if (
      !used.has(subject.id) &&
      subject.transferGroupId === null &&
      namedAccount(subject) !== null
    ) {
      used.add(subject.id);
      matches.oneSided.push(subject.id);
    }
  }
  return matches;
}

function byDayThenId(a: TransferCandidate, b: TransferCandidate): number {
  return a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id);
}
