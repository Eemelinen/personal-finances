import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import {
  accounts,
  categories,
  institutions,
  transactions,
} from "@/server/db/schema";
import { addMonths, firstDay, monthOf } from "@/server/reports/period";
import { localDate } from "@/server/dates";
import { E2E_TIME_ZONE, openTestDatabase } from "./support/database";

// The spending and cash-flow reports end to end. This spec has its own
// Playwright project after `dashboard` and before every other spec
// (playwright.config.ts), so its totals see only the transactions it seeds
// here (no UI writes categorised transactions yet): this month and last
// month, with a refund and an own transfer.

test.describe.configure({ mode: "serial" });

let db: Db;
const today = localDate(new Date(), E2E_TIME_ZONE);
const thisMonth = monthOf(today);
const lastMonth = addMonths(thisMonth, -1);
let ids: { groceries: string; supermarkets: string };

/** `fi-FI` euros as the app prints them: no-break spaces, U+2212 minus. */
const eur = (text: string) => `${text.replace(/ /g, " ").replace("-", "−")} €`;

test.beforeAll(async () => {
  db = openTestDatabase();
  // The e2e server seeds the default categories, which include these (same
  // kinds and colours), so an existing one is reused rather than duplicated.
  const category = async (
    name: string,
    kind: "expense" | "income" | "transfer",
    color: string,
    parentId?: string,
  ) => {
    const [row] = await db
      .insert(categories)
      .values({ name, kind, color, parentId })
      .onConflictDoNothing()
      .returning({ id: categories.id });
    if (row) return row.id;
    const [existing] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.name, name),
          parentId
            ? eq(categories.parentId, parentId)
            : isNull(categories.parentId),
        ),
      );
    return existing.id;
  };
  const groceries = await category("Groceries", "expense", "#22c55e");
  const supermarkets = await category(
    "Supermarkets",
    "expense",
    "#22c55e",
    groceries,
  );
  const restaurants = await category(
    "Restaurants & cafés",
    "expense",
    "#f97316",
  );
  const income = await category("Income", "income", "#16a34a");
  const transfers = await category("Transfers", "transfer", "#64748b");
  ids = { groceries, supermarkets };

  const [bank] = await db
    .insert(institutions)
    .values({
      name: "E2E Reports Bank",
      country: "FI",
      provider: "csv",
      providerRef: `e2e-${randomUUID()}`,
    })
    .returning();
  const account = async (name: string) => {
    const [row] = await db
      .insert(accounts)
      .values({
        institutionId: bank.id,
        type: "checking",
        name,
        currency: "EUR",
      })
      .returning();
    return row.id;
  };
  const main = await account("E2E Reports Checking");
  const other = await account("E2E Reports Savings");

  // Every row on the 1st or 2nd, so this month's are never in the future.
  const group = randomUUID();
  const rows: [
    month: string,
    day: string,
    amountMinor: number,
    categoryId: string,
    counterparty: string,
    extra?: Partial<typeof transactions.$inferInsert>,
  ][] = [
    [thisMonth, "01", -4_500, supermarkets, "K-MARKET KAMPPI"],
    [thisMonth, "01", -1_500, supermarkets, "K-Market Itis 1234"],
    [thisMonth, "02", 500, supermarkets, "K-MARKET KAMPPI"],
    [thisMonth, "01", -2_000, restaurants, "SUMUP *KAHVILA PIENI"],
    [thisMonth, "01", 250_000, income, "Työnantaja Oy"],
    [
      thisMonth,
      "01",
      -50_000,
      transfers,
      "Oma siirto",
      { transferGroupId: group },
    ],
    [
      thisMonth,
      "01",
      50_000,
      transfers,
      "Oma siirto",
      { transferGroupId: group, accountId: other },
    ],
    [lastMonth, "01", -8_000, supermarkets, "PRISMA LAAJASALO"],
    [lastMonth, "02", -3_000, restaurants, "SUMUP *KAHVILA PIENI"],
    [lastMonth, "01", 240_000, income, "Työnantaja Oy"],
  ];
  await db.insert(transactions).values(
    rows.map(
      ([month, day, amountMinor, categoryId, counterparty, extra], i) => ({
        accountId: main,
        dedupeHash: `e2e-reports-${i}`,
        bookingDate: `${month}-${day}`,
        amountMinor,
        currency: "EUR",
        counterparty,
        categoryId,
        categorySource: "manual" as const,
        ...extra,
      }),
    ),
  );
});

