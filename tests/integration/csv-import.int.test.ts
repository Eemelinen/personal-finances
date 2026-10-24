import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readBankCsv } from "@/server/csv/bank-csv";
import {
  createManualAccount,
  ImportAccountError,
  importCsvIntoNewAccount,
  importCsvRows,
  listImportAccounts,
} from "@/server/csv/import-csv";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import {
  accounts,
  connections,
  institutions,
  transactions,
} from "@/server/db/schema";
import { createFakeProvider, FAKE_SESSION_REFS } from "@/server/providers/fake";
import { fetchAllTransactions } from "@/server/providers/paging";
import { createProviderRegistry } from "@/server/providers/registry";
import type { ProviderTransaction } from "@/server/providers/types";
import { syncBalances } from "@/server/sync/sync-balances";
import {
  syncTransactions,
  type SyncTransactionsOptions,
} from "@/server/sync/sync-transactions";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// importCsvRows() against a real Postgres 18: the synthetic fixtures, files
// that overlap each other and files that overlap what the bank sync (the
// fake provider) stored, in both orders. Nothing may be stored twice.

const KEY = randomBytes(32);
const NOW = new Date("2026-03-10T09:00:00Z");

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

function fixture(name: string): Uint8Array {
  return readFileSync(path.join("tests/fixtures/csv", name));
}

function finnishDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}.${month}.${year}`;
}

function finnishAmount(minor: number): string {
  const sign = minor < 0 ? "-" : "+";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/** A Nordea-layout export (Windows-1252, `;`) of the given transactions. */
function nordeaCsv(
  rows: readonly Pick<
    ProviderTransaction,
    "bookingDate" | "amountMinor" | "counterparty" | "description"
  >[],
): Uint8Array {
  const lines = [
    "Kirjauspäivä;Arvopäivä;Määrä;Saaja/Maksaja;Viesti",
    ...rows.map((row) =>
      [
        finnishDate(row.bookingDate),
        finnishDate(row.bookingDate),
        finnishAmount(row.amountMinor),
        row.counterparty ?? "",
        row.description ?? "",
      ].join(";"),
    ),
  ];
  return Uint8Array.from(Buffer.from(`${lines.join("\r\n")}\r\n`, "latin1"));
}

async function newManualAccount(format: "nordea" | "s-pankki" = "nordea") {
  return createManualAccount(
    { name: `Imported ${randomUUID()}`, type: "checking", format },
    { db: testDb.db },
  );
}

async function importFile(accountId: string, bytes: Uint8Array) {
  return importCsvRows(accountId, readBankCsv(bytes), { db: testDb.db });
}

async function transactionsOf(accountId: string) {
  return testDb.db
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .orderBy(
      asc(transactions.bookingDate),
      asc(transactions.amountMinor),
      asc(transactions.dedupeHash),
    );
}

const COFFEE = {
  bookingDate: "2026-01-05",
  amountMinor: -450,
  counterparty: "Kahvila Määränpää",
  description: "Korttiosto",
};

describe("CSV import into a manual account", () => {
  it("imports a Nordea export, identical rows included", async () => {
    const accountId = await newManualAccount();
    const summary = await importFile(accountId, fixture("nordea.csv"));
    expect(summary).toEqual({
      rowsRead: 6,
      inserted: 6,
      duplicates: 0,
      repeated: 0,
      errors: [],
    });

    const stored = await transactionsOf(accountId);
    expect(stored).toHaveLength(6);
    expect(stored.every((row) => row.providerTxnRef === null)).toBe(true);
    expect(stored.every((row) => row.status === "booked")).toBe(true);
    expect(stored.every((row) => row.currency === "EUR")).toBe(true);
    const coffees = stored.filter((row) => row.amountMinor === -450);
    expect(coffees).toHaveLength(2);
    expect(new Set(coffees.map((row) => row.dedupeHash)).size).toBe(2);
    expect(stored.find((row) => row.amountMinor === -123_456)).toMatchObject({
      bookingDate: "2026-01-20",
      valueDate: "2026-01-20",
      counterparty: "Lähikauppa Öljymäki",
      description: "Korttiosto",
      categorySource: "none",
    });
  });

  it("keeps an S-Pankki row's archive id and counterparty IBAN", async () => {
    const accountId = await newManualAccount("s-pankki");
    const summary = await importFile(accountId, fixture("s-pankki-2026.csv"));
    expect(summary).toEqual({
      rowsRead: 4,
      inserted: 4,
      duplicates: 0,
      repeated: 0,
      errors: [],
    });
    const stored = await transactionsOf(accountId);
    expect(stored.find((row) => row.amountMinor === -100_000)).toMatchObject({
      providerTxnRef: "20261005TEST00000003",
      counterparty: "SÄÄSTÖTILI ESIMERKKI",
      counterpartyIban: "FI5939000000000006",
      description: "Säästö lokakuu",
    });
    expect(stored.find((row) => row.amountMinor === 15_000)).toMatchObject({
      providerTxnRef: "20261003TEST00000002",
      counterpartyIban: null,
      description: "Wedding gift",
    });

    // The same archive id with another text is the same transaction.
    const edited = new TextDecoder()
      .decode(fixture("s-pankki-2026.csv"))
      .replace("'Wedding gift'", "'Häälahja'");
    expect(
      await importFile(accountId, new TextEncoder().encode(edited)),
    ).toMatchObject({ inserted: 0, duplicates: 4 });
    expect(await transactionsOf(accountId)).toHaveLength(4);
  });

  it("imports a line the Nordea export repeats once", async () => {
    const accountId = await newManualAccount();
    const summary = await importFile(accountId, fixture("nordea-2026.csv"));
    expect(summary).toEqual({
      rowsRead: 8,
      inserted: 7,
      duplicates: 0,
      repeated: 1,
      errors: [],
    });
    const stored = await transactionsOf(accountId);
    expect(stored.filter((row) => row.amountMinor === 250_000)).toHaveLength(1);
    expect(stored.filter((row) => row.amountMinor === -450)).toHaveLength(2);
    expect(stored.find((row) => row.amountMinor === -95_000)).toMatchObject({
      counterparty: "Esimerkki Asunnot Oy",
      counterpartyIban: "FI0510000000000003",
    });
  });

  it("imports the Nordea card export into an account of its own", async () => {
    const parsed = readBankCsv(fixture("nordea-card-2026.csv"));
    const { accountId, summary } = await importCsvIntoNewAccount(
      { name: `Card ${randomUUID()}`, type: "checking", format: parsed.format },
      parsed,
      { db: testDb.db },
    );
    expect(summary).toMatchObject({ inserted: 3, errors: [{ row: 5 }] });
    const [institution] = await testDb.db
      .select({
        name: institutions.name,
        providerRef: institutions.providerRef,
      })
      .from(accounts)
      .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
      .where(eq(accounts.id, accountId));
    expect(institution).toEqual({ name: "Nordea", providerRef: "nordea-card" });
  });

  it("creates manual accounts under one csv institution per format", async () => {
    const first = await newManualAccount("s-pankki");
    const second = await newManualAccount("s-pankki");
    const rows = await testDb.db
      .select({
        connectionId: accounts.connectionId,
        institutionId: accounts.institutionId,
        providerAccountRef: accounts.providerAccountRef,
        currency: accounts.currency,
      })
      .from(accounts)
      .where(inArray(accounts.id, [first, second]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      connectionId: null,
      providerAccountRef: null,
      currency: "EUR",
    });
    expect(rows[0].institutionId).toBe(rows[1].institutionId);
    const [institution] = await testDb.db
      .select()
      .from(institutions)
      .where(eq(institutions.id, rows[0].institutionId));
    expect(institution).toMatchObject({
      name: "S-Pankki",
      provider: "csv",
      providerRef: "s-pankki",
      country: "FI",
    });
  });

  it("skips every row of a file imported twice", async () => {
    const accountId = await newManualAccount("s-pankki");
    expect(await importFile(accountId, fixture("s-pankki.csv"))).toMatchObject({
      inserted: 5,
      duplicates: 0,
    });
    const before = await transactionsOf(accountId);

    expect(await importFile(accountId, fixture("s-pankki.csv"))).toEqual({
      rowsRead: 5,
      inserted: 0,
      duplicates: 5,
      repeated: 0,
      errors: [],
    });
    expect(await transactionsOf(accountId)).toEqual(before);
  });

  it("imports only the new rows of an overlapping export", async () => {
    const accountId = await newManualAccount();
    const january = readBankCsv(fixture("nordea.csv")).rows;
    // The first export ends on 15 January.
    await importFile(
      accountId,
      nordeaCsv(january.filter((row) => row.bookingDate <= "2026-01-15")),
    );
    expect(await transactionsOf(accountId)).toHaveLength(4);

    // The second covers 5 January to February, with two new rows.
    const february = [
      {
        bookingDate: "2026-02-02",
        amountMinor: -95_000,
        counterparty: "Esimerkki Asunnot Oy",
        description: "Vuokra helmikuu",
      },
    ];
    const summary = await importFile(
      accountId,
      nordeaCsv([
        ...january.filter((row) => row.bookingDate >= "2026-01-05"),
        ...february,
      ]),
    );
    expect(summary).toEqual({
      rowsRead: 6,
      inserted: 3,
      duplicates: 3,
      repeated: 0,
      errors: [],
    });
    const stored = await transactionsOf(accountId);
    expect(stored).toHaveLength(7);
    expect(stored.filter((row) => row.amountMinor === -450)).toHaveLength(2);
  });

  it("adds the second identical row when a later export has both", async () => {
    const accountId = await newManualAccount();
    // Exported in the middle of the day: one coffee so far.
    expect(await importFile(accountId, nordeaCsv([COFFEE]))).toMatchObject({
      inserted: 1,
    });
    expect(
      await importFile(accountId, nordeaCsv([COFFEE, COFFEE])),
    ).toMatchObject({ inserted: 1, duplicates: 1 });
    expect(
      await importFile(accountId, nordeaCsv([COFFEE, COFFEE])),
    ).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(await transactionsOf(accountId)).toHaveLength(2);
  });

  it("reports unreadable rows and rows in another currency by line", async () => {
    const accountId = await newManualAccount();
    const parsed = readBankCsv(
      Uint8Array.from(
        Buffer.from(
          "Kirjauspäivä;Määrä;Nimi;Otsikko;Valuutta\n" +
            "1.3.2026;-1,00;Kioski;Osto;EUR\n" +
            "2.3.2026;-2,00;Kioski;Osto;SEK\n" +
            "3.3.2026;kaksi;Kioski;Osto;EUR\n",
          "latin1",
        ),
      ),
    );
    const summary = await importCsvRows(accountId, parsed, { db: testDb.db });
    expect(summary).toEqual({
      rowsRead: 3,
      inserted: 1,
      duplicates: 0,
      repeated: 0,
      errors: [
        { row: 3, message: "The currency SEK is not the account's EUR" },
        { row: 4, message: 'Not an amount: "kaksi"' },
      ],
    });
  });

  it("runs the categorisation hook inside the import with the new ids", async () => {
    const accountId = await newManualAccount();
    const seen: string[][] = [];
    const parsed = readBankCsv(fixture("nordea-utf8.csv"));
    await importCsvRows(accountId, parsed, {
      db: testDb.db,
      categorize: async (tx, ids) => {
        const rows = await tx
          .select({ id: transactions.id })
          .from(transactions)
          .where(inArray(transactions.id, ids));
        expect(rows).toHaveLength(ids.length);
        seen.push(ids);
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(3);

    // Nothing new: the hook is not called.
    await importCsvRows(accountId, parsed, {
      db: testDb.db,
      categorize: async (_tx, ids) => {
        seen.push(ids);
      },
    });
    expect(seen).toHaveLength(1);
  });

  it("refuses unknown and archived accounts", async () => {
    const parsed = readBankCsv(fixture("nordea.csv"));
    await expect(
      importCsvRows(randomUUID(), parsed, { db: testDb.db }),
    ).rejects.toThrow(ImportAccountError);

    const accountId = await newManualAccount();
    await testDb.db
      .update(accounts)
      .set({ archived: true })
      .where(eq(accounts.id, accountId));
    await expect(
      importCsvRows(accountId, parsed, { db: testDb.db }),
    ).rejects.toThrow(ImportAccountError);
    expect(await transactionsOf(accountId)).toHaveLength(0);
    expect(
      (await listImportAccounts({ db: testDb.db })).map((row) => row.id),
    ).not.toContain(accountId);
  });

  it("creates the new account and its rows in one transaction", async () => {
    const name = `New ${randomUUID()}`;
    const parsed = readBankCsv(fixture("s-pankki.csv"));
    const { accountId, summary } = await importCsvIntoNewAccount(
      { name, type: "savings", format: "s-pankki" },
      parsed,
      { db: testDb.db },
    );
    expect(summary).toMatchObject({ inserted: 5, duplicates: 0 });
    const [account] = await testDb.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId));
    expect(account).toMatchObject({ name, type: "savings", currency: "EUR" });
    expect(await transactionsOf(accountId)).toHaveLength(5);
  });

  it("leaves no empty account behind when the import fails", async () => {
    const accountNamed = async (name: string) =>
      testDb.db.select().from(accounts).where(eq(accounts.name, name));

    // Nothing importable: every row is in another currency.
    const sek = `SEK ${randomUUID()}`;
    const parsed = readBankCsv(
      Uint8Array.from(
        Buffer.from(
          "Kirjauspäivä;Määrä;Nimi;Valuutta\n1.3.2026;-1,00;Kioski;SEK\n",
          "latin1",
        ),
      ),
    );
    await expect(
      importCsvIntoNewAccount(
        { name: sek, type: "checking", format: "nordea" },
        parsed,
        { db: testDb.db },
      ),
    ).rejects.toThrow(/no account was created/);
    expect(await accountNamed(sek)).toEqual([]);

    // The write fails halfway (here: in the categorisation hook).
    const failing = `Failing ${randomUUID()}`;
    await expect(
      importCsvIntoNewAccount(
        { name: failing, type: "checking", format: "nordea" },
        readBankCsv(fixture("nordea.csv")),
        {
          db: testDb.db,
          categorize: async () => {
            throw new Error("rule engine down");
          },
        },
      ),
    ).rejects.toThrow("rule engine down");
    expect(await accountNamed(failing)).toEqual([]);
  });

  it("refuses an empty name for a new account", async () => {
    await expect(
      createManualAccount(
        { name: "  ", type: "savings", format: "generic" },
        { db: testDb.db },
      ),
    ).rejects.toThrow(ImportAccountError);
  });
});

describe("CSV import and the bank sync", () => {
  const fake = createFakeProvider({ now: () => NOW });
  const syncOptions = (): SyncTransactionsOptions => ({
    db: testDb.db,
    providers: createProviderRegistry([fake]),
    decrypt: (value) => decryptSecret(value, KEY),
    now: () => NOW,
    timeZone: "Europe/Helsinki",
  });
  const listing = (from: string, to: string) =>
    fetchAllTransactions(
      fake,
      { sessionRef: FAKE_SESSION_REFS.valid },
      "fake-checking",
      { from, to },
    );

  /** A fake connection with its accounts; returns the checking account. */
  async function syncedAccount() {
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
    expect((await syncBalances(connection.id, syncOptions())).status).toBe(
      "succeeded",
    );
    const [account] = await testDb.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.connectionId, connection.id),
          eq(accounts.providerAccountRef, "fake-checking"),
        ),
      );
    return { connectionId: connection.id, accountId: account.id };
  }

  it("skips rows the bank sync already stored and leaves them unchanged", async () => {
    const { connectionId, accountId } = await syncedAccount();
    expect((await syncTransactions(connectionId, syncOptions())).status).toBe(
      "succeeded",
    );
    const before = await transactionsOf(accountId);

    const february = (await listing("2026-02-01", "2026-02-28")).filter(
      (txn) => txn.status === "booked",
    );
    expect(february.length).toBeGreaterThan(3);
    const extra = {
      bookingDate: "2026-02-20",
      amountMinor: -1_999,
      counterparty: "Paid In Cash Elsewhere",
      description: "Only in the export",
    };
    const summary = await importFile(
      accountId,
      nordeaCsv([...february, extra]),
    );
    expect(summary).toEqual({
      rowsRead: february.length + 1,
      inserted: 1,
      duplicates: february.length,
      repeated: 0,
      errors: [],
    });

    const after = await transactionsOf(accountId);
    expect(after).toHaveLength(before.length + 1);
    // The synced rows are untouched (refs, status, updated_at).
    expect(after.filter((row) => row.providerTxnRef !== null)).toEqual(before);

    // A re-sync does not duplicate the imported row either.
    expect((await syncTransactions(connectionId, syncOptions())).status).toBe(
      "succeeded",
    );
    expect(await transactionsOf(accountId)).toHaveLength(after.length);
  });

  it("lets a later bank sync adopt imported rows instead of duplicating them", async () => {
    const { connectionId, accountId } = await syncedAccount();
    const imported = (await listing("2025-12-01", "2026-01-31")).filter(
      (txn) => txn.status === "booked",
    );
    expect(await importFile(accountId, nordeaCsv(imported))).toMatchObject({
      inserted: imported.length,
      duplicates: 0,
    });
    const importedRows = await transactionsOf(accountId);

    const result = await syncTransactions(connectionId, syncOptions());
    expect(result.status).toBe("succeeded");
    const all = await listing("2025-01-01", "2026-03-10");
    const stored = await transactionsOf(accountId);
    expect(stored).toHaveLength(all.length);
    // Same rows (ids kept), now with the bank's refs.
    const byId = new Map(stored.map((row) => [row.id, row]));
    for (const row of importedRows) {
      expect(byId.get(row.id)?.providerTxnRef).toMatch(/^fake-checking:/);
    }

    // And importing the same file again after the sync adds nothing.
    expect(await importFile(accountId, nordeaCsv(imported))).toMatchObject({
      inserted: 0,
      duplicates: imported.length,
    });
    expect(await transactionsOf(accountId)).toHaveLength(all.length);
  });

  it("offers synced and manual accounts, but not archived ones", async () => {
    const { accountId } = await syncedAccount();
    const manualId = await newManualAccount();
    const offered = await listImportAccounts({ db: testDb.db });
    expect(offered.find((row) => row.id === accountId)).toMatchObject({
      institution: "Fake Bank",
      manual: false,
      currency: "EUR",
    });
    expect(offered.find((row) => row.id === manualId)).toMatchObject({
      institution: "Nordea",
      manual: true,
    });
  });
});
