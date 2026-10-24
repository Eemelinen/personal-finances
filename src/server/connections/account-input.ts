// What the user may set on a bank account (F-007). No imports: the
// /connections client components use these too.

export type BankAccountType = "checking" | "savings";

export const BANK_ACCOUNT_TYPES: readonly BankAccountType[] = [
  "checking",
  "savings",
];

export const MAX_ACCOUNT_NAME_LENGTH = 100;
