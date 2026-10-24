import { addDays, localDate } from "@/server/dates";
import {
  currencyExponent,
  divideRounded,
  parseDecimal,
  pow10,
  SCALE_FACTOR,
} from "@/server/investments/decimal";
import { ProviderAuthError } from "../errors";
import type {
  CurrencyCode,
  FinancialProvider,
  IsoDate,
  ProviderAccount,
  ProviderBalance,
  ProviderConnection,
  ProviderTransaction,
  TransactionRange,
} from "../types";
import {
  EnableBankingApiError,
  type EnableBankingClient,
  type EnableBankingEnvironment,
  type StartAuthorizationInput,
} from "./client";
import {
  wrongPeriodDetailSchema,
  type Aspsp,
  type EnableBankingAccount,
  type EnableBankingBalance,
  type EnableBankingSession,
  type EnableBankingTransaction,
} from "./schemas";

// `FinancialProvider` over the Enable Banking client (F-006). A connection's
// `sessionRef` is the Enable Banking session id; accounts are its account
// uids. Mapping rules follow the F-001 sandbox findings (FIN-001 → Findings):
// amounts are positive with a `credit_debit_indicator`, `entry_reference` is
// the transaction id, `GET /sessions/{id}` lists the uids in its own order,
// and Nordea returns only 7 days unless `date_from` asks for more.

const PROVIDER_ID = "enable_banking";

/**
 * How many days back a bank serves transactions, by ASPSP name. A first
 * sync (no `from`) asks for exactly this much and an older `from` is
 * clamped to it (the sync's window can reach back to an old pending
 * transaction, D-010); banks not listed are asked
 * without `date_from`, which gives S-Pankki its whole history. A `from`
 * further back than a bank allows is retried once from the day its 422
 * `WRONG_TRANSACTIONS_PERIOD` names.
 */
export const HISTORY_DAYS_BY_ASPSP: Readonly<Record<string, number>> = {
  Nordea: 540,
};

/** `status` values mapped to the DTO; others (`CNCL`, `RJCT`, …) are dropped. */
const STATUS: Readonly<Record<string, ProviderTransaction["status"]>> = {
  BOOK: "booked",
  PDNG: "pending",
  HOLD: "pending",
};

/** A decimal string as integer minor units of `currency`, rounded. */
export function toMinorUnits(amount: string, currency: CurrencyCode): number {
  return Number(
    divideRounded(
      parseDecimal(amount) * pow10(currencyExponent(currency)),
      SCALE_FACTOR,
    ),
  );
}

const text = (value: string | null | undefined): string | null =>
  value?.trim() || null;

/**
 * A display name: the user's nickname, else the product, else the holder,
 * with the last four characters of the IBAN or card number so that three
 * Nordea "KÄYTTÖTILI"s can be told apart.
 */
export function accountName(account: EnableBankingAccount): string {
  const label =
    text(account.details) ??
    text(account.product) ??
    text(account.name) ??
    "Account";
  const identification = (
    account.account_id?.iban ??
    account.account_id?.other?.identification ??
    ""
  ).replace(/\s/g, "");
  return identification.length >= 4
    ? `${label} ·${identification.slice(-4)}`
    : label;
}

/** Savings accounts are `SVGS`; current accounts and cards count as checking. */
export function mapAccount(account: EnableBankingAccount): ProviderAccount {
  return {
    ref: account.uid,
    name: accountName(account),
    type: account.cash_account_type === "SVGS" ? "savings" : "checking",
    currency: account.currency,
    iban: text(account.account_id?.iban),
  };
}

/**
 * A balance on its `reference_date`, else the day of its last change, else
 * `today` (Nordea leaves both null).
 */
export function mapBalance(
  balance: EnableBankingBalance,
  today: IsoDate,
  timeZone: string,
): ProviderBalance {
  const { currency, amount } = balance.balance_amount;
  const changed = balance.last_change_date_time
    ? new Date(balance.last_change_date_time)
    : null;
  return {
    amountMinor: toMinorUnits(amount, currency),
    currency,
    balanceType: balance.balance_type,
    date:
      balance.reference_date ??
      (changed && !Number.isNaN(changed.getTime())
        ? localDate(changed, timeZone)
        : today),
  };
}

/** Remittance lines without blanks, repeats and the reference number. */
function description(transaction: EnableBankingTransaction): string | null {
  const reference = text(transaction.reference_number);
  const lines: string[] = [];
  for (const line of transaction.remittance_information ?? []) {
    const trimmed = line.trim();
    if (trimmed && trimmed !== reference && !lines.includes(trimmed)) {
      lines.push(trimmed);
    }
  }
  return (
    (lines.length > 0 ? lines.join(" ") : null) ??
    text(transaction.bank_transaction_code?.description)
  );
}

/**
 * The normalised transaction, or null for a status that moved no money
 * (cancelled, rejected, scheduled, informational). Money out is negative;
 * the counterparty is the creditor of a debit and the debtor of a credit.
 * The booking date falls back to the transaction and value dates (pending
 * rows may have none), then to `today`.
 */
export function mapTransaction(
  transaction: EnableBankingTransaction,
  today: IsoDate,
): ProviderTransaction | null {
  const status = STATUS[transaction.status ?? "BOOK"];
  if (!status) return null;
  const { currency, amount } = transaction.transaction_amount;
  const minor = toMinorUnits(amount, currency);
  const indicator = transaction.credit_debit_indicator;
  const amountMinor =
    indicator === "DBIT"
      ? -Math.abs(minor)
      : indicator === "CRDT"
        ? Math.abs(minor)
        : minor;
  const counterparty =
    indicator === "DBIT"
      ? transaction.creditor
      : indicator === "CRDT"
        ? transaction.debtor
        : null;
  return {
    ref: text(transaction.entry_reference) ?? text(transaction.transaction_id),
    bookingDate:
      transaction.booking_date ??
      transaction.transaction_date ??
      transaction.value_date ??
      today,
    valueDate: transaction.value_date ?? null,
    amountMinor,
    currency,
    counterparty: text(counterparty?.name),
    description: description(transaction),
    status,
  };
}

