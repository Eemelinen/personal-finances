import { dedupeHash, normaliseText } from "@/server/dedupe-hash";
import type { IsoDate, ProviderTransaction } from "@/server/providers/types";

// The pure part of the transaction sync (F-009): which days to ask for, the
// identity of each fetched transaction and how a listing merges into what is
// stored. `sync-transactions.ts` does the I/O around it.

/** An incremental sync re-reads this many days before the last one. */
export const OVERLAP_DAYS = 7;

/**
 * A pending transaction and its booked version may be dated up to this many
 * days apart (the card authorisation day versus the booking day).
 */
export const PENDING_MATCH_DAYS = 7;

/** The columns a sync writes; never category, note or transfer group. */
export interface TransactionValues {
  providerTxnRef: string | null;
  dedupeHash: string;
  bookingDate: IsoDate;
  valueDate: IsoDate | null;
  amountMinor: number;
  currency: string;
  counterparty: string | null;
  description: string | null;
  status: "booked" | "pending";
}

export interface StoredTransaction extends TransactionValues {
  id: string;
}

export interface TransactionUpdate {
  id: string;
  values: TransactionValues;
  /** The ref or hash changes, so the unique keys must be freed first. */
  rekey: boolean;
}

export interface MergePlan {
  insert: TransactionValues[];
  update: TransactionUpdate[];
  /** Stored pending transactions the provider no longer lists. */
  remove: string[];
  /** Fetched transactions already stored exactly as they are. */
  unchanged: number;
}

const DAY_MS = 86_400_000;

function dayNumber(date: IsoDate): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

