import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@/server/db/client";
import { applyMigrations, migrationsFolder } from "@/server/db/migrations";
import {
  accounts,
  balanceSnapshots,
  institutions,
  transactions,
} from "@/server/db/schema";
import { dedupeHash } from "@/server/dedupe-hash";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

const CORE_TABLES = [
  "accounts",
  "assets",
  "balance_snapshots",
  "bank_authorizations",
  "categories",
  "category_rules",
  "connections",
  "fx_rates",
  "holdings",
  "institutions",
  "investment_transactions",
  "prices",
  "sync_runs",
  "transactions",
];

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

/** The Postgres error behind a failed Drizzle query (Drizzle wraps it in `cause`). */
async function pgError(query: Promise<unknown>) {
  const error: unknown = await query.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected the query to fail").toBeInstanceOf(Error);
  const cause = (error as Error).cause ?? error;
  return cause as { code?: string; constraint_name?: string };
}

async function createAccount(name: string) {
  const db = testDb.db;
  const [institution] = await db
    .insert(institutions)
    .values({
      name: `Test Bank ${name}`,
      country: "FI",
      provider: "csv",
      providerRef: `test-${name}`,
    })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({
      institutionId: institution!.id,
      type: "checking",
      name,
      currency: "EUR",
    })
    .returning();
  return account!;
}

function transaction(
  accountId: string,
  overrides: Partial<typeof transactions.$inferInsert> = {},
): typeof transactions.$inferInsert {
  const fields = {
    bookingDate: "2026-01-05",
    amountMinor: -1250,
    counterparty: "S-Market Kamppi",
    description: "Korttiosto",
    ...overrides,
  };
  return {
    accountId,
    currency: "EUR",
    dedupeHash: dedupeHash(fields),
    ...fields,
  };
}

describe("migrations", () => {
  it("apply to a fresh Postgres 18", async () => {
    const [row] = await testDb.db.execute<{ version: string }>(
      sql`select current_setting('server_version') as version`,
    );
    expect(row!.version).toMatch(/^18\./);

    const rows = await testDb.db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name
    `);
    expect(rows.map((r) => r.table_name)).toEqual(CORE_TABLES);
  });

  it("apply through the migrate entry point (pnpm db:migrate, the compose migrate service)", async () => {
    // A second, empty database in the same container.
    await testDb.db.execute(sql`create database migrate_cli`);
    const url = new URL(testDb.url);
    url.pathname = "/migrate_cli";

    const { stdout } = await promisify(execFile)(
      path.resolve("node_modules/.bin/tsx"),
      ["src/server/db/migrate.ts"],
      { env: { ...process.env, DATABASE_URL: url.toString() } },
    );
    expect(stdout).toContain("Migrations applied.");

    const other = createDb(url.toString(), { max: 1 });
    try {
      const rows = await other.execute<{ table_name: string }>(sql`
        select table_name from information_schema.tables
        where table_schema = 'public' order by table_name
      `);
      expect(rows.map((r) => r.table_name)).toEqual(CORE_TABLES);
    } finally {
      await other.$client.end();
    }
  });

  it("record every generated migration and are idempotent", async () => {
    const journal = JSON.parse(
      readFileSync(
        path.join(migrationsFolder, "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: unknown[] };
    const count = async () => {
      const [row] = await testDb.db.execute<{ n: number }>(
        sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
      );
      return row!.n;
    };

    expect(journal.entries.length).toBeGreaterThan(0);
    expect(await count()).toBe(journal.entries.length);
    await applyMigrations(testDb.db);
    expect(await count()).toBe(journal.entries.length);
  });

  it("store money as bigint minor units with a char(3) currency", async () => {
    const columns = await testDb.db.execute<{
      table_name: string;
      column_name: string;
      data_type: string;
      character_maximum_length: number | null;
    }>(sql`
      select table_name, column_name, data_type, character_maximum_length
      from information_schema.columns
      where table_schema = 'public'
        and (column_name = 'amount_minor' or column_name = 'currency')
      order by table_name, column_name
    `);

    const byKey = Object.fromEntries(
      columns.map((c) => [
        `${c.table_name}.${c.column_name}`,
        `${c.data_type}${c.character_maximum_length ? `(${c.character_maximum_length})` : ""}`,
      ]),
    );
    expect(byKey).toEqual({
      "accounts.currency": "character(3)",
      "assets.currency": "character(3)",
      "balance_snapshots.amount_minor": "bigint",
      "balance_snapshots.currency": "character(3)",
      "fx_rates.currency": "character(3)",
      "investment_transactions.amount_minor": "bigint",
      "investment_transactions.currency": "character(3)",
      "prices.currency": "character(3)",
      "transactions.amount_minor": "bigint",
      "transactions.currency": "character(3)",
    });
  });

  it("use timestamptz for every timestamp and give each table created_at / updated_at", async () => {
    const columns = await testDb.db.execute<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(sql`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public' and data_type like 'timestamp%'
    `);

    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(
        column.data_type,
        `${column.table_name}.${column.column_name}`,
      ).toBe("timestamp with time zone");
    }
    for (const table of CORE_TABLES) {
      const names = columns
        .filter((c) => c.table_name === table)
        .map((c) => c.column_name);
      expect(names, table).toEqual(
        expect.arrayContaining(["created_at", "updated_at"]),
      );
    }
  });

  it("index transactions by account and booking date, and by category", async () => {
    const rows = await testDb.db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'transactions'
    `);
    const defs = rows.map((r) => r.indexdef);

    expect(defs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\(account_id, booking_date\)$/),
        expect.stringMatching(/\(category_id\)$/),
      ]),
    );
  });
});

