import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  categorizeTransactions,
  reapplyRules,
} from "@/server/categorization/categorize";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_RULES,
} from "@/server/categorization/defaults";
import { categoryIdByPath, seedDefaults } from "@/server/categorization/seed";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { readBankCsv } from "@/server/csv/bank-csv";
import { createManualAccount, importCsvRows } from "@/server/csv/import-csv";
import {
  accounts,
  categories,
  categoryRules,
  connections,
  institutions,
  transactions,
} from "@/server/db/schema";
import { createFakeProvider, FAKE_SESSION_REFS } from "@/server/providers/fake";
import { createProviderRegistry } from "@/server/providers/registry";
import { syncBalances } from "@/server/sync/sync-balances";
import {
  syncTransactions,
  type SyncTransactionsOptions,
} from "@/server/sync/sync-transactions";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// The rule engine and transfer detection against a real Postgres 18: the
// seeds, the default `categorize` hook of the bank sync (fake provider) and
// of the CSV import, and re-applying the rules. One database for the file,
// seeded once; every test uses its own connection or manual accounts.

const KEY = randomBytes(32);
const TIME_ZONE = "Europe/Helsinki";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

async function categoryId(path: string): Promise<string> {
  const id = await categoryIdByPath(testDb.db, path);
  expect(id, path).not.toBeNull();
  return id!;
}

function syncOptions(now: Date): SyncTransactionsOptions {
  return {
    db: testDb.db,
    providers: createProviderRegistry([createFakeProvider({ now: () => now })]),
    decrypt: (value) => decryptSecret(value, KEY),
    now: () => now,
    timeZone: TIME_ZONE,
  };
}

/** A fake bank connection with its accounts, transactions not synced yet. */
async function fakeConnection(now: Date) {
  const [institution] = await testDb.db
    .insert(institutions)
    .values({
      name: "Fake Bank",
      country: "FI",
      provider: "fake",
      providerRef: `fake-${randomUUID()}`,
    })
    .returning();
  const [connection] = await testDb.db
    .insert(connections)
    .values({
      institutionId: institution.id,
      provider: "fake",
      sessionRef: encryptSecret(FAKE_SESSION_REFS.valid, KEY),
    })
    .returning();
  expect((await syncBalances(connection.id, syncOptions(now))).status).toBe(
    "succeeded",
  );
  const rows = await testDb.db
    .select()
    .from(accounts)
    .where(eq(accounts.connectionId, connection.id));
  const byRef = (ref: string) =>
    rows.find((a) => a.providerAccountRef === ref)!;
  return {
    connection,
    checking: byRef("fake-checking"),
    savings: byRef("fake-savings"),
  };
}

async function transactionsOf(accountId: string) {
  return testDb.db
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .orderBy(asc(transactions.bookingDate), asc(transactions.id));
}

async function newManualAccount(name: string) {
  return createManualAccount(
    { name: `${name} ${randomUUID()}`, type: "checking", format: "nordea" },
    { db: testDb.db },
  );
}

