import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  categorizeTransactions,
  reapplyRules,
} from "@/server/categorization/categorize";
import {
  CategoryManageError,
  createCategory,
  createRule,
  deleteCategory,
  listCategoryOptions,
  listCategoryUsage,
  listRules,
  moveRule,
  renameCategory,
} from "@/server/categorization/manage";
import { categoryIdByPath, seedDefaults } from "@/server/categorization/seed";
import {
  excludeTransaction,
  includeTransaction,
  markTransfer,
  setTransactionCategory,
  setTransactionNote,
  unlinkTransfer,
} from "@/server/categorization/transaction-edits";
import { createManualAccount } from "@/server/csv/import-csv";
import { categoryRules, transactions } from "@/server/db/schema";
import {
  EMPTY_FILTER,
  type TransactionFilter,
} from "@/server/queries/transaction-filter";
import { getCashFlowReport } from "@/server/queries/reports";
import {
  listAccountOptions,
  listTransactions,
  PAGE_SIZE,
} from "@/server/queries/transactions";
import { setAppSetting } from "@/server/settings";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// The /transactions read model and the F-015 edits against Postgres 18:
// filters and totals (counted like the cash-flow report, F-034, with the
// rest as "not counted"), paging through 10k+ rows, inline category
// changes, notes, marked and unlinked transfers, and managing categories
// and rules. One seeded database for the file; every test uses its own
// accounts.

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
  await seedDefaults(testDb.db);
});

afterAll(async () => {
  await testDb?.stop();
});

const db = () => ({ db: testDb.db });

async function categoryId(path: string): Promise<string> {
  const id = await categoryIdByPath(testDb.db, path);
  expect(id, path).not.toBeNull();
  return id!;
}

async function account(name = `Account ${randomUUID()}`): Promise<string> {
  return createManualAccount(
    { name, type: "checking", format: "generic" },
    db(),
  );
}

interface Row {
  date: string;
  amount: number;
  counterparty?: string | null;
  description?: string | null;
  currency?: string;
  status?: "booked" | "pending";
}

async function insert(accountId: string, rows: Row[]): Promise<string[]> {
  const inserted = await testDb.db
    .insert(transactions)
    .values(
      rows.map((row) => ({
        accountId,
        dedupeHash: randomUUID(),
        bookingDate: row.date,
        amountMinor: row.amount,
        currency: row.currency ?? "EUR",
        counterparty: row.counterparty ?? null,
        description: row.description ?? null,
        status: row.status ?? "booked",
      })),
    )
    .returning({ id: transactions.id });
  const ids = inserted.map((row) => row.id);
  await testDb.db.transaction((tx) => categorizeTransactions(tx, ids));
  return ids;
}

async function stored(id: string) {
  const [row] = await testDb.db
    .select()
    .from(transactions)
    .where(eq(transactions.id, id));
  return row;
}

const forAccounts = (
  accounts: string[],
  filter: Partial<TransactionFilter> = {},
): TransactionFilter => ({ ...EMPTY_FILTER, accounts, ...filter });

