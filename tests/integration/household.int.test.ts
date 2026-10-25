import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  categorizeTransactions,
  transfersCategoryId,
} from "@/server/categorization/categorize";
import {
  addNameVariant,
  getHousehold,
  HouseholdInputError,
  listNameSuggestions,
  saveHousehold,
  setIgnoreHouseholdTransfers,
} from "@/server/categorization/household";
import { seedDefaults } from "@/server/categorization/seed";
import {
  accounts,
  appSettings,
  categories,
  connections,
  institutions,
  transactions,
} from "@/server/db/schema";
import { getCashFlowReport, getSpendingReport } from "@/server/queries/reports";
import { listTransactions } from "@/server/queries/transactions";
import { EMPTY_FILTER } from "@/server/queries/transaction-filter";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// Own names and household members (F-030) against a real Postgres 18: an
// own-name credit becomes a one-sided own transfer; transfers with a
// household member in both directions leave the cash-flow totals only
// while the toggle is on; a joint account's card purchase by the member
// still counts as spending. Names and IBANs are synthetic.

const TIME_ZONE = "Europe/Helsinki";
const NOW = new Date("2026-10-24T09:00:00Z");
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };

/** Synthetic IBANs with valid check digits. */
const SPOUSE_IBAN = "FI4950009420028730";
const STRANGER_IBAN = "DE89370400440532013000";

const OWN = { ownNames: ["Matti Meikäläinen", "M Meikäläinen"] };
const SPOUSE = { names: ["Maija Meikäläinen"], ibans: [SPOUSE_IBAN] };

let testDb: TestDatabase;
let checking: string;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.db.execute(
    sql`TRUNCATE ${institutions}, ${connections}, ${accounts}, ${transactions}, ${categories}, ${appSettings} CASCADE`,
  );
  await seedDefaults(testDb.db);
  const [bank] = await testDb.db
    .insert(institutions)
    .values({
      name: "Nordea",
      country: "FI",
      provider: "enable_banking",
      providerRef: "Nordea",
    })
    .returning();
  const [connection] = await testDb.db
    .insert(connections)
    .values({ institutionId: bank.id, provider: "enable_banking" })
    .returning();
  const [account] = await testDb.db
    .insert(accounts)
    .values({
      connectionId: connection.id,
      institutionId: bank.id,
      name: "Yhteistili",
      type: "checking",
      iban: "FI58 1017 1000 0001 22",
      currency: "EUR",
      providerAccountRef: "checking-1",
    })
    .returning();
  checking = account.id;
});

let sequence = 0;

async function leg(
  amountMinor: number,
  values: Partial<typeof transactions.$inferInsert> = {},
) {
  sequence += 1;
  const [row] = await testDb.db
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
  return row.id;
}