function addDays(date: IsoDate, days: number): IsoDate {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** The calendar day of `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): IsoDate {
  // `en-CA` formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * The first day an account's sync asks for, or undefined for a backfill
 * (the oldest day the provider can return). Incremental: the local day of
 * the last successful sync minus `OVERLAP_DAYS`, moved back to the oldest
 * stored pending transaction, so a pending one that went away is seen as
 * gone.
 */
export function syncWindowStart(input: {
  syncedAt: Date | null;
  oldestPendingDate: IsoDate | null;
  timeZone: string;
  overlapDays?: number;
}): IsoDate | undefined {
  if (input.syncedAt === null) return undefined;
  const start = addDays(
    localDate(input.syncedAt, input.timeZone),
    -(input.overlapDays ?? OVERLAP_DAYS),
  );
  const pending = input.oldestPendingDate;
  return pending !== null && pending < start ? pending : start;
}

/**
 * Normalises a listing into the stored columns. A ref listed twice keeps its
 * last version. Otherwise identical transactions (same day, amount and
 * texts) get an occurrence number in their hash, numbered in ref order and
 * then listing order, so the second equal coffee is not taken for the first.
 */
export function identifyTransactions(
  fetched: readonly ProviderTransaction[],
): TransactionValues[] {
  const lastByRef = new Map<string, number>();
  fetched.forEach((txn, index) => {
    if (txn.ref !== null) lastByRef.set(txn.ref, index);
  });
  const listing = fetched.filter(
    (txn, index) => txn.ref === null || lastByRef.get(txn.ref) === index,
  );

  const groups = new Map<string, number[]>();
  const baseHashes = listing.map((txn, index) => {
    const hash = dedupeHash(txn);
    groups.set(hash, [...(groups.get(hash) ?? []), index]);
    return hash;
  });
  const occurrences = new Map<number, number>();
  for (const members of groups.values()) {
    const ordered = [...members].sort((a, b) => {
      const refA = listing[a].ref;
      const refB = listing[b].ref;
      if (refA !== null && refB !== null) return refA < refB ? -1 : 1;
      if (refA !== null) return -1;
      if (refB !== null) return 1;
      return a - b;
    });
    ordered.forEach((index, position) => occurrences.set(index, position + 1));
  }

  return listing.map((txn, index) => {
    const occurrence = occurrences.get(index)!;
    return {
      providerTxnRef: txn.ref,
      dedupeHash:
        occurrence === 1
          ? baseHashes[index]
          : dedupeHash({ ...txn, occurrence }),
      bookingDate: txn.bookingDate,
      valueDate: txn.valueDate,
      amountMinor: txn.amountMinor,
      currency: txn.currency,
      counterparty: txn.counterparty,
      description: txn.description,
      status: txn.status,
    };
  });
}

function sameValues(a: TransactionValues, b: TransactionValues): boolean {
  return (
    a.providerTxnRef === b.providerTxnRef &&
    a.dedupeHash === b.dedupeHash &&
    a.bookingDate === b.bookingDate &&
    a.valueDate === b.valueDate &&
    a.amountMinor === b.amountMinor &&
    a.currency === b.currency &&
    a.counterparty === b.counterparty &&
    a.description === b.description &&
    a.status === b.status
  );
}

/**
 * Merges a listing into the stored transactions of one account. `stored`
 * must hold every pending transaction of the account and every one sharing
 * a ref or hash with the listing. Each fetched transaction is matched, in
 * this order, to the stored one with its ref, then to the one with its hash,
 * then to a pending one with the same amount and currency at most
 * `PENDING_MATCH_DAYS` away (same counterparty first, then the nearest day):
 * that is how a pending transaction is replaced by its booked version even
 * when the bank gives the booked one a new id, date or text. A match is
 * updated in place, so its id, category, note and transfer link survive; an
 * unmatched one is inserted; a stored pending one nothing matched is removed.
 * Booked transactions the listing lacks are kept.
 */
export function mergeTransactions(
  stored: readonly StoredTransaction[],
  fetched: readonly TransactionValues[],
): MergePlan {
  const claimed = new Set<string>();
  const matches = new Array<StoredTransaction | undefined>(fetched.length);
  const claim = (index: number, row: StoredTransaction | undefined) => {
    if (row === undefined || claimed.has(row.id)) return;
    matches[index] = row;
    claimed.add(row.id);
  };

  const byRef = new Map<string, StoredTransaction>();
  const byHash = new Map<string, StoredTransaction>();
  for (const row of stored) {
    if (row.providerTxnRef !== null) byRef.set(row.providerTxnRef, row);
    byHash.set(row.dedupeHash, row);
  }

  fetched.forEach((txn, index) => {
    if (txn.providerTxnRef !== null)
      claim(index, byRef.get(txn.providerTxnRef));
  });
  fetched.forEach((txn, index) => {
    if (!matches[index]) claim(index, byHash.get(txn.dedupeHash));
  });
  fetched.forEach((txn, index) => {
    if (!matches[index]) claim(index, closestPending(stored, claimed, txn));
  });

  // A transaction matched by its ref can hash like a stored one nothing
  // matched (a duplicate without a ref): it takes the next free occurrence,
  // so `(account_id, dedupe_hash)` stays unique.
  const inUse = new Set(fetched.map((txn) => txn.dedupeHash));
  for (const row of stored) {
    if (!claimed.has(row.id) && row.status === "booked") {
      inUse.add(row.dedupeHash);
    }
  }
  const kept = new Set(
    stored
      .filter((row) => !claimed.has(row.id) && row.status === "booked")
      .map((row) => row.dedupeHash),
  );

  const plan: MergePlan = { insert: [], update: [], remove: [], unchanged: 0 };
  fetched.forEach((txn, index) => {
    const row = matches[index];
    if (!row) {
      plan.insert.push(txn);
      return;
    }
    let hash = txn.dedupeHash;
    for (let occurrence = 2; kept.has(hash); occurrence++) {
      const candidate = dedupeHash({ ...txn, occurrence });
      if (!inUse.has(candidate)) {
        hash = candidate;
        inUse.add(hash);
        break;
      }
    }
    // A bank that drops an id on a later listing does not erase ours.
    const values = {
      ...txn,
      dedupeHash: hash,
      providerTxnRef: txn.providerTxnRef ?? row.providerTxnRef,
    };
    if (sameValues(values, row)) {
      plan.unchanged++;
      return;
    }
    plan.update.push({
      id: row.id,
      values,
      rekey:
        values.providerTxnRef !== row.providerTxnRef ||
        values.dedupeHash !== row.dedupeHash,
    });
  });
  for (const row of stored) {
    if (row.status === "pending" && !claimed.has(row.id)) {
      plan.remove.push(row.id);
    }
  }
  return plan;
}

function closestPending(
  stored: readonly StoredTransaction[],
  claimed: ReadonlySet<string>,
  txn: TransactionValues,
): StoredTransaction | undefined {
  const counterparty = normaliseText(txn.counterparty);
  let best: { row: StoredTransaction; score: [number, number] } | undefined;
  for (const row of stored) {
    if (
      row.status !== "pending" ||
      claimed.has(row.id) ||
      row.amountMinor !== txn.amountMinor ||
      row.currency !== txn.currency
    ) {
      continue;
    }
    const distance = Math.abs(
      dayNumber(row.bookingDate) - dayNumber(txn.bookingDate),
    );
    if (distance > PENDING_MATCH_DAYS) continue;
    const score: [number, number] = [
      normaliseText(row.counterparty) === counterparty ? 0 : 1,
      distance,
    ];
    if (
      !best ||
      score[0] < best.score[0] ||
      (score[0] === best.score[0] && score[1] < best.score[1])
    ) {
      best = { row, score };
    }
  }
  return best?.row;
}
