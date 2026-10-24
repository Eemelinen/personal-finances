import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedDefaults } from "@/server/categorization/seed";
import { AccountInputError } from "@/server/connections/account-input";
import {
  addManualAccount,
  archiveManualAccount,
  listManualAccounts,
  updateManualAccount,
} from "@/server/connections/manual-accounts";
import { createManualAccount } from "@/server/csv/import-csv";
import {
  accounts,
  balanceSnapshots,
  categories,
  connections,
  institutions,
  transactions,
} from "@/server/db/schema";
import { getDashboardOverview } from "@/server/queries/dashboard";
import { getCashFlowReport } from "@/server/queries/reports";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// Own accounts outside the bank connections (F-029) against a real Postgres
// 18: adding one with an IBAN turns a stored leg that names it into a
// one-sided own transfer, which the cash-flow report leaves out; its
// balance counts in net worth; an IBAN belongs to one account.

const TIME_ZONE = "Europe/Helsinki";
const NOW = new Date("2026-10-24T09:00:00Z");

/** Synthetic IBANs with valid check digits. */
const SAVINGS_IBAN = "FI2112345600000785";
const CHECKING_IBAN = "FI5810171000000122";
const OTHER_IBAN = "DE89370400440532013000";

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
    sql`TRUNCATE ${institutions}, ${connections}, ${accounts}, ${transactions}, ${categories} CASCADE`,
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
      name: "Käyttötili",
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
      counterparty: "Own savings",
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