describe("listTransactions", () => {
  it("filters, totals and orders one account's transactions", async () => {
    const id = await account();
    const other = await account();
    const [coffee, , salary, , , note] = await insert(id, [
      { date: "2024-03-02", amount: -450, counterparty: "Kiosk 100%" },
      { date: "2024-03-05", amount: -720, counterparty: "Kiosk" },
      {
        date: "2024-03-12",
        amount: 234_567,
        counterparty: "Employer",
        description: "Salary March",
      },
      { date: "2024-03-15", amount: -15_000, description: "Rent part" },
      { date: "2024-03-20", amount: -1_000, currency: "SEK" },
      { date: "2024-04-20", amount: -3_330, counterparty: "Bookshop" },
    ]);
    await insert(other, [{ date: "2024-03-02", amount: -999 }]);
    await setTransactionNote(note, "a gift_for someone", db());

    const all = await listTransactions(forAccounts([id]), 1, db());
    expect(all.total).toBe(6);
    expect(all.rows.map((row) => row.bookingDate)).toEqual([
      "2024-04-20",
      "2024-03-20",
      "2024-03-15",
      "2024-03-12",
      "2024-03-05",
      "2024-03-02",
    ]);
    // The salary is income, the debits expenses; the SEK row does not count.
    expect(all.totals).toEqual({
      currency: "EUR",
      incomeMinor: 234_567,
      expensesMinor: -19_500,
      netMinor: 215_067,
      otherInMinor: 0,
    });
    expect(all.notCounted).toEqual({
      count: 1,
      sums: [{ currency: "SEK", creditMinor: 0, debitMinor: -1_000 }],
      reasons: [{ reason: "currency", count: 1, filter: null }],
    });
    expect(all.rows[0]).toMatchObject({
      accountId: id,
      institutionName: "Other bank",
      note: "a gift_for someone",
    });

    const list = (filter: Partial<TransactionFilter>) =>
      listTransactions(forAccounts([id], filter), 1, db());
    expect((await list({ from: "2024-03-05", to: "2024-03-15" })).total).toBe(
      3,
    );
    expect((await list({ direction: "income" })).rows[0].id).toBe(salary);
    expect((await list({ direction: "expense" })).total).toBe(5);
    // LIKE wildcards in the text match themselves; the note is searched too.
    expect((await list({ text: "100%" })).rows.map((r) => r.id)).toEqual([
      coffee,
    ]);
    expect((await list({ text: "kiosk" })).total).toBe(2);
    expect((await list({ text: "GIFT_FOR" })).rows[0].id).toBe(note);
    expect((await list({ text: "gift%for" })).total).toBe(0);
    // A top-level category includes its subcategories.
    expect(
      (await list({ category: await categoryId("Income") })).rows[0].id,
    ).toBe(salary);
    expect(
      (await list({ category: await categoryId("Income/Salary") })).total,
    ).toBe(1);
    expect((await list({ category: "none" })).total).toBe(4);
    // Several accounts.
    expect(
      (await listTransactions(forAccounts([id, other]), 1, db())).total,
    ).toBe(7);
  });

  it("lists pending transactions with their status and counts them", async () => {
    const id = await account();
    const [pending, booked] = await insert(id, [
      { date: "2024-05-03", amount: -500, status: "pending" },
      { date: "2024-05-02", amount: -300 },
    ]);
    const result = await listTransactions(forAccounts([id]), 1, db());
    expect(
      result.rows.map((row) => ({ id: row.id, status: row.status })),
    ).toEqual([
      { id: pending, status: "pending" },
      { id: booked, status: "booked" },
    ]);
    expect(result.total).toBe(2);
    expect(result.totals.expensesMinor).toBe(-800);
  });

  it("filters transfers in or out", async () => {
    const id = await account();
    const [kept, marked] = await insert(id, [
      { date: "2024-05-01", amount: -100 },
      { date: "2024-05-02", amount: -200 },
    ]);
    await markTransfer(marked, db());
    const only = await listTransactions(
      forAccounts([id], { transfers: "only" }),
      1,
      db(),
    );
    expect(only.rows.map((row) => row.id)).toEqual([marked]);
    const excluded = await listTransactions(
      forAccounts([id], { transfers: "exclude" }),
      1,
      db(),
    );
    expect(excluded.rows.map((row) => row.id)).toEqual([kept]);
  });

  it("marks excluded transactions and filters them in or out (F-027)", async () => {
    const id = await account();
    const [kept, loan] = await insert(id, [
      { date: "2024-05-01", amount: -100 },
      { date: "2024-05-02", amount: 18_000_000, counterparty: "Laina" },
    ]);
    await excludeTransaction(loan, db());
    const all = await listTransactions(forAccounts([id]), 1, db());
    expect(
      all.rows.map((row) => ({ id: row.id, excluded: row.excluded })),
    ).toEqual([
      { id: loan, excluded: true },
      { id: kept, excluded: false },
    ]);
    // The excluded credit is not income (F-034) but is shown as not counted.
    expect(all.totals).toMatchObject({ incomeMinor: 0, expensesMinor: -100 });
    expect(all.notCounted).toEqual({
      count: 1,
      sums: [{ currency: "EUR", creditMinor: 18_000_000, debitMinor: 0 }],
      reasons: [{ reason: "excluded", count: 1, filter: "excluded" }],
    });
    const only = await listTransactions(
      forAccounts([id], { excluded: "only" }),
      1,
      db(),
    );
    expect(only.rows.map((row) => row.id)).toEqual([loan]);
    const without = await listTransactions(
      forAccounts([id], { excluded: "exclude" }),
      1,
      db(),
    );
    expect(without.rows.map((row) => row.id)).toEqual([kept]);
    expect(without.total).toBe(1);
    expect(without.totals.incomeMinor).toBe(0);
    expect(without.notCounted.count).toBe(0);

    await includeTransaction(loan, db());
    expect(await stored(loan)).toMatchObject({
      categoryId: null,
      categorySource: "none",
    });
  });

  it("pages through more than 10 000 transactions", async () => {
    const id = await account();
    const count = 10_030;
    const values = Array.from({ length: count }, (_, i) => {
      const day = new Date(Date.UTC(2019, 0, 1 + Math.floor(i / 20)));
      return {
        accountId: id,
        dedupeHash: `bulk-${i}`,
        bookingDate: day.toISOString().slice(0, 10),
        amountMinor: -(100 + (i % 900)),
        currency: "EUR",
        counterparty: `Bulk ${i}`,
      };
    });
    for (let start = 0; start < count; start += 2_000) {
      await testDb.db
        .insert(transactions)
        .values(values.slice(start, start + 2_000));
    }
    const expense = values.reduce((sum, row) => sum + row.amountMinor, 0);

    const first = await listTransactions(forAccounts([id]), 1, db());
    expect(first).toMatchObject({ total: count, page: 1, pageCount: 201 });
    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(first.totals).toMatchObject({
      expensesMinor: expense,
      incomeMinor: 0,
    });
    expect(first.rows[0].bookingDate).toBe(values.at(-1)!.bookingDate);

    const last = await listTransactions(forAccounts([id]), 201, db());
    expect(last.rows).toHaveLength(30);
    expect(last.rows.at(-1)!.bookingDate).toBe("2019-01-01");

    // Every row once over all pages, and a page past the end is the last.
    const seen = new Set<string>();
    for (let page = 1; page <= 201; page++) {
      for (const row of (await listTransactions(forAccounts([id]), page, db()))
        .rows) {
        seen.add(row.id);
      }
    }
    expect(seen.size).toBe(count);
    expect((await listTransactions(forAccounts([id]), 999, db())).page).toBe(
      201,
    );
  });

  it("lists accounts for the filter, archived last", async () => {
    const name = `Listed ${randomUUID()}`;
    const id = await account(name);
    const options = await listAccountOptions(db());
    expect(options).toContainEqual({
      id,
      name,
      institution: "Other bank",
      archived: false,
    });
  });
});