async function stored(id: string) {
  const [row] = await testDb.db
    .select()
    .from(transactions)
    .where(eq(transactions.id, id));
  return row;
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

async function octoberSpending() {
  const report = await getSpendingReport({ db: testDb.db, period: OCTOBER });
  return report.totalMinor;
}

describe("own names", () => {
  it("turns an own-name credit into a one-sided transfer the cash flow leaves out", async () => {
    const deposit = await leg(100_000, { counterparty: "MEIKÄLÄINEN MATTI" });
    const initials = await leg(-20_000, { counterparty: "M. Meikäläinen" });
    const relative = await leg(5_000, { counterparty: "Matti Meikäläinen Oy" });
    const manual = await leg(7_000, {
      counterparty: "Matti Meikäläinen",
      categorySource: "manual",
    });
    expect(await octoberFlow()).toMatchObject({ incomeMinor: 112_000 });

    const summary = await saveHousehold(
      { ...OWN, members: [] },
      { db: testDb.db },
    );
    expect(summary).toEqual({ transfers: 2, household: 0 });

    const transfers = await testDb.db.transaction((tx) =>
      transfersCategoryId(tx),
    );
    for (const id of [deposit, initials]) {
      const row = await stored(id);
      expect(row.categoryId).toBe(transfers);
      expect(row.transferGroupId).not.toBeNull();
    }
    expect((await stored(deposit)).transferGroupId).not.toBe(
      (await stored(initials)).transferGroupId,
    );
    expect((await stored(relative)).transferGroupId).toBeNull();
    expect(await stored(manual)).toMatchObject({
      categorySource: "manual",
      transferGroupId: null,
    });
    expect(await octoberFlow()).toMatchObject({
      incomeMinor: 12_000,
      expensesMinor: 0,
    });
  });

  it("leaves an own name from a household member's account alone", async () => {
    const id = await leg(30_000, {
      counterparty: "Matti Meikäläinen",
      counterpartyIban: SPOUSE_IBAN,
    });
    await saveHousehold({ ...OWN, members: [SPOUSE] }, { db: testDb.db });
    expect(await stored(id)).toMatchObject({
      transferGroupId: null,
      household: true,
    });
  });

  it("links own names in the sync's categorisation hook", async () => {
    await saveHousehold({ ...OWN, members: [] }, { db: testDb.db });
    const id = await leg(40_000, { counterparty: "Meikäläinen Matti" });
    await testDb.db.transaction((tx) => categorizeTransactions(tx, [id]));
    expect((await stored(id)).transferGroupId).not.toBeNull();
  });
});

describe("household members", () => {
  it("leaves transfers with them out of the totals only while the toggle is on", async () => {
    const contribution = await leg(60_000, {
      counterparty: "MEIKÄLÄINEN MAIJA",
    });
    const repayment = await leg(-15_000, {
      counterparty: "Maija M",
      counterpartyIban: SPOUSE_IBAN,
    });
    const cardPurchase = await leg(-4_000, {
      counterparty: "K-Market Kamppi",
      description: "Kortti 1234 Maija Meikäläinen",
    });
    const stranger = await leg(10_000, {
      counterparty: "Maija Virtanen",
      counterpartyIban: STRANGER_IBAN,
    });

    const summary = await saveHousehold(
      { ownNames: [], members: [SPOUSE] },
      { db: testDb.db },
    );
    expect(summary).toEqual({ transfers: 0, household: 2 });
    expect((await stored(contribution)).household).toBe(true);
    expect((await stored(repayment)).household).toBe(true);
    expect((await stored(cardPurchase)).household).toBe(false);
    expect((await stored(stranger)).household).toBe(false);
    // The category is untouched: no rule matched, so still none.
    expect((await stored(contribution)).categoryId).toBeNull();

    // Off (the default): they count.
    expect((await getHousehold(testDb.db)).ignoreHouseholdTransfers).toBe(
      false,
    );
    expect(await octoberFlow()).toMatchObject({
      incomeMinor: 70_000,
      expensesMinor: 19_000,
    });
    expect(await octoberSpending()).toBe(19_000);

    // On: both directions leave; the card purchase still counts.
    await setIgnoreHouseholdTransfers(true, { db: testDb.db });
    expect(await octoberFlow()).toMatchObject({
      incomeMinor: 10_000,
      expensesMinor: 4_000,
    });
    expect(await octoberSpending()).toBe(4_000);

    // The transaction list marks and filters them.
    const page = await listTransactions(
      { ...EMPTY_FILTER, household: "only" },
      1,
      { db: testDb.db },
    );
    expect(page.rows.map((row) => row.id).sort()).toEqual(
      [contribution, repayment].sort(),
    );
    expect(page.rows.every((row) => row.household)).toBe(true);
    const without = await listTransactions(
      { ...EMPTY_FILTER, household: "exclude" },
      1,
      { db: testDb.db },
    );
    expect(without.total).toBe(2);

    // Removing the member clears the marks.
    expect(
      await saveHousehold({ ownNames: [], members: [] }, { db: testDb.db }),
    ).toEqual({ transfers: 0, household: 2 });
    expect((await stored(contribution)).household).toBe(false);
    expect(await octoberFlow()).toMatchObject({ incomeMinor: 70_000 });
  });

  it("finds a member's IBAN written only in the description (F-036)", async () => {
    const nameless = await leg(70_000, {
      description: "FI49 5000 9420 0287 30",
    });
    const ownName = await leg(-20_000, {
      counterparty: "Matti Meikäläinen",
      description: `Siirto ${SPOUSE_IBAN.toLowerCase()}`,
    });
    const strangerAccount = await leg(30_000, {
      counterpartyIban: STRANGER_IBAN,
      description: `Ref ${SPOUSE_IBAN}`,
    });

    expect(
      await saveHousehold(
        { ...OWN, members: [{ names: [], ibans: [SPOUSE_IBAN] }] },
        { db: testDb.db },
      ),
    ).toEqual({ transfers: 0, household: 2 });
    expect((await stored(nameless)).household).toBe(true);
    expect(await stored(ownName)).toMatchObject({
      household: true,
      transferGroupId: null,
    });
    expect((await stored(strangerAccount)).household).toBe(false);

    expect(await octoberFlow()).toMatchObject({
      incomeMinor: 100_000,
      expensesMinor: 20_000,
    });
    await setIgnoreHouseholdTransfers(true, { db: testDb.db });
    expect(await octoberFlow()).toMatchObject({
      incomeMinor: 30_000,
      expensesMinor: 0,
    });
  });

  it("marks a manually categorised transaction and keeps its category", async () => {
    const [housing] = await testDb.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.name, "Housing"));
    const id = await leg(50_000, {
      counterparty: "Maija Meikäläinen",
      categoryId: housing.id,
      categorySource: "manual",
    });
    await saveHousehold({ ownNames: [], members: [SPOUSE] }, { db: testDb.db });
    expect(await stored(id)).toMatchObject({
      household: true,
      categoryId: housing.id,
      categorySource: "manual",
    });
  });
});