describe("addManualAccount", () => {
  it("turns legs naming its IBAN into one-sided transfers the cash flow leaves out", async () => {
    const out = await leg(-50_000, { counterpartyIban: SAVINGS_IBAN });
    const back = await leg(20_000, {
      counterparty: null,
      description: `Siirto tililtä FI21 1234 5600 0007 85`,
    });
    const groceries = await leg(-3_000, { counterparty: "K-Market" });
    expect(await octoberFlow()).toMatchObject({
      incomeMinor: 20_000,
      expensesMinor: 53_000,
    });

    const saved = await addManualAccount(
      {
        institution: "Other bank",
        name: "Säästötili",
        iban: SAVINGS_IBAN,
        type: "savings",
        balance: null,
      },
      { db: testDb.db },
    );
    expect(saved.linked).toBe(2);

    const [outRow, backRow, groceriesRow] = await Promise.all(
      [out, back, groceries].map(stored),
    );
    expect(outRow.transferGroupId).not.toBeNull();
    expect(backRow.transferGroupId).not.toBeNull();
    expect(outRow.transferGroupId).not.toBe(backRow.transferGroupId);
    expect(groceriesRow.transferGroupId).toBeNull();
    expect(await octoberFlow()).toMatchObject({
      incomeMinor: 0,
      expensesMinor: 3_000,
    });

    const [account] = await testDb.db
      .select({
        iban: accounts.iban,
        connectionId: accounts.connectionId,
        provider: institutions.provider,
        institution: institutions.name,
      })
      .from(accounts)
      .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
      .where(eq(accounts.id, saved.accountId));
    expect(account).toEqual({
      iban: SAVINGS_IBAN,
      connectionId: null,
      provider: "manual",
      institution: "Other bank",
    });
  });

  it("counts the balance on a date in net worth and lists it", async () => {
    await testDb.db.insert(balanceSnapshots).values({
      accountId: checking,
      date: "2026-10-24",
      amountMinor: 100_000,
      currency: "EUR",
      balanceType: "ITBD",
    });
    const before = await getDashboardOverview({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
    });
    expect(before.totals.netWorth.amountMinor).toBe(100_000);

    const { accountId } = await addManualAccount(
      {
        institution: "Other bank",
        name: "Säästötili",
        iban: SAVINGS_IBAN,
        type: "savings",
        // Older than the dashboard's window: carried forward to today.
        balance: { amountMinor: 1_234_56, date: "2026-06-30" },
      },
      { db: testDb.db },
    );
    const after = await getDashboardOverview({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
    });
    expect(after.totals.netWorth.amountMinor).toBe(100_000 + 1_234_56);
    expect(after.totals.savings.amountMinor).toBe(1_234_56);
    const summary = after.banks
      .flatMap((bank) => bank.accounts)
      .find((account) => account.id === accountId);
    expect(summary).toMatchObject({
      manual: true,
      balance: { amountMinor: 1_234_56, balanceType: "manual" },
    });

    const listed = await listManualAccounts({ db: testDb.db });
    expect(listed).toEqual([
      {
        id: accountId,
        name: "Säästötili",
        institution: "Other bank",
        iban: SAVINGS_IBAN,
        type: "savings",
        currency: "EUR",
        balance: { amountMinor: 1_234_56, date: "2026-06-30" },
      },
    ]);

    // A newer balance replaces it from its day on; the same day again
    // replaces that day's.
    await updateManualAccount(
      accountId,
      {
        name: "Säästötili",
        iban: SAVINGS_IBAN,
        type: "savings",
        balance: { amountMinor: 2_000_00, date: "2026-10-01" },
      },
      { db: testDb.db },
    );
    await updateManualAccount(
      accountId,
      {
        name: "Säästötili",
        iban: SAVINGS_IBAN,
        type: "savings",
        balance: { amountMinor: 2_500_00, date: "2026-10-01" },
      },
      { db: testDb.db },
    );
    const updated = await getDashboardOverview({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
    });
    expect(updated.totals.netWorth.amountMinor).toBe(100_000 + 2_500_00);
    expect(
      await testDb.db
        .select({ date: balanceSnapshots.date })
        .from(balanceSnapshots)
        .where(eq(balanceSnapshots.accountId, accountId)),
    ).toHaveLength(2);

    await archiveManualAccount(accountId, { db: testDb.db });
    const archived = await getDashboardOverview({
      db: testDb.db,
      now: NOW,
      timeZone: TIME_ZONE,
    });
    expect(archived.totals.netWorth.amountMinor).toBe(100_000);
    expect(await listManualAccounts({ db: testDb.db })).toEqual([]);
  });

  it("refuses an IBAN another account already has", async () => {
    // The connected account's IBAN is stored with spaces.
    await expect(
      addManualAccount(
        {
          institution: "Nordea",
          name: "Copy",
          iban: CHECKING_IBAN,
          type: "checking",
          balance: null,
        },
        { db: testDb.db },
      ),
    ).rejects.toThrow(AccountInputError);

    const first = await addManualAccount(
      {
        institution: "Other bank",
        name: "Säästötili",
        iban: SAVINGS_IBAN,
        type: "savings",
        balance: null,
      },
      { db: testDb.db },
    );
    await expect(
      addManualAccount(
        {
          institution: "Third bank",
          name: "Again",
          iban: SAVINGS_IBAN,
          type: "savings",
          balance: null,
        },
        { db: testDb.db },
      ),
    ).rejects.toThrow(/already used by the account “Säästötili”/);

    const second = await addManualAccount(
      {
        institution: "Other bank",
        name: "Toinen",
        iban: OTHER_IBAN,
        type: "savings",
        balance: null,
      },
      { db: testDb.db },
    );
    await expect(
      updateManualAccount(
        second.accountId,
        { name: "Toinen", iban: SAVINGS_IBAN, type: "savings", balance: null },
        { db: testDb.db },
      ),
    ).rejects.toThrow(AccountInputError);
    // Saving an account with its own IBAN is fine.
    await updateManualAccount(
      first.accountId,
      { name: "Renamed", iban: SAVINGS_IBAN, type: "checking", balance: null },
      { db: testDb.db },
    );

    const manual = await testDb.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.iban, SAVINGS_IBAN));
    expect(manual).toEqual([{ id: first.accountId }]);
    // Both banks typed by hand share one institution row per name.
    const banks = await testDb.db
      .select({ name: institutions.name })
      .from(institutions)
      .where(eq(institutions.provider, "manual"));
    expect(banks).toEqual([{ name: "Other bank" }]);
  });
});

describe("updateManualAccount", () => {
  it("gives a CSV import's account an IBAN and links its transfers", async () => {
    const imported = await createManualAccount(
      { name: "Imported savings", type: "savings", format: "nordea" },
      { db: testDb.db },
    );
    const out = await leg(-10_000, { counterpartyIban: SAVINGS_IBAN });

    const saved = await updateManualAccount(
      imported,
      {
        name: "Imported savings",
        iban: SAVINGS_IBAN,
        type: "savings",
        balance: null,
      },
      { db: testDb.db },
    );
    expect(saved.linked).toBe(1);
    expect((await stored(out)).transferGroupId).not.toBeNull();
    expect(
      (await listManualAccounts({ db: testDb.db })).map((row) => row.iban),
    ).toEqual([SAVINGS_IBAN]);
  });

  it("refuses connected accounts", async () => {
    await expect(
      updateManualAccount(
        checking,
        {
          name: "Käyttötili",
          iban: CHECKING_IBAN,
          type: "checking",
          balance: null,
        },
        { db: testDb.db },
      ),
    ).rejects.toThrow(/no longer exists/);
    await expect(
      archiveManualAccount(checking, { db: testDb.db }),
    ).rejects.toThrow(/no longer exists/);
  });
});