describe("totals like the reports (F-034)", () => {
  // Only this test has rows in 2025, so a date range of 2025 and no other
  // filter is exactly what the cash-flow report sees.
  const NOW = new Date("2025-02-15T10:00:00Z");
  const FEBRUARY = { from: "2025-02-01", to: "2025-02-28" };
  const YEAR = { from: "2025-01-01", to: "2025-02-28" };

  const cashFlow = () =>
    getCashFlowReport({
      db: testDb.db,
      now: NOW,
      timeZone: "Europe/Helsinki",
      months: 1,
    });
  const list = (filter: Partial<TransactionFilter>) =>
    listTransactions({ ...EMPTY_FILTER, ...filter }, 1, db());

  async function setSettings(
    uncategorizedCreditsAsIncome: boolean,
    ignoreHouseholdTransfers: boolean,
  ) {
    await setAppSetting(
      "uncategorizedCreditsAsIncome",
      uncategorizedCreditsAsIncome,
      testDb.db,
    );
    await setAppSetting(
      "ignoreHouseholdTransfers",
      ignoreHouseholdTransfers,
      testDb.db,
    );
  }

  it("counts the filtered rows like getCashFlowReport and sums the rest as not counted", async () => {
    const main = await account();
    const savings = await account();
    const [salary, groceries, refund, debit, credit] = await insert(main, [
      { date: "2025-02-01", amount: 250_000, description: "Palkka helmikuu" },
      { date: "2025-02-03", amount: -8_000, counterparty: "S-Market Kamppi" },
      // A refund: a credit in an expense category nets against expenses.
      { date: "2025-02-04", amount: 1_500, counterparty: "S-Market Kamppi" },
      { date: "2025-02-05", amount: -2_200, counterparty: "Zyx Store" },
      { date: "2025-02-06", amount: 4_000, counterparty: "Zyx Friend" },
    ]);
    // An own transfer pair, linked by transfer detection on insert.
    const [out] = await insert(main, [
      { date: "2025-02-10", amount: -60_000, counterparty: "Zyx Own" },
    ]);
    const [into] = await insert(savings, [
      { date: "2025-02-10", amount: 60_000, counterparty: "Zyx Own" },
    ]);
    const [oneSided, loan, household] = await insert(main, [
      { date: "2025-02-12", amount: -7_500, counterparty: "Zyx Elsewhere" },
      { date: "2025-02-14", amount: -90_000, counterparty: "Zyx Lender" },
      { date: "2025-02-20", amount: 3_000, counterparty: "Zyx Spouse" },
    ]);
    await insert(main, [
      { date: "2025-02-21", amount: -1_000, currency: "SEK" },
    ]);
    await markTransfer(oneSided, db());
    await excludeTransaction(loan, db());
    // As categorisation marks a household member's payment (F-030).
    await testDb.db
      .update(transactions)
      .set({ household: true })
      .where(eq(transactions.id, household));
    // January, for the year to date: a row put in Transfers by hand is an
    // own transfer without a transfer group.
    const [, , manualTransfer] = await insert(main, [
      { date: "2025-01-31", amount: 250_000, description: "Palkka tammikuu" },
      { date: "2025-01-15", amount: -5_000, counterparty: "Zyx January" },
      { date: "2025-01-20", amount: -12_000, counterparty: "Zyx Moved" },
    ]);
    await setTransactionCategory(
      manualTransfer,
      await categoryId("Transfers"),
      db(),
    );

    expect((await stored(salary)).categoryId).toBe(
      await categoryId("Income/Salary"),
    );
    for (const id of [groceries, refund]) {
      expect((await stored(id)).categoryId).toBe(
        await categoryId("Groceries/Supermarkets"),
      );
    }
    for (const id of [debit, credit]) {
      expect((await stored(id)).categoryId).toBeNull();
    }
    const group = (await stored(out)).transferGroupId;
    expect(group).not.toBeNull();
    expect((await stored(into)).transferGroupId).toBe(group);

    try {
      for (const [asIncome, ignoreHousehold] of [
        [true, false],
        [false, false],
        [true, true],
        [false, true],
      ]) {
        await setSettings(asIncome, ignoreHousehold);
        const label = `credits as income ${asIncome}, ignore household ${ignoreHousehold}`;
        // The uncategorised credit, and the household one while it counts.
        const uncategorized = 4_000 + (ignoreHousehold ? 0 : 3_000);
        const report = await cashFlow();

        const february = await list(FEBRUARY);
        expect(february.total, label).toBe(11);
        expect(february.totals, label).toEqual({
          currency: "EUR",
          incomeMinor: 250_000 + (asIncome ? uncategorized : 0),
          expensesMinor: -8_000 + 1_500 - 2_200,
          netMinor: 250_000 + (asIncome ? uncategorized : 0) - 8_700,
          otherInMinor: asIncome ? 0 : uncategorized,
        });
        const month = report.months[0];
        expect(month.month).toBe("2025-02");
        expect(
          {
            incomeMinor: february.totals.incomeMinor,
            expensesMinor: -february.totals.expensesMinor,
            otherInMinor: february.totals.otherInMinor,
            netMinor: february.totals.netMinor,
          },
          label,
        ).toEqual({
          incomeMinor: month.incomeMinor,
          expensesMinor: month.expensesMinor,
          otherInMinor: month.otherInMinor,
          netMinor: month.netMinor,
        });

        // Not counted: the transfer pair, the one-sided transfer, the
        // excluded debit, the SEK row and, while ignored, the household
        // credit; with the counted rows that is every row.
        expect(february.notCounted, label).toEqual({
          count: ignoreHousehold ? 6 : 5,
          sums: [
            {
              currency: "EUR",
              creditMinor: 60_000 + (ignoreHousehold ? 3_000 : 0),
              debitMinor: -60_000 - 7_500 - 90_000,
            },
            { currency: "SEK", creditMinor: 0, debitMinor: -1_000 },
          ],
          reasons: [
            { reason: "transfer", count: 3, filter: "transfers" },
            { reason: "excluded", count: 1, filter: "excluded" },
            ...(ignoreHousehold
              ? [{ reason: "household", count: 1, filter: "household" }]
              : []),
            { reason: "currency", count: 1, filter: null },
          ],
        });
        const eurAmounts = [
          250_000, -8_000, 1_500, -2_200, 4_000, -60_000, 60_000, -7_500,
          -90_000, 3_000,
        ];
        const eur = february.notCounted.sums[0];
        expect(
          february.totals.incomeMinor +
            february.totals.expensesMinor +
            february.totals.otherInMinor +
            eur.creditMinor +
            eur.debitMinor,
          label,
        ).toBe(eurAmounts.reduce((sum, amount) => sum + amount, 0));

        // The year to date: the manual Transfers row is an own transfer,
        // which `transfers=only` (transfer groups) would not list.
        const year = await list(YEAR);
        expect(
          {
            incomeMinor: year.totals.incomeMinor,
            expensesMinor: -year.totals.expensesMinor,
            otherInMinor: year.totals.otherInMinor,
          },
          label,
        ).toEqual({
          incomeMinor: report.yearToDate.incomeMinor,
          expensesMinor: report.yearToDate.expensesMinor,
          otherInMinor: report.yearToDate.otherInMinor,
        });
        expect(year.totals.incomeMinor - february.totals.incomeMinor).toBe(
          250_000,
        );
        expect(year.notCounted.count).toBe(february.notCounted.count + 1);
        expect(year.notCounted.reasons[0]).toEqual({
          reason: "transfer",
          count: 4,
          filter: null,
        });
      }

      // Each reason's filter lists exactly its rows, which count nowhere.
      await setSettings(true, true);
      const transfers = await list({ ...FEBRUARY, transfers: "only" });
      expect(transfers.rows.map((row) => row.id).sort()).toEqual(
        [out, into, oneSided].sort(),
      );
      expect(transfers.totals).toMatchObject({
        incomeMinor: 0,
        expensesMinor: 0,
        netMinor: 0,
      });
      expect(transfers.notCounted).toEqual({
        count: 3,
        sums: [{ currency: "EUR", creditMinor: 60_000, debitMinor: -67_500 }],
        reasons: [{ reason: "transfer", count: 3, filter: "transfers" }],
      });
      const excluded = await list({ ...FEBRUARY, excluded: "only" });
      expect(excluded.rows.map((row) => row.id)).toEqual([loan]);
      expect(excluded.notCounted.count).toBe(1);
      const householdOnly = await list({ ...FEBRUARY, household: "only" });
      expect(householdOnly.rows.map((row) => row.id)).toEqual([household]);
      expect(householdOnly.notCounted.reasons).toEqual([
        { reason: "household", count: 1, filter: "household" },
      ]);

      // The `type` filter still goes by the sign: money in includes the
      // refund (which nets against expenses) and the transfer's credit.
      const moneyIn = await list({ ...FEBRUARY, direction: "income" });
      expect(moneyIn.total).toBe(5);
      expect(moneyIn.totals).toMatchObject({
        incomeMinor: 254_000,
        expensesMinor: 1_500,
      });
      expect(moneyIn.notCounted).toMatchObject({ count: 2 });
    } finally {
      await setSettings(true, false);
    }
  });
});

