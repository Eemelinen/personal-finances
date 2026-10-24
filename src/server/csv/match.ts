import { dayNumber } from "@/server/dates";
import { dedupeHash, normaliseText } from "@/server/dedupe-hash";
import type {
  StoredTransaction,
  TransactionValues,
} from "@/server/sync/transaction-merge";

// Which CSV rows an account already has (F-032). A bank's export and its API
// describe one transaction with other texts (S-Pankki's API has no
// description where the export fills in the kind; Nordea's API books some
// transfers a day after the export's date), so a hash alone misses most of
// them. `import-csv.ts` loads the stored rows and writes what this leaves.

/** A CSV row matches a stored one at most this many days from its dates. */
export const CSV_MATCH_DAYS = 3;

export type MatchableTransaction = Pick<
  StoredTransaction,
  | "id"
  | "providerTxnRef"
  | "dedupeHash"
  | "bookingDate"
  | "valueDate"
  | "amountMinor"
  | "currency"
  | "counterparty"
  | "counterpartyIban"
  | "description"
>;

export interface CsvMatch {
  /** Per CSV row: the id of the stored row it duplicates, or null. */
  matches: (string | null)[];
  /**
   * The rows nothing matched, ready to insert; one whose hash a stored row
   * already has takes the next free occurrence, so the unique key holds.
   */
  insert: TransactionValues[];
}

/**
 * Matches identified CSV rows (`identifyTransactions()`) to the stored
 * transactions of their account, each stored row at most once, in this
 * order: the same ref (S-Pankki's archive id is the bank's id), the same
 * hash (an earlier import of the file), then the same amount and currency
 * with the row's booking date at most `CSV_MATCH_DAYS` from the stored
 * row's booking or value date. Among several candidates the same
 * counterparty IBAN wins, then the most similar counterparty and
 * description, then the nearest day, then the oldest stored row (`stored`
 * is oldest first); the best pairs are taken first. A match is a duplicate:
 * nothing stored is changed. `stored` must hold every row of the account
 * sharing a ref with the file and every row dated within the window of
 * one of its rows.
 */
export function matchCsvRows(
  stored: readonly MatchableTransaction[],
  rows: readonly TransactionValues[],
): CsvMatch {
  const matches = new Array<string | null>(rows.length).fill(null);
  const claimed = new Set<string>();
  const claim = (index: number, row: MatchableTransaction | undefined) => {
    if (row === undefined || claimed.has(row.id) || matches[index] !== null) {
      return;
    }
    matches[index] = row.id;
    claimed.add(row.id);
  };

  const byRef = new Map<string, MatchableTransaction>();
  const byHash = new Map<string, MatchableTransaction>();
  for (const row of stored) {
    if (row.providerTxnRef !== null) byRef.set(row.providerTxnRef, row);
    byHash.set(row.dedupeHash, row);
  }
  rows.forEach((row, index) => {
    if (row.providerTxnRef !== null)
      claim(index, byRef.get(row.providerTxnRef));
  });
  rows.forEach((row, index) => claim(index, byHash.get(row.dedupeHash)));

  const pairs = candidatePairs(
    stored,
    rows,
    (index) => matches[index] !== null,
    claimed,
  );
  for (const pair of pairs) claim(pair.row, stored[pair.stored]);

  const inUse = new Set([
    ...stored.map((row) => row.dedupeHash),
    ...rows.map((row) => row.dedupeHash),
  ]);
  const storedHashes = new Set(stored.map((row) => row.dedupeHash));
  const insert = rows.flatMap((row, index) => {
    if (matches[index] !== null) return [];
    if (!storedHashes.has(row.dedupeHash)) return [row];
    let hash = row.dedupeHash;
    for (let occurrence = 2; inUse.has(hash); occurrence++) {
      hash = dedupeHash({ ...row, occurrence });
    }
    inUse.add(hash);
    return [{ ...row, dedupeHash: hash }];
  });
  return { matches, insert };
}

interface Pair {
  row: number;
  stored: number;
  /** Lower is better, compared in order. */
  score: [number, number, number, number, number];
}

function candidatePairs(
  stored: readonly MatchableTransaction[],
  rows: readonly TransactionValues[],
  matched: (index: number) => boolean,
  claimed: ReadonlySet<string>,
): Pair[] {
  const byAmount = new Map<string, number[]>();
  stored.forEach((row, index) => {
    if (claimed.has(row.id)) return;
    const key = `${row.currency} ${row.amountMinor}`;
    byAmount.set(key, [...(byAmount.get(key) ?? []), index]);
  });
  const pairs: Pair[] = [];
  rows.forEach((row, rowIndex) => {
    if (matched(rowIndex)) return;
    const text = textTokens(row);
    const day = dayNumber(row.bookingDate);
    for (const storedIndex of byAmount.get(
      `${row.currency} ${row.amountMinor}`,
    ) ?? []) {
      const candidate = stored[storedIndex];
      const distance = Math.min(
        Math.abs(dayNumber(candidate.bookingDate) - day),
        candidate.valueDate === null
          ? Infinity
          : Math.abs(dayNumber(candidate.valueDate) - day),
      );
      if (distance > CSV_MATCH_DAYS) continue;
      const sameIban =
        row.counterpartyIban !== null &&
        row.counterpartyIban === candidate.counterpartyIban;
      pairs.push({
        row: rowIndex,
        stored: storedIndex,
        score: [
          sameIban ? 0 : 1,
          -similarity(text, textTokens(candidate)),
          distance,
          storedIndex,
          rowIndex,
        ],
      });
    }
  });
  return pairs.sort((a, b) => {
    for (let i = 0; i < a.score.length; i++) {
      if (a.score[i] !== b.score[i]) return a.score[i] - b.score[i];
    }
    return 0;
  });
}

/** The distinct words of a row's normalised counterparty and description. */
function textTokens(
  row: Pick<TransactionValues, "counterparty" | "description">,
): Set<string> {
  const text = `${normaliseText(row.counterparty)} ${normaliseText(row.description)}`;
  return new Set(text.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== ""));
}

/** Dice coefficient of two word sets: 1 for the same words, 0 for none. */
function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return (2 * shared) / (a.size + b.size);
}