/** Thrown when a session can no longer read accounts: reconnect. */
function assertAuthorized(session: EnableBankingSession, now: number): void {
  if (session.status !== "AUTHORIZED") {
    throw new ProviderAuthError(
      PROVIDER_ID,
      `The Enable Banking session is ${session.status}`,
    );
  }
  const validUntil = Date.parse(session.access.valid_until);
  if (!Number.isNaN(validUntil) && validUntil <= now) {
    throw new ProviderAuthError(
      PROVIDER_ID,
      "The Enable Banking consent has expired",
    );
  }
}

/** The earliest day a 422 `WRONG_TRANSACTIONS_PERIOD` allows, if it is one. */
function allowedDateFrom(error: unknown): IsoDate | undefined {
  if (
    !(error instanceof EnableBankingApiError) ||
    error.code !== "WRONG_TRANSACTIONS_PERIOD"
  ) {
    return undefined;
  }
  const parsed = wrongPeriodDetailSchema.safeParse(error.detail);
  return parsed.success ? parsed.data.date_from : undefined;
}

export interface AuthorizedSession {
  /** The session id: store it encrypted as `connections.session_ref`. */
  sessionRef: string;
  aspsp: { name: string; country: string };
  /** When the consent ends (ISO timestamp). */
  validUntil: string;
  accounts: ProviderAccount[];
}

export interface EnableBankingProvider extends FinancialProvider {
  readonly id: "enable_banking";
  environment(): EnableBankingEnvironment;
  /** The banks of a country (ISO 3166 code). */
  listBanks(country: string): Promise<Aspsp[]>;
  /** The bank's authorisation URL to send the user to. */
  startAuthorization(
    input: StartAuthorizationInput,
  ): Promise<{ url: string; authorizationId: string }>;
  /** Exchanges the redirect's `code` for a session and its accounts. */
  completeAuthorization(code: string): Promise<AuthorizedSession>;
}

export interface EnableBankingProviderOptions {
  client: EnableBankingClient;
  /** `APP_TIMEZONE`: the bank's "today" for balances and history limits. */
  timeZone: string;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

export function createEnableBankingProvider(
  options: EnableBankingProviderOptions,
): EnableBankingProvider {
  const { client, timeZone } = options;
  const now = options.now ?? Date.now;
  const today = () => localDate(new Date(now()), timeZone);
  // The bank behind each session, looked up once per session and process.
  const aspspBySession = new Map<string, string>();

  async function session(connection: ProviderConnection) {
    const result = await client.getSession(connection.sessionRef);
    aspspBySession.set(connection.sessionRef, result.aspsp.name);
    return result;
  }

  async function aspspName(connection: ProviderConnection): Promise<string> {
    return (
      aspspBySession.get(connection.sessionRef) ??
      (await session(connection)).aspsp.name
    );
  }

  /**
   * `range.from`, clamped to the bank's oldest day when its limit is known;
   * for a first sync (no `from`) that oldest day.
   */
  async function dateFrom(
    connection: ProviderConnection,
    range: TransactionRange,
  ): Promise<IsoDate | undefined> {
    const days = HISTORY_DAYS_BY_ASPSP[await aspspName(connection)];
    if (days === undefined) return range.from;
    const oldest = addDays(today(), -days);
    return range.from && range.from > oldest ? range.from : oldest;
  }

  return {
    id: PROVIDER_ID,

    environment: () => client.environment(),

    listBanks: (country) => client.getAspsps(country),

    startAuthorization: (input) => client.startAuthorization(input),

    async completeAuthorization(code) {
      const created = await client.createSession(code);
      aspspBySession.set(created.session_id, created.aspsp.name);
      return {
        sessionRef: created.session_id,
        aspsp: created.aspsp,
        validUntil: created.access.valid_until,
        accounts: created.accounts.map(mapAccount),
      };
    },

    /** The session's accounts, matched by uid (details per account). */
    async listAccounts(connection) {
      const current = await session(connection);
      assertAuthorized(current, now());
      const accounts: ProviderAccount[] = [];
      for (const uid of current.accounts) {
        const details = await client.getAccountDetails(uid);
        if (details.uid !== uid) {
          throw new Error("Enable Banking returned another account's details");
        }
        accounts.push(mapAccount(details));
      }
      return accounts;
    },

    async getBalances(_connection, account) {
      const day = today();
      return (await client.getBalances(account)).map((balance) =>
        mapBalance(balance, day, timeZone),
      );
    },

    async getTransactions(connection, account, range, continuationKey) {
      const query = {
        dateFrom: await dateFrom(connection, range),
        dateTo: range.to,
        continuationKey,
      };
      let page;
      try {
        page = await client.getTransactions(account, query);
      } catch (error) {
        const allowed = allowedDateFrom(error);
        if (!allowed || (query.dateFrom && allowed <= query.dateFrom)) {
          throw error;
        }
        page = await client.getTransactions(account, {
          ...query,
          dateFrom: allowed,
        });
      }
      const day = today();
      return {
        transactions: page.transactions
          .map((transaction) => mapTransaction(transaction, day))
          .filter((transaction) => transaction !== null),
        continuationKey: page.continuation_key ?? null,
      };
    },
  };
}
