import { randomUUID } from "node:crypto";
import { expect, test, type Locator } from "@playwright/test";
import type { Db } from "@/server/db/client";
import {
  accounts,
  balanceSnapshots,
  connections,
  institutions,
} from "@/server/db/schema";
import { addDays, localDate } from "@/server/sync/transaction-merge";
import { E2E_TIME_ZONE, openTestDatabase } from "./support/database";

// The dashboard overview end to end. This spec has its own Playwright project
// that runs before every other spec (playwright.config.ts), so the first
// test sees a database without accounts. The second seeds banks, accounts
// and 90 days of balances straight into the test database (no UI creates
// them yet) and reads the tiles, the account list and connection status.

test.describe.configure({ mode: "serial" });

const DAY_MS = 86_400_000;

let db: Db;

test.beforeAll(() => {
  db = openTestDatabase();
});

test.afterAll(async () => {
  await db?.$client.end();
});

test("without accounts it guides to Connect bank or Import CSV", async ({
  page,
}) => {
  await page.goto("/");
  const empty = page.getByTestId("empty-state");
  await expect(empty).toContainText("No accounts yet");
  await expect(page.getByRole("region", { name: "Net worth" })).toHaveCount(0);

  await empty.getByRole("link", { name: "Connect bank" }).click();
  await expect(page).toHaveURL("/connections");

  await page.goto("/");
  await page
    .getByTestId("empty-state")
    .getByRole("link", { name: "Import CSV" })
    .click();
  await expect(page).toHaveURL("/import");
});

async function seed() {
  const now = Date.now();
  const today = localDate(new Date(now), E2E_TIME_ZONE);
  const bank = async (name: string) => {
    const [row] = await db
      .insert(institutions)
      .values({
        name,
        country: "FI",
        provider: "enable_banking",
        providerRef: `e2e-${randomUUID()}`,
      })
      .returning();
    return row.id;
  };
  const connect = async (
    institutionId: string,
    values: Partial<typeof connections.$inferInsert>,
  ) => {
    const [row] = await db
      .insert(connections)
      .values({ institutionId, provider: "enable_banking", ...values })
      .returning();
    return row.id;
  };
  const account = async (values: typeof accounts.$inferInsert) => {
    const [row] = await db.insert(accounts).values(values).returning();
    return row.id;
  };
  const balances = (accountId: string, rows: [number, number][]) =>
    db.insert(balanceSnapshots).values(
      rows.map(([daysAgo, amountMinor]) => ({
        accountId,
        date: addDays(today, -daysAgo),
        amountMinor,
        currency: "EUR",
        balanceType: "CLBD",
      })),
    );

  const nordea = await bank("Nordea");
  const spankki = await bank("S-Pankki");
  const danske = await bank("Danske Bank");
  const nordeaConnection = await connect(nordea, {
    consentExpiresAt: new Date(now + 120 * DAY_MS),
    lastSyncedAt: new Date(now - 2 * 3_600_000),
  });
  const spankkiConnection = await connect(spankki, {
    consentExpiresAt: new Date(now + 5 * DAY_MS),
    lastSyncedAt: new Date(now - 3_600_000),
  });
  await connect(danske, {
    status: "expired",
    consentExpiresAt: new Date(now - DAY_MS),
  });

  const checking = await account({
    institutionId: nordea,
    connectionId: nordeaConnection,
    type: "checking",
    name: "E2E Käyttötili",
    iban: "FI21 1234 5600 0007 85",
    currency: "EUR",
  });
  const savings = await account({
    institutionId: nordea,
    connectionId: nordeaConnection,
    type: "savings",
    name: "E2E Säästötili",
    currency: "EUR",
  });
  const sTili = await account({
    institutionId: spankki,
    connectionId: spankkiConnection,
    type: "checking",
    name: "E2E S-tili",
    currency: "EUR",
  });
  // Checking 2 000,00 → 1 234,56 + 500,00 → 765,44: total 2 000,00, −500,00.
  // Savings 9 000,00 → 10 500,00: +1 500,00. Net worth 12 500,00, +1 000,00.
  await balances(checking, [
    [60, 250_000],
    [30, 200_000],
    [12, 150_000],
    [0, 123_456],
  ]);
  await balances(savings, [
    [120, 900_000],
    [5, 1_050_000],
  ]);
  await balances(sTili, [
    [85, 48_000],
    [60, 52_000],
    [30, 50_000],
    [15, 61_000],
    [0, 76_544],
  ]);
}

async function expectTile(tile: Locator, amount: RegExp, change: RegExp) {
  await expect(tile.getByTestId("tile-amount")).toHaveText(amount);
  await expect(tile.getByTestId("tile-change")).toHaveText(change);
}

test("shows totals, accounts by bank and connection status", async ({
  page,
}) => {
  await seed();
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toHaveCount(0);

  await expectTile(
    page.getByRole("region", { name: "Net worth" }),
    /^12\s500,00\s€$/,
    /^\+1\s000,00\s€ vs 30 days ago$/,
  );
  await expectTile(
    page.getByRole("region", { name: "Checking" }),
    /^2\s000,00\s€$/,
    /^\u2212500,00\s€ vs 30 days ago$/,
  );
  await expectTile(
    page.getByRole("region", { name: "Savings" }),
    /^10\s500,00\s€$/,
    /^\+1\s500,00\s€ vs 30 days ago$/,
  );

  const banks = page.getByTestId("bank");
  await expect(banks.getByRole("heading", { level: 3 })).toHaveText([
    "Nordea",
    "S-Pankki",
  ]);
  const nordea = page.getByRole("region", { name: "Nordea" });
  const rows = nordea.getByTestId("account");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("E2E Käyttötili");
  await expect(rows.nth(0)).toContainText("Checking · FI21 1234 5600 0007 85");
  await expect(rows.nth(0).getByTestId("account-balance")).toHaveText(
    /^1\s234,56\s€$/,
  );
  await expect(rows.nth(0).getByTestId("account-last-sync")).toHaveText(
    /^Synced \d{1,2}\.\d{1,2}\.\d{4} klo \d{1,2}\.\d{2}$/,
  );
  await expect(rows.nth(1)).toContainText("E2E Säästötili");
  await expect(rows.nth(1).getByTestId("account-balance")).toHaveText(
    /^10\s500,00\s€$/,
  );

  // Every account has history inside the 90 days, so each draws a line.
  for (const name of ["E2E Käyttötili", "E2E Säästötili", "E2E S-tili"]) {
    const sparkline = page.getByRole("img", {
      name: `${name}: balance, last 90 days`,
    });
    await expect(sparkline.locator("path.recharts-line-curve")).toHaveCount(1);
  }

  const status = page.getByTestId("connection");
  await expect(status).toHaveCount(3);
  await expect(status.filter({ hasText: "Nordea" })).toContainText("OK");
  await expect(status.filter({ hasText: "S-Pankki" })).toContainText(
    "Expiring",
  );
  await expect(status.filter({ hasText: "Danske Bank" })).toContainText(
    "Expired",
  );
  await status.filter({ hasText: "S-Pankki" }).click();
  await expect(page).toHaveURL("/connections");
});
