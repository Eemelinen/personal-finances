import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
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

// Settings → Reports (F-026): turning off "Count credits without a
// category as income" moves an uncategorised credit out of the dashboard's
// income tile into "Other money in (not income)". Turning on "Leave
// investments out of spending and income" (F-037) moves a fund
// subscription out of this month's expenses. Its own Playwright project
// runs right after `reports` (playwright.config.ts), so this month's
// income and expenses are exactly what reports.spec.ts seeded plus the
// rows seeded here; afterAll removes the rows and the settings again.

test.describe.configure({ mode: "serial" });

let db: Db;
let institutionId: string;
let accountId: string;
const thisMonth = monthOf(localDate(new Date(), E2E_TIME_ZONE));
const OTHER_IN = "Other money in (not income)";

/** `fi-FI` euros as the app prints them: no-break spaces, U+2212 minus. */
const eur = (text: string) => `${text.replace(/ /g, " ").replace("-", "−")} €`;

test.beforeAll(async () => {
  db = openTestDatabase();
  await db.delete(appSettings);
  const [bank] = await db
    .insert(institutions)
    .values({
      name: "E2E Settings Bank",
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
      name: "E2E Settings Checking",
      currency: "EUR",
    })
    .returning();
  accountId = account.id;
  // No category: income while the setting is on.
  await db.insert(transactions).values({
    accountId: account.id,
    dedupeHash: "e2e-settings-reports-0",
    bookingDate: `${thisMonth}-01`,
    amountMinor: 123_400,
    currency: "EUR",
    counterparty: "Lainan nosto",
  });
});

test.afterAll(async () => {
  if (db) {
    await db.delete(appSettings);
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

const tile = (page: Page, name: string) =>
  page
    .getByRole("main")
    .getByRole("region", { name, exact: true })
    .getByTestId("tile-amount");

/** Switches one checkbox on Settings → Reports; returns the status text. */
async function setSetting(page: Page, name: string, on: boolean) {
  await page.goto("/settings");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^Reports/ })
    .click();
  await expect(page).toHaveURL("/settings/reports");
  const box = page.getByRole("checkbox", { name });
  await expect(box).toBeChecked({ checked: !on });
  await box.setChecked(on);
  await page.getByRole("button", { name: "Save" }).click();
  const status = page.getByRole("status");
  await expect(status).toHaveText(/^Saved\./);
  return status;
}

const setIncomeSetting = (page: Page, on: boolean) =>
  setSetting(page, "Count credits without a category as income", on);

test("the income setting moves uncategorised credits to other money in", async ({
  page,
}) => {
  // On by default: reports.spec.ts's 2 500,00 salary plus the credit.
  await page.goto("/");
  await expect(tile(page, "Income this month")).toHaveText(eur("3 734,00"));
  await expect(tile(page, "Net this month")).toHaveText(eur("3 659,00"));
  await expect(
    page.getByRole("main").getByRole("region", { name: OTHER_IN }),
  ).toHaveCount(0);

  await setIncomeSetting(page, false);
  await page.goto("/");
  await expect(tile(page, "Income this month")).toHaveText(eur("2 500,00"));
  await expect(tile(page, "Expenses this month")).toHaveText(eur("75,00"));
  await expect(tile(page, "Net this month")).toHaveText(eur("2 425,00"));
  await expect(tile(page, OTHER_IN)).toHaveText(eur("1 234,00"));

  // The cash-flow report shows it for the year to date and per month.
  await page.getByRole("link", { name: "Cash flow report" }).click();
  await expect(page).toHaveURL("/reports/cash-flow");
  const ytd = page.getByRole("region", { name: /^Year to date/ });
  await expect(
    ytd
      .getByRole("region", { name: OTHER_IN, exact: true })
      .getByTestId("tile-amount"),
  ).toHaveText(eur("1 234,00"));
  await expect(
    page.getByRole("columnheader", { name: OTHER_IN }),
  ).toBeVisible();
  await expect(page.getByTestId("cash-flow-row").first()).toContainText(
    eur("1 234,00"),
  );

  // Back on: today's behaviour, no other-money-in tile.
  await setIncomeSetting(page, true);
  await page.goto("/");
  await expect(tile(page, "Income this month")).toHaveText(eur("3 734,00"));
  await expect(
    page.getByRole("main").getByRole("region", { name: OTHER_IN }),
  ).toHaveCount(0);
});

test("the investments setting leaves a fund subscription out of expenses", async ({
  page,
}) => {
  await db.insert(transactions).values({
    accountId,
    dedupeHash: "e2e-settings-reports-1",
    bookingDate: `${thisMonth}-02`,
    amountMinor: -20_000,
    currency: "EUR",
    counterparty: "Synthetic Index Fund A",
    description: "MERKINTÄ",
  });
  // Off by default: reports.spec.ts's 75,00 plus the subscription.
  await page.goto("/");
  await expect(tile(page, "Expenses this month")).toHaveText(eur("275,00"));

  const name = "Leave investments out of spending and income";
  await expect(await setSetting(page, name, true)).toHaveText(
    "Saved. 1 transaction changed category.",
  );
  await page.goto("/");
  await expect(tile(page, "Expenses this month")).toHaveText(eur("75,00"));

  // Off again: the subscription is spending once more.
  await expect(await setSetting(page, name, false)).toHaveText(
    "Saved. 1 transaction changed category.",
  );
  await page.goto("/");
  await expect(tile(page, "Expenses this month")).toHaveText(eur("275,00"));
});
