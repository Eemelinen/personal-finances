import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { accounts, assets, institutions } from "@/server/db/schema";
import { localDate } from "@/server/dates";
import { getEnv } from "@/server/env";
import {
  portfolioPerformance,
  type PortfolioPerformance,
} from "@/server/investments/performance";
import { withHoldings } from "@/server/investments/valuation-series";
import type { IsoDate } from "@/server/providers/types";
import {
  accountSeries,
  daysBetween,
  rangeStart,
  type BalanceRangeId,
} from "@/server/reports/balance-series";
import { balanceTypePreference } from "@/server/sync/balance-types";
import { balanceOn } from "./balances";
import {
  isInvestmentAccount,
  loadSnapshots,
  TOTALS_CURRENCY,
} from "./dashboard";
import { firstDates, loadInvestmentHistory } from "./investment-history";

// Read models of the allocation report (F-022): today's net worth broken
// down by asset class and by account, and the investment accounts' value
// over a range split into contributions and market gain. Like the net worth
// (D-013, D-015) they cover the non-archived EUR accounts; brokerage and
// crypto accounts count their cash (synced, else derived from their
// transactions) and their holdings valued with the prices known that day.

type AccountType = (typeof accounts.$inferSelect)["type"];
type AssetClass = (typeof assets.$inferSelect)["assetClass"];

/** Asset classes of the allocation; stocks and ETFs are one (D-016). */
export const ALLOCATION_CLASSES = [
  { id: "cash", label: "Cash" },
  { id: "stocks", label: "Stocks and ETFs" },
  { id: "funds", label: "Funds" },
  { id: "crypto", label: "Crypto" },
  { id: "other", label: "Other" },
] as const;

export type AllocationClassId = (typeof ALLOCATION_CLASSES)[number]["id"];

const CLASS_OF: Record<AssetClass, AllocationClassId> = {
  stock: "stocks",
  etf: "stocks",
  fund: "funds",
  crypto: "crypto",
  other: "other",
};

export interface AllocationSlice {
  /** Value in EUR minor units; negative for a debt (an overdrawn account). */
  valueMinor: number;
  /** Share of the positive values' sum; null for a value ≤ 0. */
  share: number | null;
}

export interface AllocationClass extends AllocationSlice {
  id: AllocationClassId;
  label: string;
}

export interface AllocationAccount extends AllocationSlice {
  id: string;
  name: string;
  institution: string;
  type: AccountType;
  /** Cash part: the balance, or the cash a Nordnet import implies. */
  cashMinor: number;
  /** Holdings part, valued today. */
  holdingsMinor: number;
}

export interface Allocation {
  today: IsoDate;
  currency: string;
  /** Net worth today: Σ of the accounts' values. */
  totalMinor: number;
  /** The classes with a value, in `ALLOCATION_CLASSES` order. */
  classes: AllocationClass[];
  /** Accounts with a value, largest first. */
  accounts: AllocationAccount[];
  /** Holdings left out for lack of a price or an exchange rate. */
  unpriced: number;
  /** Non-archived accounts not counted: no balance yet, or not in EUR. */
  omitted: { withoutBalance: number; otherCurrency: number };
  empty: boolean;
}

export interface PortfolioOptions {
  db?: Db;
  /** The current time; defaults to the clock. */
  now?: Date;
  /** Whose calendar day "today" is; `APP_TIMEZONE`. */
  timeZone?: string;
}

interface AccountRow {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  institution: string;
  institutionRef: string | null;
}

async function loadAccounts(db: Db, onlyInvestments: boolean) {
  const rows: AccountRow[] = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      currency: accounts.currency,
      institution: institutions.name,
      institutionRef: institutions.providerRef,
    })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(
      onlyInvestments
        ? and(
            eq(accounts.archived, false),
            inArray(accounts.type, ["brokerage", "crypto"]),
          )
        : eq(accounts.archived, false),
    )
    .orderBy(asc(institutions.name), asc(accounts.name), asc(accounts.id));
  return {
    all: rows,
    eur: rows.filter((row) => row.currency === TOTALS_CURRENCY),
  };
}

/** Shares of the positive values' sum. */
function withShares<T extends { valueMinor: number }>(
  items: readonly T[],
): (T & { share: number | null })[] {
  const positive = items.reduce(
    (sum, item) => sum + Math.max(0, item.valueMinor),
    0,
  );
  return items.map((item) => ({
    ...item,
    share:
      item.valueMinor > 0 && positive > 0 ? item.valueMinor / positive : null,
  }));
}

