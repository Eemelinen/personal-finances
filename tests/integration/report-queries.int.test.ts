import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accounts,
  appSettings,
  categories,
  institutions,
  transactions,
} from "@/server/db/schema";
import {
  getCashFlowReport,
  getMonthCashFlow,
  getSpendingReport,
  OTHER_COLOR,
  UNCATEGORIZED_PARAM,
} from "@/server/queries/reports";
import { resolvePeriod } from "@/server/reports/period";
import { getAppSettings, setAppSetting } from "@/server/settings";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// The report read models against a real Postgres 18: spending per category
// and per month, the comparisons, top merchants, drill-down lists and cash
// flow. Own transfers stay out, refunds net against their category, months
// follow the Helsinki calendar. With the `uncategorizedCreditsAsIncome`
// setting off (F-026), credits without an income category are other money
// in. Excluded transactions (F-027) count nowhere. Each test starts from
// empty tables.

const TIME_ZONE = "Europe/Helsinki";
const NOW = new Date("2026-10-24T09:00:00Z");
const TODAY = "2026-10-24";
const OCTOBER = resolvePeriod({ period: "this-month" }, TODAY);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

interface Categories {
  groceries: string;
  supermarkets: string;
  alko: string;
  restaurants: string;
  income: string;
  salary: string;
  transfers: string;
  savings: string;
  uncategorized: string;
}

let checking: string;
let savingsAccount: string;
let cat: Categories;

async function category(
  name: string,
  kind: "expense" | "income" | "transfer" | "excluded",
  color: string | null,
  parentId?: string,
) {
  const [row] = await testDb.db
    .insert(categories)
    .values({ name, kind, color, parentId })
    .returning();
  return row.id;
}

beforeEach(async () => {
  await testDb.db.execute(
    sql`TRUNCATE ${institutions}, ${accounts}, ${transactions}, ${categories}, ${appSettings} CASCADE`,
  );
  const [bank] = await testDb.db
    .insert(institutions)
    .values({
      name: "Nordea",
      country: "FI",
      provider: "csv",
      providerRef: randomUUID(),
    })
    .returning();
  const insertAccount = async (name: string, type: "checking" | "savings") => {
    const [row] = await testDb.db
      .insert(accounts)
      .values({ institutionId: bank.id, name, type, currency: "EUR" })
      .returning();
    return row.id;
  };
  checking = await insertAccount("Käyttötili", "checking");
  savingsAccount = await insertAccount("Säästötili", "savings");

  const groceries = await category("Groceries", "expense", "#22c55e");
  const income = await category("Income", "income", "#16a34a");
  const savings = await category(
    "Savings & investments",
    "transfer",
    "#0891b2",
  );
  cat = {
    groceries,
    supermarkets: await category(
      "Supermarkets",
      "expense",
      "#22c55e",
      groceries,
    ),
    alko: await category("Alko", "expense", "#22c55e", groceries),
    restaurants: await category("Restaurants & cafés", "expense", "#f97316"),
    income,
    salary: await category("Salary", "income", "#16a34a", income),
    transfers: await category("Transfers", "transfer", "#64748b"),
    savings,
    uncategorized: await category("Uncategorized", "expense", "#94a3b8"),
  };
});

let sequence = 0;

/** A transaction; `category: null` leaves it uncategorised. */
async function txn(
  bookingDate: string,
  amountMinor: number,
  values: Partial<typeof transactions.$inferInsert> = {},
) {
  sequence += 1;
  const [row] = await testDb.db
    .insert(transactions)
    .values({
      accountId: checking,
      dedupeHash: `hash-${sequence}`,
      bookingDate,
      amountMinor,
      currency: "EUR",
      ...values,
    })
    .returning();
  return row;
}

/** Two legs of an own transfer, linked as F-014 links them. */
async function transfer(bookingDate: string, amountMinor: number) {
  const group = randomUUID();
  await txn(bookingDate, -amountMinor, {
    categoryId: cat.transfers,
    transferGroupId: group,
  });
  await txn(bookingDate, amountMinor, {
    accountId: savingsAccount,
    categoryId: cat.transfers,
    transferGroupId: group,
  });
}

