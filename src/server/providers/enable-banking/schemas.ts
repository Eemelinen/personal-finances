import { z } from "zod";

// The parts of Enable Banking's responses the client reads (API reference,
// checked against the F-001 sandbox recordings in
// tests/fixtures/enable-banking/). Unknown keys are dropped; fields the
// banks leave out or set to null are `nullish`.

const amount = z.object({
  currency: z.string().length(3),
  amount: z.string(),
});

const party = z.object({ name: z.string().nullish() }).nullish();

const accountIdentification = z.object({
  identification: z.string(),
  scheme_name: z.string().nullish(),
});

export const aspspSchema = z.object({
  name: z.string(),
  country: z.string(),
  bic: z.string().nullish(),
  logo: z.string().nullish(),
  psu_types: z.array(z.string()).nullish(),
  /** Seconds. */
  maximum_consent_validity: z.number().nullish(),
  beta: z.boolean().nullish(),
});
export type Aspsp = z.infer<typeof aspspSchema>;

export const aspspsResponseSchema = z.object({
  aspsps: z.array(aspspSchema),
});

export const authResponseSchema = z.object({
  url: z.url(),
  authorization_id: z.string(),
});

export const accountSchema = z.object({
  uid: z.string(),
  account_id: z
    .object({
      iban: z.string().nullish(),
      other: accountIdentification.nullish(),
    })
    .nullish(),
  name: z.string().nullish(),
  details: z.string().nullish(),
  product: z.string().nullish(),
  cash_account_type: z.string().nullish(),
  currency: z.string().length(3),
  identification_hash: z.string().nullish(),
});
export type EnableBankingAccount = z.infer<typeof accountSchema>;

const sessionAspsp = z.object({ name: z.string(), country: z.string() });

const access = z.object({ valid_until: z.string() });

export const createSessionResponseSchema = z.object({
  session_id: z.string(),
  accounts: z.array(accountSchema),
  aspsp: sessionAspsp,
  access,
});
export type CreatedSession = z.infer<typeof createSessionResponseSchema>;

export const sessionResponseSchema = z.object({
  status: z.string(),
  /** Account uids, not in the order `POST /sessions` listed them. */
  accounts: z.array(z.string()),
  aspsp: sessionAspsp,
  access,
});
export type EnableBankingSession = z.infer<typeof sessionResponseSchema>;

export const balancesResponseSchema = z.object({
  balances: z.array(
    z.object({
      balance_amount: amount,
      balance_type: z.string(),
      reference_date: z.string().nullish(),
      last_change_date_time: z.string().nullish(),
    }),
  ),
});
export type EnableBankingBalance = z.infer<
  typeof balancesResponseSchema
>["balances"][number];

export const transactionSchema = z.object({
  entry_reference: z.string().nullish(),
  transaction_id: z.string().nullish(),
  transaction_amount: amount,
  creditor: party,
  debtor: party,
  bank_transaction_code: z
    .object({ description: z.string().nullish() })
    .nullish(),
  credit_debit_indicator: z.enum(["CRDT", "DBIT"]).nullish(),
  status: z.string().nullish(),
  booking_date: z.string().nullish(),
  value_date: z.string().nullish(),
  transaction_date: z.string().nullish(),
  reference_number: z.string().nullish(),
  remittance_information: z.array(z.string()).nullish(),
});
export type EnableBankingTransaction = z.infer<typeof transactionSchema>;

export const transactionsResponseSchema = z.object({
  transactions: z.array(transactionSchema),
  continuation_key: z.string().nullish(),
});
export type EnableBankingTransactionPage = z.infer<
  typeof transactionsResponseSchema
>;

/** Error bodies: `{ code, message, error, detail }`. */
export const errorResponseSchema = z.object({
  code: z.number().nullish(),
  message: z.string().nullish(),
  error: z.string().nullish(),
  detail: z.unknown().optional(),
});

/** The `detail` of a 422 `WRONG_TRANSACTIONS_PERIOD`. */
export const wrongPeriodDetailSchema = z.object({
  date_from: z.iso.date(),
});
