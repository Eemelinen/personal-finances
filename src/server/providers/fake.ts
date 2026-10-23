import { createHash } from "node:crypto";
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "./errors";
import type {
  FinancialProvider,
  IsoDate,
  ProviderAccount,
  ProviderAccountRef,
  ProviderBalance,
  ProviderConnection,
  ProviderTransaction,
  ProviderTransactionPage,
  TransactionRange,
} from "./types";

// A deterministic in-memory bank for tests and the e2e environment
// (`BANK_PROVIDER=fake`). Every transaction is derived from a hash of the
// account ref and the day, so any range returns the same data on every call
// and in every process; balances are the opening balance plus the
// transactions so far, so they always agree with the history. Transaction
// listings are paged (`FAKE_TRANSACTION_PAGE_SIZE` per page, the continuation
// key is the offset), like a real bank's. The only input besides the
// arguments is `now` (today's date, UTC), injectable for tests. All names and
// IBANs are synthetic.

/** Session refs that make every call fail, for error-handling tests. */
export const FAKE_SESSION_REFS = {
  valid: "fake:session",
  expired: "fake:expired",
  rateLimited: "fake:rate-limited",
  unavailable: "fake:unavailable",
} as const;

/** How long (ms) the fake asks callers to wait when rate limited. */
export const FAKE_RETRY_AFTER_MS = 60_000;

/** Transactions per page unless `transactionPageSize` says otherwise. */
export const FAKE_TRANSACTION_PAGE_SIZE = 100;

interface FakeAccountSpec extends ProviderAccount {
  /** No transactions before this day. */
  openedOn: IsoDate;
  openingBalanceMinor: number;
  pattern: "checking" | "savings";
}

const FAKE_ACCOUNT_SPECS: readonly FakeAccountSpec[] = [
  {
    ref: "fake-checking",
    name: "Fake Checking",
    type: "checking",
    currency: "EUR",
    iban: "FI00 0000 0000 0000 01",
    openedOn: "2025-01-01",
    openingBalanceMinor: 250_000,
    pattern: "checking",
  },
  {
    ref: "fake-savings",
    name: "Fake Savings",
    type: "savings",
    currency: "EUR",
    iban: "FI00 0000 0000 0000 02",
    openedOn: "2025-01-01",
    openingBalanceMinor: 1_000_000,
    pattern: "savings",
  },
];

/** The accounts every valid fake session sees. */
export const FAKE_ACCOUNTS: readonly ProviderAccount[] =
  FAKE_ACCOUNT_SPECS.map(toAccount);

const MERCHANTS = [
  "Example Grocery",
  "Example Supermarket",
  "Example Transit",
  "Example Cafe",
  "Example Pharmacy",
  "Example Bookshop",
] as const;

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toAccount(spec: FakeAccountSpec): ProviderAccount {
  const { ref, name, type, currency, iban } = spec;
  return { ref, name, type, currency, iban };
}

function toTime(date: IsoDate): number {
  const time = ISO_DATE.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (
    Number.isNaN(time) ||
    new Date(time).toISOString().slice(0, 10) !== date
  ) {
    throw new RangeError(`Not a calendar date: ${JSON.stringify(date)}`);
  }
  return time;
}

function toDate(time: number): IsoDate {
  return new Date(time).toISOString().slice(0, 10);
}

function* days(from: IsoDate, to: IsoDate): Generator<IsoDate> {
  for (let time = toTime(from); time <= toTime(to); time += DAY_MS) {
    yield toDate(time);
  }
}

/** The booked-or-pending transactions of one account on one day. */
function transactionsOn(
  spec: FakeAccountSpec,
  date: IsoDate,
  today: IsoDate,
): ProviderTransaction[] {
  const dayOfMonth = Number(date.slice(8, 10));
  const hash = createHash("sha256").update(`${spec.ref}|${date}`).digest();
  const entries: [amountMinor: number, counterparty: string, text: string][] =
    [];

  if (spec.pattern === "checking") {
    if (dayOfMonth === 1) entries.push([-95_000, "Example Housing", "Rent"]);
    if (dayOfMonth === 15)
      entries.push([350_000, "Example Employer", "Salary"]);
    if (dayOfMonth === 16) entries.push([-20_000, "Fake Savings", "Savings"]);
    const purchases = hash[0] % 3;
    for (let i = 0; i < purchases; i++) {
      const merchant = MERCHANTS[hash[1 + i] % MERCHANTS.length];
      const amountMinor = -(100 + (hash.readUInt16BE(4 + 2 * i) % 8_000));
      entries.push([amountMinor, merchant, "Card purchase"]);
    }
  } else if (dayOfMonth === 16) {
    entries.push([20_000, "Fake Checking", "Savings"]);
  }

  return entries.map(([amountMinor, counterparty, description], i) => ({
    ref: `${spec.ref}:${date}:${i}`,
    bookingDate: date,
    valueDate: date,
    amountMinor,
    currency: spec.currency,
    counterparty,
    description,
    status: date === today ? "pending" : "booked",
  }));
}