describe("transaction edits", () => {
  it("a manual category survives re-apply; automatic hands it back", async () => {
    const id = await account();
    const [salary] = await insert(id, [
      { date: "2024-06-01", amount: 100_000, description: "Palkka kesäkuu" },
    ]);
    const salaryCategory = await categoryId("Income/Salary");
    expect(await stored(salary)).toMatchObject({
      categoryId: salaryCategory,
      categorySource: "rule",
    });

    const uncategorized = await categoryId("Uncategorized");
    await setTransactionCategory(salary, uncategorized, db());
    await reapplyRules(db());
    expect(await stored(salary)).toMatchObject({
      categoryId: uncategorized,
      categorySource: "manual",
    });

    await setTransactionCategory(salary, "auto", db());
    expect(await stored(salary)).toMatchObject({
      categoryId: salaryCategory,
      categorySource: "rule",
    });

    await expect(
      setTransactionCategory(salary, randomUUID(), db()),
    ).rejects.toThrow(CategoryManageError);
    await expect(
      setTransactionCategory(randomUUID(), uncategorized, db()),
    ).rejects.toThrow("The transaction is gone.");
  });

  it("saves and clears a note", async () => {
    const id = await account();
    const [row] = await insert(id, [{ date: "2024-06-02", amount: -100 }]);
    await setTransactionNote(row, "  for the trip  ", db());
    expect((await stored(row)).note).toBe("for the trip");
    await setTransactionNote(row, "   ", db());
    expect((await stored(row)).note).toBeNull();
    await expect(
      setTransactionNote(row, "x".repeat(1_001), db()),
    ).rejects.toThrow(CategoryManageError);
  });

  it("a marked one-sided transfer stays one-sided and manual", async () => {
    const from = await account();
    const to = await account();
    const [leg] = await insert(from, [
      { date: "2024-07-01", amount: -12_345, counterparty: "Elsewhere" },
    ]);
    await markTransfer(leg, db());
    const marked = await stored(leg);
    expect(marked).toMatchObject({
      categoryId: await categoryId("Transfers"),
      categorySource: "manual",
    });
    expect(marked.transferGroupId).not.toBeNull();
    await expect(markTransfer(leg, db())).rejects.toThrow(
      "The transaction is already a transfer.",
    );

    // An equal credit on another own account does not join the manual leg.
    const [credit] = await insert(to, [{ date: "2024-07-02", amount: 12_345 }]);
    await reapplyRules(db());
    expect((await stored(leg)).transferGroupId).toBe(marked.transferGroupId);
    expect((await stored(credit)).transferGroupId).toBeNull();
  });

  it("unlinking a detected pair keeps both legs out of transfers", async () => {
    const from = await account();
    const to = await account();
    const [debit] = await insert(from, [
      { date: "2024-08-01", amount: -54_321, description: "Rent August" },
    ]);
    const [credit] = await insert(to, [{ date: "2024-08-01", amount: 54_321 }]);
    // "Rent" gives the debit a rule category, so detection would pair it
    // only by IBAN: put both legs into one group directly.
    await testDb.db
      .update(transactions)
      .set({ transferGroupId: randomUUID() })
      .where(eq(transactions.id, debit));
    const [{ transferGroupId }] = await testDb.db
      .select({ transferGroupId: transactions.transferGroupId })
      .from(transactions)
      .where(eq(transactions.id, debit));
    await testDb.db
      .update(transactions)
      .set({ transferGroupId })
      .where(eq(transactions.id, credit));

    await expect(unlinkTransfer(randomUUID(), db())).rejects.toThrow(
      "The transaction is gone.",
    );
    await unlinkTransfer(credit, db());
    expect(await stored(debit)).toMatchObject({
      transferGroupId: null,
      categoryId: await categoryId("Housing/Rent & maintenance"),
      categorySource: "manual",
    });
    expect(await stored(credit)).toMatchObject({
      transferGroupId: null,
      categoryId: null,
      categorySource: "manual",
    });
    await expect(unlinkTransfer(debit, db())).rejects.toThrow(
      "The transaction is not a transfer.",
    );

    await reapplyRules(db());
    const rows = await testDb.db
      .select({ group: transactions.transferGroupId })
      .from(transactions)
      .where(inArray(transactions.id, [debit, credit]));
    expect(rows).toEqual([{ group: null }, { group: null }]);
  });
});