/** A Nordea-layout export (UTF-8, `;`) of the given rows. */
function nordeaCsv(
  rows: readonly [
    date: string,
    amount: string,
    payee: string,
    message: string,
  ][],
): Uint8Array {
  const lines = [
    "Kirjauspäivä;Arvopäivä;Määrä;Saaja/Maksaja;Viesti",
    ...rows.map(([date, amount, payee, message]) =>
      [date, date, amount, payee, message].join(";"),
    ),
  ];
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

async function importRows(
  accountId: string,
  rows: Parameters<typeof nordeaCsv>[0],
) {
  return importCsvRows(accountId, readBankCsv(nordeaCsv(rows)), {
    db: testDb.db,
  });
}

describe("seeds", () => {
  it("load the two-level default categories and rules once", async () => {
    const first = await seedDefaults(testDb.db);
    const expectedCategories = DEFAULT_CATEGORIES.reduce(
      (sum, category) => sum + 1 + category.children.length,
      0,
    );
    expect(first).toEqual({
      seeded: true,
      categories: expectedCategories,
      rules: DEFAULT_RULES.length,
    });
    // A second run (every `pnpm db:migrate`) adds nothing.
    expect(await seedDefaults(testDb.db)).toEqual({
      seeded: false,
      categories: 0,
      rules: 0,
    });
    expect(await testDb.db.$count(categories)).toBe(expectedCategories);
    expect(await testDb.db.$count(categoryRules)).toBe(DEFAULT_RULES.length);

    const topLevel = await testDb.db
      .select({ name: categories.name, kind: categories.kind })
      .from(categories)
      .where(isNull(categories.parentId));
    expect(topLevel.map((c) => c.name).sort()).toEqual(
      DEFAULT_CATEGORIES.map((c) => c.name).sort(),
    );
    expect(topLevel.find((c) => c.name === "Transfers")?.kind).toBe("transfer");
    expect(topLevel.find((c) => c.name === "Income")?.kind).toBe("income");

    const supermarkets = await categoryId("Groceries/Supermarkets");
    const smarket = await testDb.db
      .select()
      .from(categoryRules)
      .where(
        and(
          eq(categoryRules.pattern, "S-Market"),
          eq(categoryRules.categoryId, supermarkets),
        ),
      );
    expect(smarket).toHaveLength(1);
    expect(smarket[0]).toMatchObject({
      matchField: "counterparty",
      matchType: "contains",
      amountSign: null,
    });
    const priorities = (
      await testDb.db
        .select({ priority: categoryRules.priority })
        .from(categoryRules)
    ).map((r) => r.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });
});

describe("the sync hook", () => {
  it("categorises new transactions and links own transfers", async () => {
    const now = new Date("2026-03-10T09:00:00Z");
    const { connection, checking, savings } = await fakeConnection(now);
    // The fake's merchants are not Finnish: one rule of our own.
    const supermarkets = await categoryId("Groceries/Supermarkets");
    await testDb.db.insert(categoryRules).values({
      categoryId: supermarkets,
      matchField: "counterparty",
      matchType: "equals",
      pattern: "example grocery",
      priority: 1,
    });

    // No `categorize` option: the rule engine is the default.
    const result = await syncTransactions(connection.id, syncOptions(now));
    expect(result.status).toBe("succeeded");

    const rent = await categoryId("Housing/Rent & maintenance");
    const salary = await categoryId("Income/Salary");
    const transfers = await categoryId("Transfers");
    const stored = await transactionsOf(checking.id);
    const ofCounterparty = (name: string) =>
      stored.filter((row) => row.counterparty === name);

    expect(ofCounterparty("Example Housing").length).toBeGreaterThan(12);
    for (const row of ofCounterparty("Example Housing")) {
      expect(row).toMatchObject({ categoryId: rent, categorySource: "rule" });
    }
    for (const row of ofCounterparty("Example Employer")) {
      expect(row).toMatchObject({ categoryId: salary, categorySource: "rule" });
    }
    expect(ofCounterparty("Example Grocery").length).toBeGreaterThan(0);
    for (const row of ofCounterparty("Example Grocery")) {
      expect(row).toMatchObject({
        categoryId: supermarkets,
        categorySource: "rule",
      });
    }
    // Pending ones get their rule category too.
    const pending = stored.filter((row) => row.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    for (const row of ofCounterparty("Example Bookshop")) {
      expect(row).toMatchObject({ categoryId: null, categorySource: "none" });
    }

    // The monthly savings transfer: checking −200 € and savings +200 € on
    // the 16th, one group per month, Transfers.
    const outs = ofCounterparty("Fake Savings");
    const ins = await transactionsOf(savings.id);
    expect(outs).toHaveLength(14); // 2025-01 … 2026-02
    expect(ins).toHaveLength(14);
    for (const out of outs) {
      const partner = ins.find((row) => row.bookingDate === out.bookingDate)!;
      expect(out.transferGroupId).not.toBeNull();
      expect(partner.transferGroupId).toBe(out.transferGroupId);
      for (const leg of [out, partner]) {
        expect(leg).toMatchObject({
          categoryId: transfers,
          categorySource: "rule",
        });
      }
    }
    expect(new Set(outs.map((row) => row.transferGroupId)).size).toBe(
      outs.length,
    );
    // Nothing else is a transfer.
    expect(stored.filter((row) => row.transferGroupId !== null)).toHaveLength(
      outs.length,
    );
  });

  it("links a transfer once both legs are booked", async () => {
    const day16 = new Date("2026-03-16T09:00:00Z");
    const { connection, checking, savings } = await fakeConnection(day16);
    await syncTransactions(connection.id, syncOptions(day16));
    const legsOn16 = async () => {
      const out = (await transactionsOf(checking.id)).find(
        (row) =>
          row.bookingDate === "2026-03-16" &&
          row.counterparty === "Fake Savings",
      )!;
      const back = (await transactionsOf(savings.id)).find(
        (row) => row.bookingDate === "2026-03-16",
      )!;
      return [out, back] as const;
    };

    const [pendingOut, pendingIn] = await legsOn16();
    expect(pendingOut.status).toBe("pending");
    expect(pendingIn.status).toBe("pending");
    expect(pendingOut.transferGroupId).toBeNull();
    expect(pendingIn.transferGroupId).toBeNull();

    // The next day both are booked in place and passed to the hook again.
    const day17 = new Date("2026-03-17T09:00:00Z");
    const next = await syncTransactions(connection.id, syncOptions(day17));
    expect(next.counts.updated).toBeGreaterThan(0);
    const [out, back] = await legsOn16();
    expect(out).toMatchObject({ id: pendingOut.id, status: "booked" });
    expect(back).toMatchObject({ id: pendingIn.id, status: "booked" });
    expect(out.transferGroupId).not.toBeNull();
    expect(back.transferGroupId).toBe(out.transferGroupId);
    expect(out.categoryId).toBe(await categoryId("Transfers"));
  });
});

describe("the import hook", () => {
  it("categorises imported rows with the seeded Finnish merchant rules", async () => {
    const accountId = await newManualAccount("Nordea");
    const summary = await importRows(accountId, [
      ["02.03.2026", "-23,45", "S-MARKET KAMPPI", "Korttiosto"],
      ["03.03.2026", "-3,20", "HSL Mobiili", "Korttiosto"],
      ["04.03.2026", "-18,90", "WOLT", "Korttiosto"],
      ["05.03.2026", "2500,00", "Esimerkki Oy", "Palkka maaliskuu"],
      ["06.03.2026", "-12,00", "Tuntematon Kauppa", "Korttiosto"],
    ]);
    expect(summary.inserted).toBe(5);
    const rows = await transactionsOf(accountId);
    expect(rows.map((row) => [row.counterparty, row.categoryId])).toEqual([
      ["S-MARKET KAMPPI", await categoryId("Groceries/Supermarkets")],
      ["HSL Mobiili", await categoryId("Transport/Public transport")],
      ["WOLT", await categoryId("Restaurants & cafés/Food delivery")],
      ["Esimerkki Oy", await categoryId("Income/Salary")],
      ["Tuntematon Kauppa", null],
    ]);
    expect(rows.map((row) => row.categorySource)).toEqual([
      "rule",
      "rule",
      "rule",
      "rule",
      "none",
    ]);
  });

  it("links a cross-bank transfer between two imported accounts, not equal purchases", async () => {
    const nordea = await newManualAccount("Nordea");
    const spankki = await newManualAccount("S-Pankki");
    await importRows(nordea, [
      ["09.03.2026", "-500,00", "Oma siirto", "Siirto S-Pankkiin"],
      ["09.03.2026", "-177,70", "K-Market Kallio", "Korttiosto"],
    ]);
    await importRows(spankki, [
      // Two days later at the other bank.
      ["11.03.2026", "500,00", "Testi Henkilö", "Siirto Nordeasta"],
      // Same amount as the purchase, but a rule made the purchase Groceries.
      ["09.03.2026", "177,70", "Kaveri", "Lounas"],
      // Same amount, too late.
      ["13.03.2026", "500,00", "Testi Henkilö", "Toinen siirto"],
    ]);

    const out = await transactionsOf(nordea);
    const back = await transactionsOf(spankki);
    const transfer = out.find((row) => row.amountMinor === -50_000)!;
    const partner = back.find((row) => row.bookingDate === "2026-03-11")!;
    expect(transfer.transferGroupId).not.toBeNull();
    expect(partner.transferGroupId).toBe(transfer.transferGroupId);
    expect(partner.categoryId).toBe(await categoryId("Transfers"));
    for (const row of [
      ...out.filter((r) => r.id !== transfer.id),
      ...back.filter((r) => r.id !== partner.id),
    ]) {
      expect(row.transferGroupId, row.description!).toBeNull();
    }
    expect(out.find((r) => r.amountMinor === -17_770)?.categoryId).toBe(
      await categoryId("Groceries/Supermarkets"),
    );
  });

  it("marks a payment to an own IBAN as a transfer, joined later by its other leg", async () => {
    const savingsId = await newManualAccount("Savings");
    const iban = `FI${String(randomBytes(4).readUInt32BE()).padStart(16, "0")}`;
    await testDb.db
      .update(accounts)
      .set({ iban: `${iban.slice(0, 4)} ${iban.slice(4)}` })
      .where(eq(accounts.id, savingsId));
    const checkingId = await newManualAccount("Checking");

    await importRows(checkingId, [
      ["10.03.2026", "-123,00", "Nordnet Bank", `Tilisiirto ${iban}`],
    ]);
    const [out] = await transactionsOf(checkingId);
    // The IBAN makes it a transfer even before the other leg exists.
    expect(out).toMatchObject({
      categoryId: await categoryId("Transfers"),
      categorySource: "rule",
    });
    expect(out.transferGroupId).not.toBeNull();

    await importRows(savingsId, [
      ["12.03.2026", "123,00", "Testi Henkilö", "Tilisiirto"],
    ]);
    const [back] = await transactionsOf(savingsId);
    expect(back.transferGroupId).toBe(out.transferGroupId);
    expect(back.categoryId).toBe(await categoryId("Transfers"));
  });
});

describe("manual categories", () => {
  it("are never overwritten: not by the hook, not by re-apply, not by transfers", async () => {
    const accountId = await newManualAccount("Manual");
    const otherId = await newManualAccount("Other");
    const entertainment = await categoryId("Entertainment");
    await importRows(accountId, [
      ["02.03.2026", "-40,00", "Prisma Itis", "Korttiosto"],
      ["03.03.2026", "-160,00", "Tuntematon", "Korttiosto"],
    ]);
    const [prisma, unknown] = await transactionsOf(accountId);
    await testDb.db
      .update(transactions)
      .set({ categoryId: entertainment, categorySource: "manual" })
      .where(inArray(transactions.id, [prisma.id, unknown.id]));

    // The hook on the same ids (as a sync update would) changes nothing.
    await testDb.db.transaction((tx) =>
      categorizeTransactions(tx, [prisma.id, unknown.id]),
    );
    // An equal credit on another own account does not make it a transfer.
    await importRows(otherId, [
      ["03.03.2026", "160,00", "Tuntematon", "Paluu"],
    ]);
    await reapplyRules({ db: testDb.db });

    for (const row of await transactionsOf(accountId)) {
      expect(row).toMatchObject({
        categoryId: entertainment,
        categorySource: "manual",
        transferGroupId: null,
      });
    }
    const [credit] = await transactionsOf(otherId);
    expect(credit.transferGroupId).toBeNull();
  });
});

describe("re-apply rules", () => {
  it("recategorises every non-manual transaction and keeps manual ones and transfers", async () => {
    const accountId = await newManualAccount("Reapply");
    const savingsId = await newManualAccount("Reapply savings");
    await importRows(accountId, [
      ["02.03.2026", "-10,00", "Kirjakauppa Esimerkki", "Korttiosto"],
      ["03.03.2026", "-11,00", "Kirjakauppa Esimerkki", "Korttiosto"],
      ["04.03.2026", "-12,00", "Lidl Kamppi", "Korttiosto"],
      ["05.03.2026", "-250,00", "Oma tili", "Säästö"],
    ]);
    await importRows(savingsId, [
      ["05.03.2026", "250,00", "Oma tili", "Säästö"],
    ]);
    const before = await transactionsOf(accountId);
    const [book1, book2, lidl, saving] = before;
    expect(book1.categorySource).toBe("none");
    expect(saving.transferGroupId).not.toBeNull();
    const shopping = await categoryId("Shopping");
    const health = await categoryId("Health");
    await testDb.db
      .update(transactions)
      .set({ categoryId: health, categorySource: "manual" })
      .where(eq(transactions.id, book2.id));

    // A new rule for books, and Lidl's rule now points elsewhere.
    await testDb.db.insert(categoryRules).values({
      categoryId: shopping,
      matchField: "counterparty",
      matchType: "regex",
      pattern: "^kirjakauppa",
      priority: 5,
    });
    const entertainment = await categoryId("Entertainment");
    await testDb.db
      .update(categoryRules)
      .set({ categoryId: entertainment })
      .where(eq(categoryRules.pattern, "Lidl"));

    const summary = await reapplyRules({ db: testDb.db });
    expect(summary.recategorized).toBeGreaterThanOrEqual(2);

    const after = new Map(
      (await transactionsOf(accountId)).map((row) => [row.id, row]),
    );
    expect(after.get(book1.id)).toMatchObject({
      categoryId: shopping,
      categorySource: "rule",
    });
    expect(after.get(book2.id)).toMatchObject({
      categoryId: health,
      categorySource: "manual",
    });
    expect(after.get(lidl.id)).toMatchObject({
      categoryId: entertainment,
      categorySource: "rule",
    });
    expect(after.get(saving.id)).toMatchObject({
      transferGroupId: saving.transferGroupId,
      categoryId: await categoryId("Transfers"),
    });

    // Without the rule the books fall back to no category.
    await testDb.db
      .delete(categoryRules)
      .where(eq(categoryRules.pattern, "^kirjakauppa"));
    await reapplyRules({ db: testDb.db });
    const [again] = await transactionsOf(accountId);
    expect(again).toMatchObject({ categoryId: null, categorySource: "none" });

    // Re-applying twice in a row changes nothing more.
    expect(await reapplyRules({ db: testDb.db })).toEqual({
      recategorized: 0,
      transfers: 0,
    });
  });
});
