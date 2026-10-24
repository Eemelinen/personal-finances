import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Db } from "@/server/db/client";
import {
  accounts,
  balanceSnapshots,
  institutions,
  transactions,
} from "@/server/db/schema";
import { addDays, localDate } from "@/server/dates";
import { dedupeHash } from "@/server/dedupe-hash";
import { daysBetween, rangeStart } from "@/server/reports/balance-series";
import { E2E_TIME_ZONE, openTestDatabase } from "./support/database";

// The balance history end to end: one account seeded straight into the test
// database (no UI creates balance snapshots yet), first synced 100 days ago,
// with transactions back to 300 days ago. The range selector changes the
// days drawn and the balance at the range's start: carried over (3 months),
// estimated from transactions (6 months) or unknown (1 year). Other specs'
// accounts may be drawn too, so only this account's row and the day counts
// are asserted.

test.describe.configure({ mode: "serial" });

const ACCOUNT = "E2E Historiatili";

let db: Db;
let today: string;

test.beforeAll(async () => {
  db = openTestDatabase();
  today = localDate(new Date(), E2E_TIME_ZONE);
  const [bank] = await db
    .insert(institutions)
    .values({
      name: "E2E Historiapankki",
      country: "FI",
      provider: "enable_banking",
      providerRef: `e2e-${randomUUID()}`,
    })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({
      institutionId: bank.id,
      type: "savings",
      name: ACCOUNT,
      currency: "EUR",
    })
    .returning();
  await db.insert(balanceSnapshots).values(
    [
      [100, 150_000],
      [10, 160_000],
    ].map(([daysAgo, amountMinor]) => ({
      accountId: account.id,
      date: addDays(today, -daysAgo),
      amountMinor,
      currency: "EUR",
      balanceType: "CLBD",
    })),
  );
  // 1 700,00 before day -150, 1 500,00 from it to the first sync.
  await db.insert(transactions).values(
    [
      [300, 100_000],
      [150, -20_000],
    ].map(([daysAgo, amountMinor]) => {
      const bookingDate = addDays(today, -daysAgo);
      return {
        accountId: account.id,
        dedupeHash: dedupeHash({
          bookingDate,
          amountMinor,
          counterparty: "E2E history",
          description: null,
        }),
        bookingDate,
        amountMinor,
        currency: "EUR",
        counterparty: "E2E history",
      };
    }),
  );
});

test.afterAll(async () => {
  await db?.$client.end();
});

const days = (range: "3m" | "6m" | "1y") =>
  daysBetween(rangeStart(range, today, null), today).length;

test("the range selector changes the series", async ({ page }) => {
  await page.goto("/reports");
  await page.getByRole("link", { name: "Balances" }).first().click();
  await expect(page).toHaveURL("/reports/balances");
  await expect(
    page.getByRole("navigation", { name: "Reports" }).getByRole("link", {
      name: "Balances",
    }),
  ).toHaveAttribute("aria-current", "page");

  const ranges = page.getByRole("region", { name: "Range" });
  const chart = page.getByTestId("net-worth-chart").filter({ visible: true });
  const row = page
    .getByTestId("balance-row")
    .filter({ visible: true, hasText: ACCOUNT });

  // Default: 3 months, synced balances carried over.
  await expect(ranges.getByRole("link", { name: "3 months" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(chart).toHaveAttribute("data-days", String(days("3m")));
  await expect(row.getByTestId("balance-start")).toHaveText(/^1\s500,00\s€$/);
  await expect(row.getByTestId("balance-end")).toHaveText(/^1\s600,00\s€$/);
  await expect(row.getByTestId("balance-change")).toHaveText(/^\+100,00\s€$/);
  await expect(
    page.getByRole("list", { name: "Legend" }).getByText(ACCOUNT),
  ).toBeVisible();

  // 6 months: the start is before the first sync, rebuilt from transactions.
  await ranges.getByRole("link", { name: "6 months" }).click();
  await expect(page).toHaveURL("/reports/balances?range=6m");
  await expect(chart).toHaveAttribute("data-days", String(days("6m")));
  await expect(row.getByTestId("balance-start")).toHaveText(
    /^1\s700,00\s€ \(est\.\)$/,
  );
  await expect(row.getByTestId("balance-change")).toHaveText(/^−100,00\s€$/);
  await expect(chart).toContainText("Estimated");

  // The tooltip breaks the day down per account.
  await chart.hover();
  const tooltip = page
    .getByTestId("balance-tooltip")
    .filter({ visible: true })
    .first();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(ACCOUNT);

  // 1 year: nothing is known before the first transaction.
  await ranges.getByRole("link", { name: "1 year" }).click();
  await expect(page).toHaveURL("/reports/balances?range=1y");
  await expect(chart).toHaveAttribute("data-days", String(days("1y")));
  await expect(row.getByTestId("balance-start")).toHaveText("–");
  await expect(row.getByTestId("balance-change")).toHaveText("–");

  // All: back to the earliest data, at least this account's first transaction.
  await ranges.getByRole("link", { name: "All" }).click();
  await expect(page).toHaveURL("/reports/balances?range=all");
  await expect
    .poll(async () => Number(await chart.getAttribute("data-days")))
    .toBeGreaterThanOrEqual(301);
  await expect(row.getByTestId("balance-end")).toHaveText(/^1\s600,00\s€$/);
});