/** October's transactions, plus September and earlier months to compare. */
async function seedYear() {
  // October 2026.
  await txn("2026-10-02", -5_000, {
    categoryId: cat.supermarkets,
    counterparty: "K-MARKET KAMPPI",
  });
  await txn("2026-10-09", -3_000, {
    categoryId: cat.supermarkets,
    counterparty: "K-Market Itis 1234",
  });
  // A refund in the same category nets against it.
  await txn("2026-10-10", 1_000, {
    categoryId: cat.supermarkets,
    counterparty: "K-MARKET KAMPPI",
  });
  await txn("2026-10-12", -1_500, {
    categoryId: cat.groceries,
    counterparty: "LÄHIKAUPPA OY",
  });
  await txn("2026-10-20", -400, {
    categoryId: cat.supermarkets,
    counterparty: "PRISMA LAAJASALO",
    status: "pending",
  });
  await txn("2026-10-15", -2_000, {
    categoryId: cat.restaurants,
    counterparty: "SUMUP *KAHVILA PIENI",
  });
  // Uncategorised: the debit is spending, the credit income.
  await txn("2026-10-16", -1_000, { counterparty: "Tuntematon kauppa" });
  await txn("2026-10-17", 500, { counterparty: "Kaveri" });
  await txn("2026-10-01", 300_000, {
    categoryId: cat.salary,
    counterparty: "Työnantaja Oy",
  });
  // Never spending or income: own transfers, savings, other currencies.
  await transfer("2026-10-05", 50_000);
  await txn("2026-10-06", -20_000, { categoryId: cat.savings });
  await txn("2026-10-07", -9_999, {
    categoryId: cat.restaurants,
    currency: "USD",
  });
  // September 2026: the previous period.
  await txn("2026-09-30", -6_000, { categoryId: cat.supermarkets });
  await txn("2026-09-14", -4_000, { categoryId: cat.restaurants });
  await txn("2026-09-01", 300_000, { categoryId: cat.salary });
  await transfer("2026-09-05", 50_000);
  // April – August: the 6-month average with September (no data before April).
  for (const month of ["04", "05", "06", "07", "08"]) {
    await txn(`2026-${month}-10`, -6_000, { categoryId: cat.supermarkets });
    await txn(`2026-${month}-01`, 280_000, { categoryId: cat.salary });
  }
  // January 2026 is in the year to date but no rows in between.
  await txn("2026-01-20", -12_000, { categoryId: cat.restaurants });
}