describe("name-variant suggestions (F-035)", () => {
  const SAVED = {
    ownNames: ["Matti Mikael Meikäläinen"],
    members: [{ names: ["Liisa Virtanen"], ibans: [SPOUSE_IBAN] }],
  };

  it("lists unclaimed initials and joint-name spellings with their person, count and sums", async () => {
    await saveHousehold(SAVED, { db: testDb.db });
    // Stored after saving, so nothing has claimed them yet.
    const initials = [
      await leg(6_000, { counterparty: "M MEIKÄLÄINEN" }),
      await leg(4_000, { counterparty: "M MEIKÄLÄINEN" }),
      await leg(-2_000, { counterparty: "M. Meikäläinen" }),
    ];
    await leg(5_000, { counterparty: "M.M. Meikäläinen CJ L. Virtanen" });
    await leg(3_000, { counterparty: "L Virtanen" });
    await leg(1_000, { counterparty: "Maarit Meikäläinen" });
    await leg(1_000, { counterparty: "Meikäläinen Oy" });
    // Claimed rows are no suggestions.
    const manual = await leg(9_000, {
      counterparty: "M Meikäläinen",
      categorySource: "manual",
    });
    const grouped = await leg(9_000, {
      counterparty: "M Meikäläinen",
      transferGroupId: randomUUID(),
    });
    const household = await leg(9_000, {
      counterparty: "M Meikäläinen",
      counterpartyIban: SPOUSE_IBAN,
      household: true,
    });

    const member = { kind: "member", index: 0, label: "Liisa Virtanen" };
    expect(await listNameSuggestions(testDb.db)).toEqual([
      {
        counterparty: "M MEIKÄLÄINEN",
        rows: 3,
        creditMinor: 10_000,
        debitMinor: -2_000,
        targets: [{ kind: "own" }],
      },
      {
        counterparty: "M.M. Meikäläinen CJ L. Virtanen",
        rows: 1,
        creditMinor: 5_000,
        debitMinor: 0,
        targets: [member],
      },
      {
        counterparty: "L Virtanen",
        rows: 1,
        creditMinor: 3_000,
        debitMinor: 0,
        targets: [member],
      },
    ]);

    // Adding a suggestion saves the list and links its rows.
    expect(
      await addNameVariant("M MEIKÄLÄINEN", { kind: "own" }, { db: testDb.db }),
    ).toEqual({ transfers: 3, household: 0 });
    expect((await getHousehold(testDb.db)).ownNames).toEqual([
      "Matti Mikael Meikäläinen",
      "M MEIKÄLÄINEN",
    ]);
    for (const id of initials) {
      expect((await stored(id)).transferGroupId).not.toBeNull();
    }
    expect((await stored(manual)).transferGroupId).toBeNull();
    expect((await stored(household)).transferGroupId).toBeNull();
    expect((await stored(grouped)).household).toBe(false);
    expect(
      (await listNameSuggestions(testDb.db)).map((s) => s.counterparty),
    ).toEqual(["M.M. Meikäläinen CJ L. Virtanen", "L Virtanen"]);

    await addNameVariant(
      "L Virtanen",
      { kind: "member", index: 0 },
      { db: testDb.db },
    );
    expect((await getHousehold(testDb.db)).members[0].names).toEqual([
      "Liisa Virtanen",
      "L Virtanen",
    ]);
  });

  it("refuses a variant the form would refuse and a member that is gone", async () => {
    await saveHousehold(SAVED, { db: testDb.db });
    await expect(
      addNameVariant(
        "Matti Mikael Meikäläinen",
        { kind: "member", index: 0 },
        { db: testDb.db },
      ),
    ).rejects.toBeInstanceOf(HouseholdInputError);
    await expect(
      addNameVariant(
        "L Virtanen",
        { kind: "member", index: 3 },
        { db: testDb.db },
      ),
    ).rejects.toBeInstanceOf(HouseholdInputError);
  });

  it("suggests nothing without saved names", async () => {
    await leg(6_000, { counterparty: "M Meikäläinen" });
    expect(await listNameSuggestions(testDb.db)).toEqual([]);
  });
});
