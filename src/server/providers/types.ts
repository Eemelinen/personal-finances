// The contract every data source implements (architecture → Provider
// abstraction). Providers map their own JSON into these normalised DTOs, so
// the sync layer never sees provider-specific shapes. Plain types only: the
// worker imports this outside Next.js.

/** Every provider id the app knows; stored as open text in `provider` columns. */
export const PROVIDER_IDS = [
  "enable_banking",
  "csv",
  "fake",
  "kraken",
  "manual",
] as const;
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
  /** The counterparty's IBAN, normalised (`parseIban()`), when known. */
  counterpartyIban: string | null;
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

/** Same values as the `asset_class` enum. */
export type ProviderAssetClass = "stock" | "etf" | "fund" | "crypto" | "other";

/**
 * An asset as a provider describes it. The sync matches it by ISIN, else
 * CoinGecko id, else symbol and currency (D-016).
 */
export interface ProviderAsset {
  /** Ticker or coin symbol, as the provider reports it. */
  symbol: string;
  name: string | null;
  isin: string | null;
  /** When the provider knows it (crypto); otherwise a price job maps it. */
  coingeckoId: string | null;
  assetClass: ProviderAssetClass;
  /** The currency the asset is quoted in. */
  currency: CurrencyCode;
}

/**
 * One asset position of an investment account (F-019, D-016), stored as a
 * `holdings` snapshot for `date`.
 */
export interface ProviderHolding extends ProviderAsset {
  /** Units held, a decimal string with at most 18 decimals, never a float. */
  quantity: string;
  /** The day the quantity refers to. */
  date: IsoDate;
}

/** Same values as the `investment_transaction_type` enum. */
export type ProviderInvestmentTransactionType =
  "buy" | "sell" | "dividend" | "fee" | "transfer";

/** One investment transaction (F-021), stored in `investment_transactions`. */
export interface ProviderInvestmentTransaction {
  /** The provider's stable id (a Kraken ledger id). */
  ref: string;
  type: ProviderInvestmentTransactionType;
  tradeDate: IsoDate;
  /** Null for cash-only rows (a fiat deposit). */
  asset: ProviderAsset | null;
  /** Signed change in units held, a decimal string; null for cash rows. */
  quantity: string | null;
  /** Signed cash effect in integer minor units: − paid, + received. */
  amountMinor: number;
  currency: CurrencyCode;
  description: string | null;
}

/** An entry of the provider's history that is not stored, and why. */
export interface ProviderSkippedEntry {
  ref: string;
  reason: string;
}

export interface ProviderInvestmentHistory {
  transactions: ProviderInvestmentTransaction[];
  skipped: ProviderSkippedEntry[];
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
  /**
   * Investment providers only (brokers, exchanges; F-019): the account's
   * current positions. Bank providers leave it out.
   */
  getHoldings?(
    connection: ProviderConnection,
    account: ProviderAccountRef,
  ): Promise<ProviderHolding[]>;
  /**
   * Investment providers only (F-021): the account's investment
   * transactions in `range`, all of them in one call (entries that belong
   * together, like the two legs of a trade, may sit on different pages).
   */
  getInvestmentTransactions?(
    connection: ProviderConnection,
    account: ProviderAccountRef,
    range: TransactionRange,
  ): Promise<ProviderInvestmentHistory>;
}

/** A bank a connector can authorise against (F-007). */
export interface ProviderBank {
  /** The bank's name at the provider (the ASPSP name), e.g. `Nordea`. */
  name: string;
  /** ISO 3166 alpha-2. */
  country: string;
  /** The longest consent the bank grants, in seconds; null when unknown. */
  maximumConsentSeconds: number | null;
}

export interface ProviderAspsp {
  name: string;
  country: string;
}

export interface StartAuthorizationRequest {
  aspsp: ProviderAspsp;
  /** Returned unchanged in the redirect, to tie it to this request. */
  state: string;
  /** When the consent ends; at most the bank's maximum consent. */
  validUntil: Date;
}

/** What a finished authorisation gives: the session and its accounts. */
export interface ProviderAuthorizedSession {
  /** The session id: store it encrypted as `connections.session_ref`. */
  sessionRef: string;
  aspsp: ProviderAspsp;
  /** When the consent ends (ISO timestamp). */
  validUntil: string;
  accounts: ProviderAccount[];
}

/**
 * Bank providers that connect through a redirect to the bank (F-007): the
 * user is sent to `startAuthorization()`'s URL and comes back to
 * `/connections/callback` with the `state` and a `code` (or an `error`).
 */
export interface BankConnector {
  listBanks(country: string): Promise<ProviderBank[]>;
  /** The bank's authorisation URL to send the user to. */
  startAuthorization(
    request: StartAuthorizationRequest,
  ): Promise<{ url: string }>;
  /** Exchanges the redirect's `code` for a session and its accounts. */
  completeAuthorization(code: string): Promise<ProviderAuthorizedSession>;
  /**
   * Ends the session at the provider, so the consent stops. A session that
   * is already gone rejects with `ProviderAuthError`.
   */
  revokeSession(connection: ProviderConnection): Promise<void>;
}

export type BankConnectorProvider = FinancialProvider & BankConnector;

export function isBankConnector(
  provider: FinancialProvider,
): provider is BankConnectorProvider {
  const candidate = provider as Partial<BankConnector>;
  return (
    typeof candidate.listBanks === "function" &&
    typeof candidate.startAuthorization === "function" &&
    typeof candidate.completeAuthorization === "function" &&
    typeof candidate.revokeSession === "function"
  );
}
