import type { IsoDate } from "@/server/providers/types";

// The /transactions filters as they live in the URL (F-015), pure:
//
//   from, to       booking days, inclusive (`YYYY-MM-DD`)
//   account        an account id; repeated for several accounts
//   category       a category id (its subcategories included) or `none`
//   q              text in the counterparty, description or note
//   type           `income` (credits) or `expense` (debits)
//   transfers      `exclude` or `only` (own transfers); absent: both
//   excluded       `exclude` or `only` (excluded from reports, F-027);
//                  absent: both
//   household      `exclude` or `only` (with a household member, F-030);
//                  absent: both
//   page           1-based page number
//
// Values that do not parse are ignored, so a hand-edited URL never fails.

export type Direction = "income" | "expense";
export type TransferFilter = "exclude" | "only";

/** `none`: transactions without a category. */
export const NO_CATEGORY = "none";

export interface TransactionFilter {
  from: IsoDate | null;
  to: IsoDate | null;
  /** Empty: every account. */
  accounts: string[];
  /** A category id, `NO_CATEGORY`, or null for any. */
  category: string | null;
  /** Trimmed; empty: no text filter. */
  text: string;
  direction: Direction | null;
  transfers: TransferFilter | null;
  /** Transactions in the Excluded category (kind `excluded`). */
  excluded: TransferFilter | null;
  /** Transactions marked `household` (F-030). */
  household: TransferFilter | null;
}

export interface TransactionQuery {
  filter: TransactionFilter;
  /** 1-based; the query clamps it to the last page. */
  page: number;
}

export type SearchParams = Record<string, string | string[] | undefined>;

export const EMPTY_FILTER: TransactionFilter = {
  from: null,
  to: null,
  accounts: [],
  category: null,
  text: "",
  direction: null,
  transfers: null,
  excluded: null,
  household: null,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest text filter kept; longer input is cut. */
export const MAX_TEXT_LENGTH = 200;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** A real calendar day as `YYYY-MM-DD`. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function values(params: SearchParams, key: string): string[] {
  const value = params[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function first(params: SearchParams, key: string): string {
  return (values(params, key)[0] ?? "").trim();
}

export function parseTransactionQuery(params: SearchParams): TransactionQuery {
  const from = first(params, "from");
  const to = first(params, "to");
  const category = first(params, "category");
  const type = first(params, "type");
  const transfers = first(params, "transfers");
  const excluded = first(params, "excluded");
  const household = first(params, "household");
  const page = Number(first(params, "page"));
  const accounts = [
    ...new Set(
      values(params, "account")
        .map((id) => id.trim().toLowerCase())
        .filter(isUuid),
    ),
  ];
  return {
    filter: {
      from: isIsoDate(from) ? from : null,
      to: isIsoDate(to) ? to : null,
      accounts,
      category:
        category === NO_CATEGORY || isUuid(category)
          ? category.toLowerCase()
          : null,
      text: first(params, "q").slice(0, MAX_TEXT_LENGTH),
      direction: type === "income" || type === "expense" ? type : null,
      transfers:
        transfers === "exclude" || transfers === "only" ? transfers : null,
      excluded: excluded === "exclude" || excluded === "only" ? excluded : null,
      household:
        household === "exclude" || household === "only" ? household : null,
    },
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

/** The URL query of a filter (and page), with only the set values. */
export function transactionSearchParams(
  filter: TransactionFilter,
  page = 1,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  for (const account of filter.accounts) params.append("account", account);
  if (filter.category) params.set("category", filter.category);
  if (filter.text) params.set("q", filter.text);
  if (filter.direction) params.set("type", filter.direction);
  if (filter.transfers) params.set("transfers", filter.transfers);
  if (filter.excluded) params.set("excluded", filter.excluded);
  if (filter.household) params.set("household", filter.household);
  if (page > 1) params.set("page", String(page));
  return params;
}

/** `/transactions` with the filter (and page) in the query. */
export function transactionsHref(filter: TransactionFilter, page = 1): string {
  const query = transactionSearchParams(filter, page).toString();
  return query ? `/transactions?${query}` : "/transactions";
}

export function isFiltered(filter: TransactionFilter): boolean {
  return transactionSearchParams(filter).size > 0;
}