describe("getSpendingReport", () => {
  it("is empty without transactions", async () => {
    const report = await getSpendingReport({
      db: testDb.db,
      period: OCTOBER,
    });
    expect(report.empty).toBe(true);
    expect(report.totalMinor).toBe(0);
    expect(report.categories).toEqual([]);
    expect(report.merchants).toEqual([]);
    expect(report.trend.series).toEqual([]);
    expect(report.trend.months).toHaveLength(12);
    expect(report.averageTotalMinor).toBeNull();
    expect(report.transactions).toBeNull();
  });

  it("sums spending per top-level category with refunds netted and transfers left out", async () => {
    await seedYear();
    const report = await getSpendingReport({ db: testDb.db, period: OCTOBER });

    expect(report.empty).toBe(false);
    expect(report.period).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(report.previous).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(report.average).toEqual({ from: "2026-04-01", to: "2026-09-30" });
    // Groceries 5 000 + 3 000 − 1 000 + 1 500 + 400; restaurants 2 000;
    // uncategorised 1 000. Salary, the +500, transfers, savings and USD are out.
    expect(report.totalMinor).toBe(11_900);
    expect(
      report.categories.map(
        ({ param, name, amountMinor, color, hasChildren }) => ({
          param,
          name,
          amountMinor,
          color,
          hasChildren,
        }),
      ),
    ).toEqual([
      {
        param: cat.groceries,
        name: "Groceries",
        amountMinor: 8_900,
        color: "#22c55e",
        hasChildren: true,
      },
      {
        param: cat.restaurants,
        name: "Restaurants & cafés",
        amountMinor: 2_000,
        color: "#f97316",
        hasChildren: false,
      },
      {
        param: cat.uncategorized,
        name: "Uncategorized",
        amountMinor: 1_000,
        color: "#94a3b8",
        hasChildren: false,
      },
    ]);
    const [groceries, restaurants] = report.categories;
    expect(groceries.share).toBeCloseTo(8_900 / 11_900, 10);
    expect(report.categories.reduce((sum, c) => sum + c.share!, 0)).toBeCloseTo(
      1,
      10,
    );
    // Previous period: September.
    expect(groceries.previousMinor).toBe(6_000);
    expect(restaurants.previousMinor).toBe(4_000);
    expect(report.previousTotalMinor).toBe(10_000);
    // April – September: 6 × 6 000 groceries, 4 000 restaurants, over 6 months.
    expect(groceries.averageMinor).toBe(6_000);
    expect(restaurants.averageMinor).toBe(Math.round(4_000 / 6));
    expect(report.averageTotalMinor).toBe(Math.round(40_000 / 6));
  });

  it("averages only over months since the first transaction", async () => {
    await txn("2026-09-10", -3_000, { categoryId: cat.restaurants });
    await txn("2026-08-10", -1_000, { categoryId: cat.restaurants });
    const report = await getSpendingReport({ db: testDb.db, period: OCTOBER });
    expect(report.categories[0].amountMinor).toBe(0);
    expect(report.categories[0].previousMinor).toBe(3_000);
    expect(report.averageTotalMinor).toBe(2_000);
  });

  it("drills into a category's subcategories and its transactions", async () => {
    await seedYear();
    const report = await getSpendingReport({
      db: testDb.db,
      period: OCTOBER,
      category: cat.groceries,
    });
    expect(report.scope.level).toBe("category");
    expect(report.totalMinor).toBe(8_900);
    expect(
      report.categories.map(({ param, name, amountMinor, opacity }) => ({
        param,
        name,
        amountMinor,
        opacity,
      })),
    ).toEqual([
      {
        param: cat.supermarkets,
        name: "Supermarkets",
        amountMinor: 7_400,
        opacity: 1,
      },
      {
        param: cat.groceries,
        name: "Groceries (no subcategory)",
        amountMinor: 1_500,
        // Same colour as Supermarkets: a lighter step.
        opacity: 0.8,
      },
    ]);
    expect(report.categories.every((c) => !c.hasChildren)).toBe(true);
    expect(report.transactions?.total).toBe(5);
    expect(
      report.transactions?.rows.map((row) => [
        row.bookingDate,
        row.amountMinor,
        row.category,
        row.pending,
      ]),
    ).toEqual([
      ["2026-10-20", -400, "Supermarkets", true],
      ["2026-10-12", -1_500, "Groceries", false],
      ["2026-10-10", 1_000, "Supermarkets", false],
      ["2026-10-09", -3_000, "Supermarkets", false],
      ["2026-10-02", -5_000, "Supermarkets", false],
    ]);
    expect(report.transactions?.rows[0].account).toBe("Käyttötili");
    // The list adds up to the category's spending.
    expect(
      -report.transactions!.rows.reduce((sum, row) => sum + row.amountMinor, 0),
    ).toBe(8_900);
  });

  it("drills into a subcategory and into Uncategorized", async () => {
    await seedYear();
    const supermarkets = await getSpendingReport({
      db: testDb.db,
      period: OCTOBER,
      category: cat.supermarkets,
    });
    expect(supermarkets.scope.level).toBe("subcategory");
    expect(supermarkets.totalMinor).toBe(7_400);
    expect(supermarkets.transactions?.total).toBe(4);

    const none = await getSpendingReport({
      db: testDb.db,
      period: OCTOBER,
      category: UNCATEGORIZED_PARAM,
    });
    // Stands in for the Uncategorized category; only the debit is spending.
    expect(none.scope).toMatchObject({
      level: "category",
      category: { id: cat.uncategorized },
    });
    expect(none.transactions?.rows.map((row) => row.amountMinor)).toEqual([
      -1_000,
    ]);
    expect(none.transactions?.rows[0].category).toBe("Uncategorized");

    // Without an Uncategorized category, none is its own scope.
    await testDb.db.execute(
      sql`DELETE FROM ${categories} WHERE ${categories.id} = ${cat.uncategorized}`,
    );
    const bare = await getSpendingReport({
      db: testDb.db,
      period: OCTOBER,
      category: UNCATEGORIZED_PARAM,
    });
    expect(bare.scope.level).toBe("uncategorized");
    expect(bare.totalMinor).toBe(1_000);
    const all = await getSpendingReport({ db: testDb.db, period: OCTOBER });
    expect(all.categories.at(-1)).toMatchObject({
      param: UNCATEGORIZED_PARAM,
      name: "Uncategorized",
      amountMinor: 1_000,
    });
  });

  it("ignores a category that is unknown or not spending", async () => {
    await seedYear();
    for (const category of [randomUUID(), cat.salary, cat.transfers, "x"]) {
      const report = await getSpendingReport({
        db: testDb.db,
        period: OCTOBER,
        category,
      });
      expect(report.scope.level).toBe("all");
      expect(report.transactions).toBeNull();
    }
  });

  it("stacks 12 months of spending per category", async () => {
    await seedYear();
    const report = await getSpendingReport({ db: testDb.db, period: OCTOBER });
    const { series, months } = report.trend;
    expect(months.map((m) => m.month)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    // Largest over the 12 months first.
    expect(series.map((s) => s.name)).toEqual([
      "Groceries",
      "Restaurants & cafés",
      "Uncategorized",
    ]);
    const value = (month: string, key: string) =>
      months.find((m) => m.month === month)!.values[key];
    expect(value("2026-10", cat.groceries)).toBe(8_900);
    expect(value("2026-09", cat.groceries)).toBe(6_000);
    expect(value("2026-09", cat.restaurants)).toBe(4_000);
    expect(value("2026-01", cat.restaurants)).toBe(12_000);
    expect(value("2026-02", cat.groceries)).toBe(0);
  });

  it("folds categories past the series limit into Other", async () => {
    for (let i = 1; i <= 9; i++) {
      const id = await category(`Category ${i}`, "expense", `#00000${i}`);
      await txn("2026-10-03", -i * 100, { categoryId: id });
    }
    const report = await getSpendingReport({ db: testDb.db, period: OCTOBER });
    expect(report.trend.series).toHaveLength(7);
    expect(report.trend.series.at(-1)).toMatchObject({
      key: "other",
      color: OTHER_COLOR,
    });
    const october = report.trend.months.at(-1)!.values;
    // Categories 1–3 fold into Other.
    expect(october.other).toBe(600);
    expect(Object.values(october).reduce((a, b) => a + b, 0)).toBe(4_500);
  });

  it("lists the top merchants by normalised name", async () => {
    await seedYear();
    const report = await getSpendingReport({ db: testDb.db, period: OCTOBER });
    expect(report.merchants).toEqual([
      // 5 000 + 3 000 − 1 000: both stores, the refund netted.
      { name: "K-Market", amountMinor: 7_000, count: 3 },
      { name: "Kahvila Pieni", amountMinor: 2_000, count: 1 },
      { name: "Lähikauppa", amountMinor: 1_500, count: 1 },
      { name: "Tuntematon kauppa", amountMinor: 1_000, count: 1 },
      { name: "Prisma", amountMinor: 400, count: 1 },
    ]);
  });

  it("compares a custom range with as many days before it", async () => {
    await txn("2026-10-10", -1_000, { categoryId: cat.restaurants });
    await txn("2026-10-05", -700, { categoryId: cat.restaurants });
    await txn("2026-10-04", -300, { categoryId: cat.restaurants });
    const period = resolvePeriod(
      { period: "custom", from: "2026-10-08", to: "2026-10-12" },
      TODAY,
    );
    const report = await getSpendingReport({ db: testDb.db, period });
    expect(report.previous).toEqual({ from: "2026-10-03", to: "2026-10-07" });
    expect(report.totalMinor).toBe(1_000);
    expect(report.previousTotalMinor).toBe(1_000);
  });
});

describe("getCashFlowReport", () => {
  it("is empty without transactions", async () => {
    const report = await getCashFlowReport({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
    });
    expect(report.empty).toBe(true);
    expect(report.months).toHaveLength(12);
    expect(report.months.at(-1)).toEqual({
      month: "2026-10",
      incomeMinor: 0,
      expensesMinor: 0,
      netMinor: 0,
      savingsRate: null,
      otherInMinor: 0,
    });
  });

  it("sums income and expenses per month with transfers out and refunds netted", async () => {
    await seedYear();
    const report = await getCashFlowReport({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
    });
    expect(report.months.map((m) => m.month)[0]).toBe("2025-11");
    const october = report.months.at(-1)!;
    // Salary + the uncategorised credit; spending as in the spending report.
    expect(october).toMatchObject({
      month: "2026-10",
      incomeMinor: 300_500,
      expensesMinor: 11_900,
      netMinor: 288_600,
    });
    expect(october.savingsRate).toBeCloseTo(288_600 / 300_500, 10);
    expect(report.months.at(-2)).toMatchObject({
      month: "2026-09",
      incomeMinor: 300_000,
      expensesMinor: 10_000,
      netMinor: 290_000,
    });
    // A month with only spending: negative net, no savings rate.
    expect(report.months.find((m) => m.month === "2026-01")).toEqual({
      month: "2026-01",
      incomeMinor: 0,
      expensesMinor: 12_000,
      netMinor: -12_000,
      savingsRate: null,
      otherInMinor: 0,
    });
    const income = 300_500 + 300_000 + 5 * 280_000;
    const expenses = 11_900 + 10_000 + 5 * 6_000 + 12_000;
    expect(report.yearToDate).toMatchObject({
      year: 2026,
      incomeMinor: income,
      expensesMinor: expenses,
      netMinor: income - expenses,
    });
    expect(report.yearToDate.savingsRate).toBeCloseTo(
      (income - expenses) / income,
      10,
    );
  });

  it("counts the year to date from January even before the chart starts", async () => {
    await txn("2026-01-15", -1_000, { categoryId: cat.restaurants });
    await txn("2025-12-15", -5_000, { categoryId: cat.restaurants });
    const report = await getCashFlowReport({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
      months: 3,
    });
    expect(report.months.map((m) => m.month)).toEqual([
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    expect(report.yearToDate.expensesMinor).toBe(1_000);
  });

  it("follows the Helsinki calendar at a month boundary", async () => {
    await txn("2026-10-31", -2_000, { categoryId: cat.restaurants });
    await txn("2026-11-01", -500, { categoryId: cat.restaurants });
    await txn("2026-11-01", 100_000, { categoryId: cat.salary });
    // 22:30 UTC on 31 October is 00:30 on 1 November in Helsinki.
    const now = new Date("2026-10-31T22:30:00Z");
    const month = await getMonthCashFlow({
      db: testDb.db,
      now,
      timeZone: TIME_ZONE,
    });
    expect(month).toMatchObject({
      month: "2026-11",
      incomeMinor: 100_000,
      expensesMinor: 500,
      netMinor: 99_500,
    });
    // In UTC it is still October.
    const utc = await getMonthCashFlow({ db: testDb.db, now, timeZone: "UTC" });
    expect(utc).toMatchObject({ month: "2026-10", expensesMinor: 2_000 });

    const report = await getCashFlowReport({
      db: testDb.db,
      now,
      timeZone: TIME_ZONE,
    });
    expect(report.months.at(-2)).toMatchObject({
      month: "2026-10",
      expensesMinor: 2_000,
    });

    // The spending report's months split on the same day.
    const november = resolvePeriod({ period: "this-month" }, "2026-11-01");
    const spending = await getSpendingReport({
      db: testDb.db,
      period: november,
    });
    expect(spending.totalMinor).toBe(500);
    expect(spending.previousTotalMinor).toBe(2_000);
    const trend = spending.trend.months.slice(-2);
    expect(trend.map((m) => [m.month, m.values[cat.restaurants]])).toEqual([
      ["2026-10", 2_000],
      ["2026-11", 500],
    ]);
  });
});

describe("the uncategorizedCreditsAsIncome setting (F-026)", () => {
  const cashFlow = (extra: { uncategorizedCreditsAsIncome?: boolean } = {}) =>
    getCashFlowReport({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
      ...extra,
    });

  it("is stored and read back, on without a row", async () => {
    expect(await getAppSettings(testDb.db)).toEqual({
      uncategorizedCreditsAsIncome: true,
    });
    await setAppSetting("uncategorizedCreditsAsIncome", false, testDb.db);
    expect((await getAppSettings(testDb.db)).uncategorizedCreditsAsIncome).toBe(
      false,
    );
    await setAppSetting("uncategorizedCreditsAsIncome", true, testDb.db);
    expect((await getAppSettings(testDb.db)).uncategorizedCreditsAsIncome).toBe(
      true,
    );
    const rows = await testDb.db.select().from(appSettings);
    expect(rows).toHaveLength(1);
  });

  it("on, keeps today's totals: an uncategorised credit is income", async () => {
    await seedYear();
    const byDefault = await cashFlow();
    await setAppSetting("uncategorizedCreditsAsIncome", true, testDb.db);
    expect(await cashFlow()).toEqual(byDefault);
    expect(byDefault.months.at(-1)).toMatchObject({
      incomeMinor: 300_500,
      expensesMinor: 11_900,
      netMinor: 288_600,
      otherInMinor: 0,
    });
    expect(byDefault.yearToDate.otherInMinor).toBe(0);
  });

  it("off, moves an uncategorised credit to other money in and keeps salary and refunds", async () => {
    await seedYear();
    // A credit straight in the top-level Income category stays income too.
    await txn("2026-10-03", 10_000, { categoryId: cat.income });
    await setAppSetting("uncategorizedCreditsAsIncome", false, testDb.db);

    const report = await cashFlow();
    const october = report.months.at(-1)!;
    // Salary and Income; the uncategorised +500 is other money in; the
    // supermarket refund still nets (11 900 as before), the uncategorised
    // debit is still spending.
    expect(october).toMatchObject({
      month: "2026-10",
      incomeMinor: 310_000,
      expensesMinor: 11_900,
      netMinor: 298_100,
      otherInMinor: 500,
    });
    expect(october.savingsRate).toBeCloseTo(298_100 / 310_000, 10);
    expect(report.months.at(-2)).toMatchObject({
      month: "2026-09",
      incomeMinor: 300_000,
      otherInMinor: 0,
    });
    const income = 310_000 + 300_000 + 5 * 280_000;
    const expenses = 11_900 + 10_000 + 5 * 6_000 + 12_000;
    expect(report.yearToDate).toMatchObject({
      incomeMinor: income,
      expensesMinor: expenses,
      netMinor: income - expenses,
      otherInMinor: 500,
    });

    expect(
      await getMonthCashFlow({ db: testDb.db, now: NOW, timeZone: TIME_ZONE }),
    ).toMatchObject({ incomeMinor: 310_000, otherInMinor: 500 });

    // The spending report does not depend on the setting.
    const spending = await getSpendingReport({
      db: testDb.db,
      period: OCTOBER,
    });
    expect(spending.totalMinor).toBe(11_900);
  });

  it("counts a transaction in Uncategorized exactly like one without a category", async () => {
    await txn("2026-10-04", 700, { categoryId: cat.uncategorized });
    await txn("2026-10-05", -300, { categoryId: cat.uncategorized });
    await txn("2026-10-06", 200, { counterparty: "Kaveri" });

    const on = (await cashFlow()).months.at(-1)!;
    expect(on).toMatchObject({
      incomeMinor: 900,
      expensesMinor: 300,
      netMinor: 600,
      otherInMinor: 0,
    });

    // The option overrides the stored setting.
    await setAppSetting("uncategorizedCreditsAsIncome", false, testDb.db);
    expect(
      (await cashFlow({ uncategorizedCreditsAsIncome: true })).months.at(-1),
    ).toEqual(on);
    expect((await cashFlow()).months.at(-1)).toEqual({
      month: "2026-10",
      incomeMinor: 0,
      expensesMinor: 300,
      netMinor: -300,
      savingsRate: null,
      otherInMinor: 900,
    });

    // The credit in Uncategorized is no longer negative spending.
    const spending = await getSpendingReport({
      db: testDb.db,
      period: OCTOBER,
    });
    expect(spending.totalMinor).toBe(300);
    expect(spending.categories).toMatchObject([
      { param: cat.uncategorized, amountMinor: 300 },
    ]);
    const drill = await getSpendingReport({
      db: testDb.db,
      period: OCTOBER,
      category: UNCATEGORIZED_PARAM,
    });
    expect(drill.transactions?.rows.map((row) => row.amountMinor)).toEqual([
      -300,
    ]);
  });
});

describe("excluded transactions (F-027)", () => {
  let excluded: string;

  /** A loan drawdown and the purchase it paid, plus older excluded rows. */
  async function seedExcluded() {
    excluded = await category("Excluded", "excluded", "#a8a29e");
    await txn("2026-10-08", 18_000_000, {
      categoryId: excluded,
      categorySource: "manual",
      counterparty: "Oma Pankki",
      description: "Asuntolainan nosto",
    });
    await txn("2026-10-08", -15_000_000, {
      categoryId: excluded,
      categorySource: "manual",
      counterparty: "Asunto Myyjä",
    });
    // A rule excluded these: the previous period and the average window.
    await txn("2026-09-20", -2_500_000, {
      categoryId: excluded,
      categorySource: "rule",
      counterparty: "Asunto Myyjä",
    });
    await txn("2026-06-15", 40_000, {
      categoryId: excluded,
      categorySource: "rule",
      counterparty: "Pankin korjaus",
    });
  }

  it("leaves excluded debits out of spending, merchants, averages and drill-downs", async () => {
    await seedYear();
    await seedExcluded();
    const report = await getSpendingReport({ db: testDb.db, period: OCTOBER });
    // The same numbers as without the excluded rows.
    expect(report.totalMinor).toBe(11_900);
    expect(report.previousTotalMinor).toBe(10_000);
    expect(report.averageTotalMinor).toBe(Math.round(40_000 / 6));
    expect(report.categories.map((c) => c.param)).not.toContain(excluded);
    expect(report.merchants.map((m) => m.name)).not.toContain("Asunto Myyjä");
    expect(
      report.trend.months.find((m) => m.month === "2026-09")?.values,
    ).toMatchObject({ [cat.groceries]: 6_000, [cat.restaurants]: 4_000 });
    expect(Object.keys(report.trend.months[0].values)).not.toContain(excluded);

    // Excluded is not spending: no drill-down into it.
    const drill = await getSpendingReport({
      db: testDb.db,
      period: OCTOBER,
      category: excluded,
    });
    expect(drill.scope).toEqual({ level: "all" });
    const uncategorized = await getSpendingReport({
      db: testDb.db,
      period: OCTOBER,
      category: UNCATEGORIZED_PARAM,
    });
    expect(
      uncategorized.transactions?.rows.map((row) => row.amountMinor),
    ).toEqual([-1_000]);
  });

  it("counts excluded credits as neither income nor other money in", async () => {
    await seedYear();
    await seedExcluded();
    // Marking a credit as salary is the category picker: a manual
    // Income › Salary pick counts as income.
    await txn("2026-10-21", 50_000, {
      categoryId: cat.salary,
      categorySource: "manual",
      counterparty: "Puoliso",
    });

    for (const asIncome of [true, false]) {
      const report = await getCashFlowReport({
        db: testDb.db,
        now: NOW,
        timeZone: TIME_ZONE,
        uncategorizedCreditsAsIncome: asIncome,
      });
      // seedYear's October: salary 300 000, the uncategorised +500.
      expect(report.months.at(-1)).toMatchObject({
        month: "2026-10",
        incomeMinor: 350_000 + (asIncome ? 500 : 0),
        expensesMinor: 11_900,
        otherInMinor: asIncome ? 0 : 500,
      });
      expect(report.months.at(-2)).toMatchObject({
        month: "2026-09",
        expensesMinor: 10_000,
      });
      expect(report.months.find((m) => m.month === "2026-06")).toMatchObject({
        incomeMinor: 280_000,
        otherInMinor: 0,
      });
      const income = 350_000 + 300_000 + 5 * 280_000 + (asIncome ? 500 : 0);
      expect(report.yearToDate).toMatchObject({
        incomeMinor: income,
        expensesMinor: 11_900 + 10_000 + 5 * 6_000 + 12_000,
        otherInMinor: asIncome ? 0 : 500,
      });
    }
    expect(
      await getMonthCashFlow({
        db: testDb.db,
        now: NOW,
        timeZone: TIME_ZONE,
        uncategorizedCreditsAsIncome: true,
      }),
    ).toMatchObject({ incomeMinor: 350_500, expensesMinor: 11_900 });
  });
});