describe("idempotency constraints", () => {
  it("round-trip an amount beyond 32 bits exactly", async () => {
    const account = await createAccount("bigint");
    const [row] = await testDb.db
      .insert(transactions)
      .values(transaction(account.id, { amountMinor: 1_234_567_890_123 }))
      .returning();

    expect(row!.amountMinor).toBe(1_234_567_890_123);
    expect(row!.categorySource).toBe("none");
    expect(row!.status).toBe("booked");
  });

  it("reject a duplicate provider_txn_ref in one account", async () => {
    const account = await createAccount("ref");
    const other = await createAccount("ref-other");
    await testDb.db
      .insert(transactions)
      .values(transaction(account.id, { providerTxnRef: "txn-1" }));

    const error = await pgError(
      testDb.db
        .insert(transactions)
        .values(
          transaction(account.id, { providerTxnRef: "txn-1", amountMinor: -1 }),
        ),
    );
    expect(error.code).toBe("23505");
    expect(error.constraint_name).toBe(
      "transactions_account_id_provider_txn_ref_unique",
    );

    // The same ref in another account is a different transaction.
    await expect(
      testDb.db
        .insert(transactions)
        .values(transaction(other.id, { providerTxnRef: "txn-1" })),
    ).resolves.toBeDefined();
  });

  it("allow many transactions without a provider_txn_ref", async () => {
    const account = await createAccount("no-ref");
    await testDb.db
      .insert(transactions)
      .values([
        transaction(account.id, { amountMinor: -100 }),
        transaction(account.id, { amountMinor: -200 }),
      ]);

    const rows = await testDb.db
      .select()
      .from(transactions)
      .where(sql`${transactions.accountId} = ${account.id}`);
    expect(rows).toHaveLength(2);
  });

  it("reject a duplicate dedupe_hash in one account", async () => {
    const account = await createAccount("hash");
    const other = await createAccount("hash-other");
    await testDb.db.insert(transactions).values(transaction(account.id));

    // Same transaction as re-imported from a CSV: different spelling, same hash.
    const error = await pgError(
      testDb.db.insert(transactions).values(
        transaction(account.id, {
          bookingDate: "5.1.2026",
          counterparty: " S-MARKET kamppi",
        }),
      ),
    );
    expect(error.code).toBe("23505");
    expect(error.constraint_name).toBe(
      "transactions_account_id_dedupe_hash_unique",
    );

    await expect(
      testDb.db.insert(transactions).values(transaction(other.id)),
    ).resolves.toBeDefined();
  });

  it("reject a second balance snapshot for one account, day and balance type", async () => {
    const account = await createAccount("balance");
    const snapshot = {
      accountId: account.id,
      date: "2026-01-05",
      amountMinor: 150_000,
      currency: "EUR",
      balanceType: "CLBD",
    };
    await testDb.db.insert(balanceSnapshots).values(snapshot);
    await testDb.db
      .insert(balanceSnapshots)
      .values({ ...snapshot, balanceType: "ITAV" });

    const error = await pgError(
      testDb.db
        .insert(balanceSnapshots)
        .values({ ...snapshot, amountMinor: 1 }),
    );
    expect(error.code).toBe("23505");
    expect(error.constraint_name).toBe(
      "balance_snapshots_account_id_date_balance_type_unique",
    );
  });
});
