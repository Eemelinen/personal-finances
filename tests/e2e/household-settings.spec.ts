import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import {
  accounts,
  appSettings,
  institutions,
  transactions,
} from "@/server/db/schema";
import { monthOf } from "@/server/reports/period";
import { localDate } from "@/server/dates";
import { E2E_TIME_ZONE, openTestDatabase } from "./support/database";

// Settings → Household (F-030): adding a household member marks a credit
// from them, and turning on "Ignore transfers with household members"
// takes it out of the dashboard's income tile. Its own Playwright project
// runs after `settings-reports` (playwright.config.ts), so nothing else
// changes this month's income meanwhile; afterAll removes the credit and
// the household settings again. The name is synthetic.

test.describe.configure({ mode: "serial" });

const HOUSEHOLD_KEYS = [
  "ownNames",
  "householdMembers",
  "ignoreHouseholdTransfers",
];
const MEMBER = "Puoliso Testinen";
const CREDIT_MINOR = 45_600;

let db: Db;
let institutionId: string;
const thisMonth = monthOf(localDate(new Date(), E2E_TIME_ZONE));

/** Minor units of a `fi-FI` euro amount as the app prints it. */
function minorUnits(text: string): number {
  const number = text
    .replace(/[^\d,−-]/g, "")
    .replace("−", "-")
    .replace(",", ".");
  return Math.round(Number(number) * 100);
}

async function clearHousehold() {
  await db.delete(appSettings).where(inArray(appSettings.key, HOUSEHOLD_KEYS));
}

test.beforeAll(async () => {
  db = openTestDatabase();
  await clearHousehold();
  const [bank] = await db
    .insert(institutions)
    .values({
      name: "E2E Household Bank",
      country: "FI",
      provider: "csv",
      providerRef: `e2e-${randomUUID()}`,
    })
    .returning();
  institutionId = bank.id;
  const [account] = await db
    .insert(accounts)
    .values({
      institutionId,
      type: "checking",
      name: "E2E Household Checking",
      currency: "EUR",
    })
    .returning();
  // A contribution to shared costs, written the way a bank does.
  await db.insert(transactions).values({
    accountId: account.id,
    dedupeHash: "e2e-household-0",
    bookingDate: `${thisMonth}-01`,
    amountMinor: CREDIT_MINOR,
    currency: "EUR",
    counterparty: "TESTINEN PUOLISO",
  });
});

test.afterAll(async () => {
  if (db) {
    await clearHousehold();
    if (institutionId) {
      // The credit goes with its account.
      await db
        .delete(accounts)
        .where(eq(accounts.institutionId, institutionId));
      await db.delete(institutions).where(eq(institutions.id, institutionId));
    }
    await db.$client.end();
  }
});

async function incomeThisMonth(page: Page): Promise<number> {
  await page.goto("/");
  const amount = page
    .getByRole("main")
    .getByRole("region", { name: "Income this month", exact: true })
    .getByTestId("tile-amount");
  await expect(amount).toBeVisible();
  return minorUnits(await amount.innerText());
}

test("a household member's transfers leave the income while the toggle is on", async ({
  page,
}) => {
  const before = await incomeThisMonth(page);

  await page.goto("/settings");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^Household/ })
    .click();
  await expect(page).toHaveURL("/settings/household");

  // Add the member; saving marks the credit.
  const lists = page.locator("form").filter({
    has: page.getByRole("button", { name: "Save names and members" }),
  });
  await lists.getByRole("button", { name: "Add household member" }).click();
  await lists.getByLabel("Member 1: names").fill(MEMBER);
  await lists.getByRole("button", { name: "Save names and members" }).click();
  await expect(lists.getByRole("status")).toContainText(
    "1 transaction changed household mark",
  );

  // Still counted while the toggle is off (the default).
  expect(await incomeThisMonth(page)).toBe(before);
  await page.goto("/transactions?household=only");
  const row = page.getByTestId("transaction-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Household");

  // Flip the toggle: the credit leaves the income.
  await page.goto("/settings/household");
  const toggle = page.locator("form").filter({
    has: page.getByRole("checkbox", {
      name: "Ignore transfers with household members",
    }),
  });
  const box = toggle.getByRole("checkbox", {
    name: "Ignore transfers with household members",
  });
  await expect(box).not.toBeChecked();
  await box.check();
  await toggle.getByRole("button", { name: "Save" }).click();
  await expect(toggle.getByRole("status")).toHaveText("Saved.");
  await expect(page.getByLabel("Member 1: names")).toHaveValue(MEMBER);

  expect(await incomeThisMonth(page)).toBe(before - CREDIT_MINOR);
});
