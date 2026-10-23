// The contract every data source implements (architecture → Provider
// abstraction). Providers map their own JSON into these normalised DTOs, so
// the sync layer never sees provider-specific shapes. Plain types only: the
// worker imports this outside Next.js.

/** Every provider id the app knows; stored as open text in `provider` columns. */
export const PROVIDER_IDS = ["enable_banking", "csv", "fake"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** The providers `BANK_PROVIDER` can select for bank connections. */
export const BANK_PROVIDER_IDS = [
  "enable_banking",
  "fake",
] as const satisfies readonly ProviderId[];
export type BankProviderId = (typeof BANK_PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** ISO-4217 code, e.g. `EUR`. */
export type CurrencyCode = string;

/** Calendar day `YYYY-MM-DD`, as stored in `date` columns. */
export type IsoDate = string;

/** The account's id at the provider (`accounts.provider_account_ref`). */
export type ProviderAccountRef = string;

/** Same values as the `account_type` enum. */
export type ProviderAccountType =
  "checking" | "savings" | "brokerage" | "crypto";

/**
 * What a provider needs to read one connection: the provider session id,
 * already decrypted (`connections.session_ref` is stored encrypted with
 * `encryptSecret()` from `src/server/crypto.ts`).
 */
export interface ProviderConnection {
  sessionRef: string;
}

export interface ProviderAccount {
  ref: ProviderAccountRef;
  name: string;
  type: ProviderAccountType;
  currency: CurrencyCode;
  iban: string | null;
}

export interface ProviderBalance {
  /** Integer minor units (cents), never a float. */
  amountMinor: number;
  currency: CurrencyCode;
  /** ISO 20022 balance type as reported, e.g. `CLBD`, `ITAV`. */
  balanceType: string;
  /** The day the balance refers to. */
  date: IsoDate;
}

export interface ProviderTransaction {
  /** The provider's transaction id, or null when it has no stable one. */
  ref: string | null;
  bookingDate: IsoDate;
  valueDate: IsoDate | null;
  /** Signed integer minor units: negative is money out. */
  amountMinor: number;
  currency: CurrencyCode;
  counterparty: string | null;
  description: string | null;
  status: "booked" | "pending";
}

/**
 * Inclusive calendar-day range. `from` omitted: the oldest day the provider
 * can return (a first sync backfills with it); `to` defaults to the
 * provider's today.
 */
export interface TransactionRange {
  from?: IsoDate;
  to?: IsoDate;
}

/**
 * One page of a transaction listing. `continuationKey` is null on the last
 * page; otherwise pass it back with the same range for the next one.
 */
export interface ProviderTransactionPage {
  transactions: ProviderTransaction[];
  continuationKey: string | null;
}

/**
 * Provisional: F-019 finalises the holdings DTO for brokers and exchanges.
 * Quantities are decimal strings, never floats.
 */
export interface ProviderHolding {
  /** Ticker, ISIN or coin symbol, as the provider reports it. */
  symbol: string;
  quantity: string;
}

/**
 * Methods reject with the typed errors from `./errors` (`ProviderAuthError`,
 * `ProviderRateLimitError`, `ProviderUnavailableError`) for failures the
 * sync layer handles; anything else is a bug.
 */
export interface FinancialProvider {
  readonly id: ProviderId;
  listAccounts(connection: ProviderConnection): Promise<ProviderAccount[]>;
  getBalances(
    connection: ProviderConnection,
    account: ProviderAccountRef,
  ): Promise<ProviderBalance[]>;
  /** One page; omit `continuationKey` for the first. */
  getTransactions(
    connection: ProviderConnection,
    account: ProviderAccountRef,
    range: TransactionRange,
    continuationKey?: string,
  ): Promise<ProviderTransactionPage>;
  /** Investment providers only (F-019). */
  getHoldings?(
    connection: ProviderConnection,
    account: ProviderAccountRef,
  ): Promise<ProviderHolding[]>;
}