/** Today's net worth by asset class and by account. */
export async function getAllocation(
  options: PortfolioOptions = {},
): Promise<Allocation> {
  const db = options.db ?? getDb();
  const today = localDate(
    options.now ?? new Date(),
    options.timeZone ?? getEnv().APP_TIMEZONE,
  );
  const { all, eur } = await loadAccounts(db, false);
  const snapshots = await loadSnapshots(
    db,
    eur.map((row) => row.id),
    today,
  );
  const investments = await loadInvestmentHistory(
    db,
    eur
      .filter((row) => isInvestmentAccount(row.type))
      .map((row) => ({
        id: row.id,
        syncedCash: (snapshots.get(row.id) ?? []).length > 0,
      })),
    [today],
  );
  const assetIds = [
    ...new Set(
      [...investments.values()].flatMap((series) =>
        series.last.positions.map((position) => position.assetId),
      ),
    ),
  ];
  const classOf = new Map(
    (assetIds.length
      ? await db
          .select({ id: assets.id, assetClass: assets.assetClass })
          .from(assets)
          .where(inArray(assets.id, assetIds))
      : []
    ).map((row) => [row.id, CLASS_OF[row.assetClass]]),
  );

  const byClass = new Map<AllocationClassId, number>();
  const add = (id: AllocationClassId, valueMinor: number) =>
    byClass.set(id, (byClass.get(id) ?? 0) + valueMinor);
  const counted: Omit<AllocationAccount, "share">[] = [];
  let unpriced = 0;
  for (const row of eur) {
    const balance = balanceOn(
      snapshots.get(row.id) ?? [],
      today,
      balanceTypePreference(row.institutionRef),
    );
    const investment = investments.get(row.id);
    const cashMinor =
      balance?.amountMinor ?? investment?.derivedCash?.[0] ?? null;
    const positions = investment?.last.positions ?? [];
    if (cashMinor === null && positions.length === 0) continue;
    let holdingsMinor = 0;
    for (const position of positions) {
      if (position.valueMinor === null) {
        unpriced++;
        continue;
      }
      holdingsMinor += position.valueMinor;
      add(classOf.get(position.assetId) ?? "other", position.valueMinor);
    }
    if (cashMinor !== null) add("cash", cashMinor);
    counted.push({
      id: row.id,
      name: row.name,
      institution: row.institution,
      type: row.type,
      cashMinor: cashMinor ?? 0,
      holdingsMinor,
      valueMinor: (cashMinor ?? 0) + holdingsMinor,
    });
  }

  const classes = withShares(
    ALLOCATION_CLASSES.filter((item) => byClass.has(item.id)).map((item) => ({
      ...item,
      valueMinor: byClass.get(item.id)!,
    })),
  );
  return {
    today,
    currency: TOTALS_CURRENCY,
    totalMinor: counted.reduce((sum, account) => sum + account.valueMinor, 0),
    classes,
    accounts: withShares(counted).sort(
      (a, b) => b.valueMinor - a.valueMinor || a.name.localeCompare(b.name),
    ),
    unpriced,
    omitted: {
      withoutBalance: eur.length - counted.length,
      otherCurrency: all.length - eur.length,
    },
    empty: counted.length === 0,
  };
}

export interface PerformanceAccount {
  id: string;
  name: string;
  institution: string;
  type: AccountType;
}

export interface PortfolioPerformanceReport {
  range: BalanceRangeId;
  currency: string;
  /** The range's days, oldest first; the last one is today. */
  days: IsoDate[];
  /** The investment accounts with any data, to choose from. */
  accounts: PerformanceAccount[];
  /** The account shown, or null for all of them. */
  accountId: string | null;
  performance: PortfolioPerformance;
  /** No investment account has a value yet. */
  empty: boolean;
}

/**
 * The value of the investment accounts (or of `accountId`) per day over
 * `range`, with what was contributed and what the market added
 * (`portfolioPerformance()`).
 */
export async function getPortfolioPerformance(
  options: PortfolioOptions & { range: BalanceRangeId; accountId?: string },
): Promise<PortfolioPerformanceReport> {
  const db = options.db ?? getDb();
  const today = localDate(
    options.now ?? new Date(),
    options.timeZone ?? getEnv().APP_TIMEZONE,
  );
  const { eur } = await loadAccounts(db, true);
  const ids = eur.map((row) => row.id);
  const firsts = await Promise.all(
    (["snapshot", "holding", "trade"] as const).map((source) =>
      firstDates(db, source, ids),
    ),
  );
  const synced = firsts[0];
  let earliest: IsoDate | null = null;
  const withData = new Set<string>();
  for (const [source, first] of firsts.entries()) {
    for (const [id, date] of first) {
      withData.add(id);
      // A synced account's ledger can be older than its first balance; its
      // value is unknown before that, so it does not stretch `all`.
      if (source === 2 && synced.has(id)) continue;
      if (earliest === null || date < earliest) earliest = date;
    }
  }
  const choices = eur.filter((row) => withData.has(row.id));
  const accountId =
    choices.find((row) => row.id === options.accountId)?.id ?? null;
  const shown = accountId
    ? choices.filter((row) => row.id === accountId)
    : choices;

  const days = daysBetween(rangeStart(options.range, today, earliest), today);
  const [snapshots, investments] = await Promise.all([
    loadSnapshots(
      db,
      shown.map((row) => row.id),
      days[0],
    ),
    loadInvestmentHistory(
      db,
      shown.map((row) => ({ id: row.id, syncedCash: synced.has(row.id) })),
      days,
    ),
  ]);
  const inputs = shown.map((row) => {
    const cash = accountSeries(
      {
        snapshots: snapshots.get(row.id) ?? [],
        flows: [],
        firstTransactionDate: null,
        preference: balanceTypePreference(row.institutionRef),
      },
      days,
    );
    const series = investments.get(row.id)!;
    return {
      values: withHoldings(cash, series).map((point) => point.amountMinor),
      flows: series.flows,
    };
  });
  const performance = portfolioPerformance(inputs, days.length);
  return {
    range: options.range,
    currency: TOTALS_CURRENCY,
    days,
    accounts: choices.map(({ id, name, institution, type }) => ({
      id,
      name,
      institution,
      type,
    })),
    accountId,
    performance,
    empty: performance.endMinor === null,
  };
}
