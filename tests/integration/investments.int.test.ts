import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  categorizeTransactions,
  reapplyRules,
} from "@/server/categorization/categorize";
import { categoryIdByPath, seedDefaults } from "@/server/categorization/seed";
import {
  accounts,
  appSettings,
  categories,
  categoryRules,
  institutions,
  transactions,
} from "@/server/db/schema";
import { getCashFlowReport } from "@/server/queries/reports";
import { listTransactions } from "@/server/queries/transactions";
import { EMPTY_FILTER } from "@/server/queries/transaction-filter";
import { setAppSetting } from "@/server/settings";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// Investments left out of spending (F-037) against a real Postgres 18:
// with the setting off a fund subscription and a crypto exchange deposit
// count as spending; on, recognised investments that no rule matches go
// into Savings & investments › Investments and leave the cash flow in both
// directions, user rules and manual categories win, and turning it off
// again restores them. Fund and shop names are synthetic.

const TIME_ZONE = "Europe/Helsinki";
const NOW = new Date("2026-10-24T09:00:00Z");

let testDb: TestDatabase;
let checking: string;
let investmentsId: string;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.db.execute(
    sql`TRUNCATE ${institutions}, ${accounts}, ${transactions}, ${categories}, ${appSettings} CASCADE`,
  );
  await seedDefaults(testDb.db);
  investmentsId = (await categoryIdByPath(
    testDb.db,
    "Savings & investments/Investments",
  ))!;
  const [bank] = await testDb.db
    .insert(institutions)
    .values({
      name: "Test Bank",
      country: "FI",
      provider: "csv",
      providerRef: "test-bank",
    })
    .returning();
  const [account] = await testDb.db
    .insert(accounts)
    .values({
      institutionId: bank.id,
      name: "Checking",
      type: "checking",
      currency: "EUR",
    })
    .returning();
  checking = account.id;
});

let sequence = 0;

async function row(
  amountMinor: number,
  values: Partial<typeof transactions.$inferInsert> = {},
) {
  sequence += 1;
  const [inserted] = await testDb.db
    .insert(transactions)
    .values({
      accountId: checking,
      dedupeHash: `hash-${sequence}`,
      bookingDate: "2026-10-05",
      amountMinor,
      currency: "EUR",
      ...values,
    })
    .returning();
  return inserted.id;
}

async function stored(id: string) {
  const [found] = await testDb.db
    .select()
    .from(transactions)
    .where(eq(transactions.id, id));
  return found;
}

function octoberFlow() {
  return getCashFlowReport({
    db: testDb.db,
    now: NOW,
    timeZone: TIME_ZONE,
    months: 1,
    uncategorizedCreditsAsIncome: true,
  }).then((report) => report.months[0]);
}

async function setInvestments(on: boolean) {
  await setAppSetting("excludeInvestments", on, testDb.db);
  return reapplyRules({ db: testDb.db });
}

/** A fund subscription, an exchange deposit and withdrawal, and a shop. */
async function seedRows() {
  return {
    fund: await row(-50_000, {
      counterparty: "Synthetic Index Fund A",
      description: "MERKINTÄ 2026-10-05",
    }),
    deposit: await row(-100_000, { counterparty: "Payward Ltd" }),
    withdrawal: await row(30_000, {
      counterparty: "Payward Europe Solutions",
    }),
    shop: await row(-2_500, { counterparty: "Example Shop Oy" }),
  };
}

describe("excludeInvestments", () => {
  it("counts investments as spending and income while it is off", async () => {
    const ids = await seedRows();
    expect((await reapplyRules({ db: testDb.db })).recategorized).toBe(0);
    for (const id of Object.values(ids)) {
      expect((await stored(id)).categoryId).toBeNull();
    }
    expect(await octoberFlow()).toMatchObject({
      expensesMinor: 152_500,
      incomeMinor: 30_000,
    });
  });

  it("puts them into Investments, out of the cash flow both ways, while it is on", async () => {
    const ids = await seedRows();
    const summary = await setInvestments(true);
    expect(summary.recategorized).toBe(3);
    for (const id of [ids.fund, ids.deposit, ids.withdrawal]) {
      expect(await stored(id)).toMatchObject({
        categoryId: investmentsId,
        categorySource: "rule",
        transferGroupId: null,
      });
    }
    expect((await stored(ids.shop)).categoryId).toBeNull();
    expect(await octoberFlow()).toMatchObject({
      expensesMinor: 2_500,
      incomeMinor: 0,
    });
  });

  it("lets a user rule and a manual category win", async () => {
    const eatingOut = (await categoryIdByPath(
      testDb.db,
      "Restaurants & cafés/Restaurants",
    ))!;
    await testDb.db.insert(categoryRules).values({
      categoryId: eatingOut,
      matchField: "counterparty",
      matchType: "contains",
      pattern: "Kraken Grill",
      priority: 1,
    });
    const grill = await row(-3_000, { counterparty: "Kraken Grill" });
    const manual = await row(-40_000, {
      counterparty: "Coinbase Europe",
      categoryId: eatingOut,
      categorySource: "manual",
    });
    await setInvestments(true);
    expect(await stored(grill)).toMatchObject({
      categoryId: eatingOut,
      categorySource: "rule",
    });
    expect(await stored(manual)).toMatchObject({
      categoryId: eatingOut,
      categorySource: "manual",
    });
  });

  it("restores the rule outcome when it is turned off again", async () => {
    const ids = await seedRows();
    // Nordnet keeps its seeded rule into Investments either way.
    const nordnet = await row(-20_000, { counterparty: "Nordnet Bank AB" });
    await setInvestments(true);
    const summary = await setInvestments(false);
    expect(summary.recategorized).toBe(3);
    for (const id of Object.values(ids)) {
      expect(await stored(id)).toMatchObject({
        categoryId: null,
        categorySource: "none",
      });
    }
    expect((await stored(nordnet)).categoryId).toBe(investmentsId);
    expect(await octoberFlow()).toMatchObject({
      expensesMinor: 152_500,
      incomeMinor: 30_000,
    });
  });

  it("categorises new rows in the sync and import hook", async () => {
    await setAppSetting("excludeInvestments", true, testDb.db);
    const id = await row(-10_000, {
      counterparty: "Seligson & Co",
      description: "Rahastomerkintä",
    });
    await testDb.db.transaction((tx) => categorizeTransactions(tx, [id]));
    expect((await stored(id)).categoryId).toBe(investmentsId);
  });

  it("creates Investments when it is missing", async () => {
    await testDb.db
      .delete(categories)
      .where(eq(categories.name, "Savings & investments"));
    const id = await row(-10_000, { counterparty: "Degiro" });
    await setInvestments(true);
    const created = await categoryIdByPath(
      testDb.db,
      "Savings & investments/Investments",
    );
    expect(created).not.toBeNull();
    expect(await stored(id)).toMatchObject({
      categoryId: created,
      categorySource: "rule",
    });
    const [kind] = await testDb.db
      .select({ kind: categories.kind })
      .from(categories)
      .where(eq(categories.id, created!));
    expect(kind.kind).toBe("transfer");
  });

  it("names them as investments in /transactions' Not counted", async () => {
    await seedRows();
    await setInvestments(true);
    const page = await listTransactions(EMPTY_FILTER, 1, { db: testDb.db });
    expect(page.totals).toMatchObject({
      incomeMinor: 0,
      expensesMinor: -2_500,
    });
    expect(page.notCounted).toMatchObject({
      count: 3,
      reasons: [{ reason: "investment", count: 3, filter: null }],
    });
  });
});