describe("categories and rules", () => {
  it("creates subcategories with the parent's kind, two levels only", async () => {
    const parent = await createCategory(
      { name: `Hobbies ${randomUUID()}`, parentId: null, kind: "income" },
      db(),
    );
    const child = await createCategory(
      { name: "Climbing", parentId: parent, kind: "expense" },
      db(),
    );
    const options = await listCategoryOptions(db());
    expect(options.find((option) => option.id === child)).toMatchObject({
      kind: "income",
      parentId: parent,
    });
    await expect(
      createCategory(
        { name: "Too deep", parentId: child, kind: "expense" },
        db(),
      ),
    ).rejects.toThrow("A subcategory cannot have subcategories.");
    await expect(
      createCategory(
        { name: " Climbing ", parentId: parent, kind: "expense" },
        db(),
      ),
    ).rejects.toThrow("A category Climbing already exists here.");
    await expect(
      createCategory({ name: "  ", parentId: null, kind: "expense" }, db()),
    ).rejects.toThrow("Enter a name.");
    await renameCategory(child, "Bouldering", db());
    expect(
      (await listCategoryOptions(db())).find((option) => option.id === child)
        ?.label,
    ).toMatch(/ › Bouldering$/);
  });

  it("protects the Transfers and Excluded categories", async () => {
    const transfers = await categoryId("Transfers");
    const excluded = await categoryId("Excluded");
    for (const id of [transfers, excluded]) {
      await expect(deleteCategory(id, db())).rejects.toThrow(
        CategoryManageError,
      );
      await expect(renameCategory(id, "Moves", db())).rejects.toThrow(
        CategoryManageError,
      );
    }
    await expect(
      createCategory(
        { name: "Loans", parentId: excluded, kind: "expense" },
        db(),
      ),
    ).rejects.toThrow("Excluded cannot have subcategories.");
    const usage = await listCategoryUsage(db());
    expect(
      usage
        .filter((category) => category.protected)
        .map((c) => c.id)
        .sort(),
    ).toEqual([transfers, excluded].sort());
  });

  it("deleting a category deletes its subcategories and rules and frees its transactions", async () => {
    const parent = await createCategory(
      { name: `Pets ${randomUUID()}`, parentId: null, kind: "expense" },
      db(),
    );
    const child = await createCategory(
      { name: "Vet", parentId: parent, kind: "expense" },
      db(),
    );
    const tag = randomUUID();
    const rule = await createRule(
      {
        categoryId: child,
        matchField: "counterparty",
        matchType: "contains",
        pattern: `Vet clinic ${tag}`,
        amountSign: null,
        amountMinMinor: null,
        amountMaxMinor: null,
      },
      db(),
    );
    const id = await account();
    const [byRule, byHand] = await insert(id, [
      { date: "2024-09-01", amount: -8_000, counterparty: `Vet clinic ${tag}` },
      { date: "2024-09-02", amount: -2_000, counterparty: "Pet shop" },
    ]);
    await setTransactionCategory(byHand, parent, db());
    expect((await stored(byRule)).categoryId).toBe(child);

    await deleteCategory(parent, db());
    expect(await listCategoryOptions(db())).not.toContainEqual(
      expect.objectContaining({ id: child }),
    );
    expect(
      await testDb.db
        .select()
        .from(categoryRules)
        .where(eq(categoryRules.id, rule)),
    ).toEqual([]);
    for (const row of [byRule, byHand]) {
      expect(await stored(row)).toMatchObject({
        categoryId: null,
        categorySource: "none",
      });
    }
  });

  it("a transfer leg in a deleted category gets Transfers back", async () => {
    const category = await createCategory(
      { name: `Moves ${randomUUID()}`, parentId: null, kind: "transfer" },
      db(),
    );
    const id = await account();
    const [leg] = await insert(id, [{ date: "2024-09-10", amount: -4_444 }]);
    await markTransfer(leg, db());
    await setTransactionCategory(leg, category, db());
    await deleteCategory(category, db());
    const row = await stored(leg);
    expect(row).toMatchObject({
      categoryId: await categoryId("Transfers"),
      categorySource: "manual",
    });
    expect(row.transferGroupId).not.toBeNull();
  });

  it("new rules run first; moving renumbers in the new order", async () => {
    const category = await categoryId("Shopping");
    const rule = (pattern: string) =>
      createRule(
        {
          categoryId: category,
          matchField: "description",
          matchType: "contains",
          pattern,
          amountSign: null,
          amountMinMinor: null,
          amountMaxMinor: null,
        },
        db(),
      );
    const first = await rule(`first ${randomUUID()}`);
    const second = await rule(`second ${randomUUID()}`);
    let rules = await listRules(db());
    expect(rules.slice(0, 2).map((r) => r.id)).toEqual([second, first]);

    // Move the newest rule to just after a seeded rule further down.
    const target = rules[10].id;
    await moveRule(second, target, "after", db());
    rules = await listRules(db());
    const ids = rules.map((r) => r.id);
    expect(ids.indexOf(second)).toBe(ids.indexOf(target) + 1);
    expect(ids[0]).toBe(first);
    expect(rules.map((r) => r.priority)).toEqual(
      rules.map((_, index) => (index + 1) * 10),
    );

    await moveRule(second, first, "before", db());
    expect((await listRules(db())).slice(0, 2).map((r) => r.id)).toEqual([
      second,
      first,
    ]);
    await expect(
      moveRule(second, randomUUID(), "before", db()),
    ).rejects.toThrow("The rule is gone.");
  });

  it("a moved rule changes which category wins on re-apply", async () => {
    const tag = randomUUID();
    const cafes = await categoryId("Restaurants & cafés/Cafés");
    const groceries = await categoryId("Groceries/Supermarkets");
    const make = (categoryId: string) =>
      createRule(
        {
          categoryId,
          matchField: "counterparty",
          matchType: "contains",
          pattern: `Corner ${tag}`,
          amountSign: null,
          amountMinMinor: null,
          amountMaxMinor: null,
        },
        db(),
      );
    const cafeRule = await make(cafes);
    const groceryRule = await make(groceries);
    const id = await account();
    const [row] = await insert(id, [
      { date: "2024-10-01", amount: -500, counterparty: `Corner ${tag}` },
    ]);
    // The newer rule runs first.
    expect((await stored(row)).categoryId).toBe(groceries);
    await moveRule(cafeRule, groceryRule, "before", db());
    await reapplyRules(db());
    expect((await stored(row)).categoryId).toBe(cafes);
  });
});