export interface FakeProviderOptions {
  /** The clock that decides "today"; defaults to the system clock. */
  now?: () => Date;
  /** Transactions per page; defaults to `FAKE_TRANSACTION_PAGE_SIZE`. */
  transactionPageSize?: number;
}

export function createFakeProvider(
  options: FakeProviderOptions = {},
): FinancialProvider {
  const now = options.now ?? (() => new Date());
  const pageSize = options.transactionPageSize ?? FAKE_TRANSACTION_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`Invalid transaction page size: ${pageSize}`);
  }
  const today = () => toDate(now().getTime());

  function authorise(connection: ProviderConnection): void {
    switch (connection.sessionRef) {
      case "":
      case FAKE_SESSION_REFS.expired:
        throw new ProviderAuthError("fake", "fake session expired");
      case FAKE_SESSION_REFS.rateLimited:
        throw new ProviderRateLimitError("fake", "fake rate limit", {
          retryAfterMs: FAKE_RETRY_AFTER_MS,
        });
      case FAKE_SESSION_REFS.unavailable:
        throw new ProviderUnavailableError("fake", "fake bank unavailable");
    }
  }

  function findAccount(ref: ProviderAccountRef): FakeAccountSpec {
    const spec = FAKE_ACCOUNT_SPECS.find((account) => account.ref === ref);
    if (!spec) throw new Error(`Unknown fake account: ${JSON.stringify(ref)}`);
    return spec;
  }

  /** Transactions of `spec` in the inclusive range, clamped to its life. */
  function history(
    spec: FakeAccountSpec,
    from: IsoDate,
    to: IsoDate,
    current: IsoDate,
  ): ProviderTransaction[] {
    const start = toTime(from) < toTime(spec.openedOn) ? spec.openedOn : from;
    const end = toTime(to) > toTime(current) ? current : to;
    if (toTime(start) > toTime(end)) return [];
    return [...days(start, end)].flatMap((date) =>
      transactionsOn(spec, date, current),
    );
  }

  return {
    id: "fake",

    async listAccounts(connection) {
      authorise(connection);
      return FAKE_ACCOUNT_SPECS.map(toAccount);
    },

    async getBalances(connection, account) {
      authorise(connection);
      const spec = findAccount(account);
      const current = today();
      let booked = spec.openingBalanceMinor;
      let pending = 0;
      for (const txn of history(spec, spec.openedOn, current, current)) {
        if (txn.status === "booked") booked += txn.amountMinor;
        else pending += txn.amountMinor;
      }
      const yesterday = toDate(toTime(current) - DAY_MS);
      const balances: ProviderBalance[] = [
        // Closing booked: end of yesterday. Interim available: now, with
        // today's pending transactions.
        {
          amountMinor: booked,
          currency: spec.currency,
          balanceType: "CLBD",
          date: yesterday,
        },
        {
          amountMinor: booked + pending,
          currency: spec.currency,
          balanceType: "ITAV",
          date: current,
        },
      ];
      return balances;
    },

    async getTransactions(
      connection,
      account,
      range: TransactionRange,
      continuationKey?: string,
    ): Promise<ProviderTransactionPage> {
      authorise(connection);
      const spec = findAccount(account);
      const current = today();
      // Only keys this fake handed out: a positive offset.
      if (
        continuationKey !== undefined &&
        !/^[1-9]\d*$/.test(continuationKey)
      ) {
        throw new Error(
          `Invalid fake continuation key: ${JSON.stringify(continuationKey)}`,
        );
      }
      const offset = Number(continuationKey ?? 0);
      const all = history(
        spec,
        range.from ?? spec.openedOn,
        range.to ?? current,
        current,
      );
      const end = offset + pageSize;
      return {
        transactions: all.slice(offset, end),
        continuationKey: end < all.length ? String(end) : null,
      };
    },
  };
}