test.afterAll(async () => {
  await db?.$client.end();
});

const spendingTile = (page: Page) =>
  page
    .getByRole("region", { name: "Spending", exact: true })
    .getByTestId("tile-amount");

test("switches the period with presets and a custom range", async ({
  page,
}) => {
  await page.goto("/reports");
  await page.getByRole("link", { name: /^Spending/ }).click();
  await expect(page).toHaveURL("/reports/spending");

  // This month by default: 45 + 15 − 5 refund + 20; salary and transfer out.
  await expect(page.getByRole("link", { name: "This month" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(spendingTile(page)).toHaveText(eur("75,00"));
  const byCategory = page.getByRole("region", { name: "By category" });
  await expect(byCategory.getByTestId("category-row")).toHaveCount(2);
  await expect(byCategory.getByTestId("category-row").first()).toContainText(
    "Groceries",
  );
  await expect(byCategory.getByTestId("category-row").first()).toContainText(
    eur("55,00"),
  );
  await expect(byCategory.getByTestId("category-row").first()).toContainText(
    "73,3 %",
  );
  await expect(
    page
      .getByRole("region", { name: "Previous period" })
      .getByTestId("tile-amount"),
  ).toHaveText(eur("110,00"));

  // Top merchants by normalised name, the refund netted.
  const merchants = page
    .getByRole("region", { name: "Top merchants" })
    .getByTestId("merchant-row");
  await expect(merchants).toHaveCount(2);
  await expect(merchants.nth(0)).toContainText("K-Market");
  await expect(merchants.nth(0)).toContainText("3 purchases");
  await expect(merchants.nth(0)).toContainText(eur("55,00"));
  await expect(merchants.nth(1)).toContainText("Kahvila Pieni");

  // The stacked 12-month chart draws bars.
  const trend = page.getByTestId("spending-trend-chart");
  await expect(trend.locator(".recharts-bar-rectangle").first()).toBeVisible();

  await page.getByRole("link", { name: "Last month" }).click();
  await expect(page).toHaveURL("/reports/spending?period=last-month");
  await expect(spendingTile(page)).toHaveText(eur("110,00"));
  await expect(
    page
      .getByRole("region", { name: "Top merchants" })
      .getByTestId("merchant-row")
      .first(),
  ).toContainText("Prisma");

  await page.getByRole("link", { name: "Last 3 months" }).click();
  await expect(page).toHaveURL("/reports/spending?period=3m");
  await expect(spendingTile(page)).toHaveText(eur("185,00"));

  // Custom: only the first day of this month leaves out the refund on the 2nd.
  const custom = page.getByRole("form", { name: "Custom period" });
  await custom.getByLabel("From").fill(firstDay(thisMonth));
  await custom.getByLabel("To").fill(firstDay(thisMonth));
  await custom.getByRole("button", { name: "Custom" }).click();
  await expect(page).toHaveURL(
    `/reports/spending?period=custom&from=${firstDay(thisMonth)}&to=${firstDay(thisMonth)}`,
  );
  await expect(spendingTile(page)).toHaveText(eur("80,00"));
});

test("drills down to subcategories and the transactions", async ({ page }) => {
  await page.goto("/reports/spending?period=this-month");
  await page
    .getByRole("region", { name: "By category" })
    .getByRole("link", { name: "Groceries" })
    .click();
  await expect(page).toHaveURL(
    `/reports/spending?period=this-month&category=${ids.groceries}`,
  );
  await expect(spendingTile(page)).toHaveText(eur("55,00"));
  const breakdown = page.getByRole("region", {
    name: "Groceries by subcategory",
  });
  await expect(breakdown.getByTestId("category-row")).toHaveCount(1);
  await expect(page.getByTestId("transaction-row")).toHaveCount(3);

  await breakdown.getByRole("link", { name: "Supermarkets" }).click();
  await expect(page).toHaveURL(
    `/reports/spending?period=this-month&category=${ids.supermarkets}`,
  );
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs).toContainText("All categories");
  await expect(crumbs.getByRole("link", { name: "Groceries" })).toBeVisible();
  const rows = page.getByTestId("transaction-row");
  await expect(rows).toHaveCount(3);
  // Newest first; the refund is listed with its sign.
  await expect(rows.nth(0)).toContainText("K-MARKET KAMPPI");
  await expect(rows.nth(0)).toContainText(eur("5,00"));
  await expect(page.getByTestId("transaction-count")).toHaveText(
    "3 transactions",
  );

  // The drill-down survives a period switch.
  await page.getByRole("link", { name: "Last month" }).click();
  await expect(page).toHaveURL(
    `/reports/spending?period=last-month&category=${ids.supermarkets}`,
  );
  await expect(page.getByTestId("transaction-row")).toHaveCount(1);
  await expect(page.getByTestId("transaction-row")).toContainText("PRISMA");

  await crumbs.getByRole("link", { name: "All categories" }).click();
  await expect(page).toHaveURL("/reports/spending?period=last-month");
  await expect(page.getByTestId("transaction-row")).toHaveCount(0);
});

test("shows monthly cash flow and this month on the dashboard", async ({
  page,
}) => {
  await page.goto("/reports/spending");
  await page
    .getByRole("navigation", { name: "Reports" })
    .getByRole("link", { name: "Cash flow" })
    .click();
  await expect(page).toHaveURL("/reports/cash-flow");

  const chart = page.getByTestId("cash-flow-chart");
  // Income and expense bars for both months, the net as a line.
  await expect(chart.locator(".recharts-bar-rectangle")).toHaveCount(4);
  await expect(chart.locator("path.recharts-line-curve")).toHaveCount(1);
  await chart.locator(".recharts-bar-rectangle").last().hover();
  await expect(page.locator(".recharts-tooltip-wrapper")).toContainText(
    "Savings rate",
  );

  const rows = page.getByTestId("cash-flow-row");
  await expect(rows).toHaveCount(12);
  // Newest first: 2 500 in, 75 out, 2 425 net, 97 % saved.
  await expect(rows.nth(0)).toContainText(eur("2 500,00"));
  await expect(rows.nth(0)).toContainText(eur("75,00"));
  await expect(rows.nth(0)).toContainText(eur("2 425,00"));
  await expect(rows.nth(0)).toContainText("97 %");
  await expect(rows.nth(1)).toContainText(eur("2 400,00"));
  await expect(rows.nth(1)).toContainText(eur("110,00"));

  // Last month is in this year unless this is January.
  const sameYear = lastMonth.slice(0, 4) === thisMonth.slice(0, 4);
  const ytd = page.getByRole("region", { name: /^Year to date/ });
  await expect(
    ytd
      .getByRole("region", { name: "Income", exact: true })
      .getByTestId("tile-amount"),
  ).toHaveText(eur(sameYear ? "4 900,00" : "2 500,00"));
  await expect(
    ytd
      .getByRole("region", { name: "Net", exact: true })
      .getByTestId("tile-amount"),
  ).toHaveText(eur(sameYear ? "4 715,00" : "2 425,00"));

  await page.goto("/");
  const tile = (name: string) =>
    page.getByRole("region", { name, exact: true }).getByTestId("tile-amount");
  await expect(tile("Income this month")).toHaveText(eur("2 500,00"));
  await expect(tile("Expenses this month")).toHaveText(eur("75,00"));
  await expect(tile("Net this month")).toHaveText(eur("2 425,00"));
  await page.getByRole("link", { name: "Cash flow report" }).click();
  await expect(page).toHaveURL("/reports/cash-flow");
});
