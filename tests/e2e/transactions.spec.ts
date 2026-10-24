import { expect, test, type Page } from "@playwright/test";
import { openTestDatabase } from "./support/database";
import { seedPendingFixture } from "./support/fixtures";
import {
  euros,
  importIntoNewAccount,
  openAccount,
  total,
  totals,
  transactionRow,
  transactionsTable,
  uniqueTag,
  type CsvRow,
} from "./support/transactions";

// /transactions end to end (F-015): filters live in the URL, the category
// changes inline (manual), notes, one-sided transfers, excluding from
// reports (F-027), rules created from a transaction, and paging through more
// than 10 000 rows. The server seeds
// the default categories and rules, so "Salary" and "rent" texts are
// categorised on import.

function rows(tag: string): CsvRow[] {
  return [
    {
      date: "02.03.2024",
      amount: "-4,50",
      counterparty: `Zyx Kiosk ${tag}`,
      description: "Coffee",
    },
    {
      date: "05.03.2024",
      amount: "-7,20",
      counterparty: `Zyx Kiosk ${tag}`,
      description: "Snack",
    },
    {
      date: "09.03.2024",
      amount: "-6,10",
      counterparty: `Zyx Kiosk ${tag}`,
      description: "Bun",
    },
    {
      date: "12.03.2024",
      amount: "+2345,67",
      counterparty: `Employer ${tag}`,
      description: "Salary March",
    },
    {
      date: "15.03.2024",
      amount: "-150,00",
      counterparty: `Landlord ${tag}`,
      description: "Rent part",
    },
    {
      date: "20.04.2024",
      amount: "-33,30",
      counterparty: `Bookshop ${tag}`,
      description: "Novel",
    },
  ];
}

async function setUp(page: Page) {
  const tag = uniqueTag();
  const account = await importIntoNewAccount(page, tag, rows(tag));
  const url = await openAccount(page, account);
  return { tag, url };
}

function withParams(url: URL, params: Record<string, string>): string {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    next.searchParams.set(key, value);
  }
  return `${next.pathname}${next.search}`;
}

const bodyRows = (page: Page) =>
  transactionsTable(page)
    .getByRole("row")
    .filter({ hasNot: page.getByRole("columnheader") });

async function expectRowCount(page: Page, count: number) {
  await expect(bodyRows(page)).toHaveCount(count);
  await expect(totals(page)).toContainText(
    `${count} ${count === 1 ? "transaction" : "transactions"}`,
  );
}

test("filters live in the URL", async ({ page }) => {
  const { url } = await setUp(page);
  await expectRowCount(page, 6);
  await expect(total(page, "Income")).toHaveText(euros(234_567));
  await expect(total(page, "Expenses")).toHaveText(euros(-20_110));
  await expect(total(page, "Net")).toHaveText(euros(214_457));
  // Rules seeded with the app categorised these on import.
  await expect(
    transactionRow(page, "Salary March")
      .getByLabel("Category")
      .locator("option:checked"),
  ).toHaveText("Income › Salary");

  // A URL typed or shared by hand: the page and the form follow it.
  await page.goto(withParams(url, { type: "expense", q: "kiosk" }));
  await expectRowCount(page, 3);
  await expect(total(page, "Expenses")).toHaveText(euros(-1_780));
  const filters = page.getByRole("form", { name: "Filters" });
  await expect(filters.getByLabel("Search")).toHaveValue("kiosk");
  await expect(filters.getByLabel("Income or expense")).toHaveValue("expense");

  // Changing the form changes the URL; a reload keeps the result.
  await filters.getByLabel("From", { exact: true }).fill("2024-03-05");
  await filters.getByLabel("To", { exact: true }).fill("2024-03-31");
  await filters.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/from=2024-03-05/);
  await expect(page).toHaveURL(/to=2024-03-31/);
  await expect(page).toHaveURL(/q=kiosk/);
  await expectRowCount(page, 2);
  await page.reload();
  await expectRowCount(page, 2);
  await expect(bodyRows(page).last()).toContainText("5.3.2024");

  // A top-level category includes its subcategories.
  await page.goto(`${url.pathname}${url.search}`);
  await filters
    .getByLabel("Category", { exact: true })
    .selectOption({ label: "Income" });
  await filters.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/category=[0-9a-f-]{36}/);
  await expectRowCount(page, 1);
  await expect(bodyRows(page)).toContainText("Salary March");

  await page.goto(withParams(url, { category: "none" }));
  await expectRowCount(page, 4);

  await page.goto(withParams(url, { transfers: "only" }));
  await expect(
    page.getByText("No transactions match the filters."),
  ).toBeVisible();
  await expect(totals(page)).toContainText("0 transactions");

  // Unparsable values are ignored rather than failing the page.
  await page.goto(
    withParams(url, { from: "yesterday", type: "both", page: "-3" }),
  );
  await expectRowCount(page, 6);
});

test("an inline category change is manual and persists", async ({ page }) => {
  await setUp(page);
  const coffee = transactionRow(page, "Coffee");
  await expect(coffee.getByTestId("category-source")).toHaveText("");
  await coffee
    .getByLabel("Category")
    .selectOption({ label: "Groceries › Supermarkets" });
  await expect(coffee.getByTestId("category-source")).toHaveText("Manual");

  await page.reload();
  const reloaded = transactionRow(page, "Coffee");
  await expect(
    reloaded.getByLabel("Category").locator("option:checked"),
  ).toHaveText("Groceries › Supermarkets");
  await expect(reloaded.getByTestId("category-source")).toHaveText("Manual");

  // A manual category on a rule-categorised row, then back to the rules.
  const salary = transactionRow(page, "Salary March");
  await expect(salary.getByTestId("category-source")).toHaveText("Rule");
  await salary.getByLabel("Category").selectOption({ label: "Uncategorized" });
  await expect(salary.getByTestId("category-source")).toHaveText("Manual");
  await salary
    .getByLabel("Category")
    .selectOption({ label: "Automatic (rules)" });
  await expect(salary.getByTestId("category-source")).toHaveText("Rule");
  await expect(
    salary.getByLabel("Category").locator("option:checked"),
  ).toHaveText("Income › Salary");
});

test("creates a rule from a transaction and applies it to similar past ones", async ({
  page,
}) => {
  const { tag } = await setUp(page);
  // A manual category is never overwritten by a rule.
  await transactionRow(page, "Coffee")
    .getByLabel("Category")
    .selectOption({ label: "Groceries › Supermarkets" });
  await expect(
    transactionRow(page, "Coffee").getByTestId("category-source"),
  ).toHaveText("Manual");

  await transactionRow(page, "Snack")
    .getByRole("button", { name: "Details" })
    .click();
  const sheet = page.getByRole("dialog");
  await expect(
    sheet.getByRole("heading", { name: `Zyx Kiosk ${tag}` }),
  ).toBeVisible();
  await expect(sheet.getByLabel("Match field")).toHaveValue("counterparty");
  await expect(sheet.getByLabel("Pattern")).toHaveValue(`Zyx Kiosk ${tag}`);
  await expect(
    sheet.getByLabel("Apply to similar past transactions"),
  ).toBeChecked();
  await sheet
    .getByLabel("Rule category")
    .selectOption({ label: "Restaurants & cafés › Cafés" });
  await sheet.getByRole("button", { name: "Create rule" }).click();
  await expect(sheet.getByRole("status")).toHaveText(
    /^Rule created\. \d+ transactions? re-categorised\.$/,
  );
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  for (const text of ["Snack", "Bun"]) {
    const row = transactionRow(page, text);
    await expect(
      row.getByLabel("Category").locator("option:checked"),
    ).toHaveText("Restaurants & cafés › Cafés");
    await expect(row.getByTestId("category-source")).toHaveText("Rule");
  }
  const coffee = transactionRow(page, "Coffee");
  await expect(
    coffee.getByLabel("Category").locator("option:checked"),
  ).toHaveText("Groceries › Supermarkets");
  await expect(coffee.getByTestId("category-source")).toHaveText("Manual");

  await page.goto("/settings/categories");
  await expect(
    page
      .getByRole("table", { name: "Rules" })
      .getByRole("row")
      .filter({ hasText: `Zyx Kiosk ${tag}` }),
  ).toContainText("Restaurants & cafés › Cafés");
});

test("adds a note and marks and unlinks a one-sided transfer", async ({
  page,
}) => {
  const { tag, url } = await setUp(page);
  const note = `Gift for ${tag}`;
  await transactionRow(page, "Novel")
    .getByRole("button", { name: "Details" })
    .click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Note").fill(note);
  await sheet.getByRole("button", { name: "Save note" }).click();
  await expect(sheet.getByText("Note saved.")).toBeVisible();
  await sheet.getByRole("button", { name: "Mark as transfer" }).click();
  await expect(sheet.getByText("Marked as a transfer.")).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Unlink transfer" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const novel = transactionRow(page, "Novel");
  await expect(novel).toContainText(note);
  await expect(novel.getByText("Transfer", { exact: true })).toBeVisible();
  await expect(
    novel.getByLabel("Category").locator("option:checked"),
  ).toHaveText("Transfers");
  await expect(novel.getByTestId("category-source")).toHaveText("Manual");

  // The note is searchable; the transfer filters see the mark.
  await page.goto(withParams(url, { q: "gift for" }));
  await expectRowCount(page, 1);
  await page.goto(withParams(url, { transfers: "only" }));
  await expectRowCount(page, 1);
  await expect(bodyRows(page)).toContainText("Novel");
  await page.goto(withParams(url, { transfers: "exclude" }));
  await expectRowCount(page, 5);

  // A re-apply of every rule keeps the manual transfer.
  await page.goto("/settings/categories");
  await page
    .getByRole("button", { name: "Re-apply rules to all transactions" })
    .click();
  await expect(page.getByText(/^Rules re-applied:/)).toBeVisible();
  await page.goto(withParams(url, { transfers: "only" }));
  await expectRowCount(page, 1);

  // Unlinked, the row would leave an "only transfers" list (and the sheet).
  await page.goto(withParams(url, { q: "Novel" }));
  await transactionRow(page, "Novel")
    .getByRole("button", { name: "Details" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Unlink transfer" })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Transfer unlinked."),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  const unlinked = transactionRow(page, "Novel");
  await expect(unlinked.getByText("Transfer", { exact: true })).toHaveCount(0);
  await expect(
    unlinked.getByLabel("Category").locator("option:checked"),
  ).toHaveText("No category");
  await expect(unlinked.getByTestId("category-source")).toHaveText("Manual");
});

test("excludes a transaction from its details, with a badge and a filter, and includes it again", async ({
  page,
}) => {
  const { url } = await setUp(page);
  await transactionRow(page, "Salary March")
    .getByRole("button", { name: "Details" })
    .click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Exclude from reports" }).click();
  await expect(sheet.getByText("Excluded from reports.")).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Include again" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // Still listed, with a badge, in the manual Excluded category.
  await expectRowCount(page, 6);
  const salary = transactionRow(page, "Salary March");
  await expect(
    salary.locator("span").getByText("Excluded", { exact: true }),
  ).toBeVisible();
  await expect(
    salary.getByLabel("Category").locator("option:checked"),
  ).toHaveText("Excluded");
  await expect(salary.getByTestId("category-source")).toHaveText("Manual");
  await expect(
    transactionRow(page, "Novel")
      .locator("span")
      .getByText("Excluded", { exact: true }),
  ).toHaveCount(0);

  // The filter: only excluded ones, or everything else.
  await page.goto(withParams(url, { excluded: "only" }));
  await expectRowCount(page, 1);
  await expect(bodyRows(page)).toContainText("Salary March");
  const filters = page.getByRole("form", { name: "Filters" });
  await expect(filters.getByLabel("Excluded", { exact: true })).toHaveValue(
    "only",
  );
  await filters
    .getByLabel("Excluded", { exact: true })
    .selectOption({ label: "Not excluded" });
  await filters.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/excluded=exclude/);
  await expectRowCount(page, 5);
  await expect(bodyRows(page)).not.toContainText(["Salary March"]);

  // Include again: back to the rules, which make it salary again. (In the
  // "excluded only" view the row, and the sheet, would go away.)
  await page.goto(`${url.pathname}${url.search}`);
  await transactionRow(page, "Salary March")
    .getByRole("button", { name: "Details" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Include again" })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Included in reports again."),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  const included = transactionRow(page, "Salary March");
  await expect(
    included.locator("span").getByText("Excluded", { exact: true }),
  ).toHaveCount(0);
  await expect(
    included.getByLabel("Category").locator("option:checked"),
  ).toHaveText("Income › Salary");
  await expect(included.getByTestId("category-source")).toHaveText("Rule");
  await page.goto(withParams(url, { excluded: "only" }));
  await expect(
    page.getByText("No transactions match the filters."),
  ).toBeVisible();
});

test("pages through more than 10 000 transactions with totals for the filter", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const tag = uniqueTag();
  const count = 10_030;
  const bulk: CsvRow[] = [];
  let expense = 0;
  for (let i = 0; i < count; i++) {
    // 20 a day from 1.1.2019, only debits.
    const day = new Date(Date.UTC(2019, 0, 1 + Math.floor(i / 20)));
    const cents = 100 + (i % 900);
    expense -= cents;
    bulk.push({
      date: `${day.getUTCDate()}.${day.getUTCMonth() + 1}.${day.getUTCFullYear()}`,
      amount: `-${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`,
      counterparty: `Bulk ${tag} ${i}`,
      description: "Bulk",
    });
  }
  const account = await importIntoNewAccount(page, tag, bulk);
  await openAccount(page, account);

  await expect(bodyRows(page)).toHaveCount(50);
  await expect(totals(page)).toContainText(`${count} transactions`);
  await expect(total(page, "Expenses")).toHaveText(euros(expense));
  await expect(total(page, "Income")).toHaveText(euros(0));
  const pagination = page.getByRole("navigation", { name: "Pagination" });
  await expect(pagination).toContainText("Page 1 of 201");
  await expect(bodyRows(page).first()).toContainText(bulk.at(-1)!.date);

  await pagination.getByRole("link", { name: "Last" }).click();
  await expect(page).toHaveURL(/page=201/);
  await expect(pagination).toContainText("Page 201 of 201");
  await expect(bodyRows(page)).toHaveCount(30);
  await expect(bodyRows(page).last()).toContainText("1.1.2019");
  // Totals are for the whole filter, not the page.
  await expect(totals(page)).toContainText(`${count} transactions`);

  await pagination.getByRole("link", { name: "Previous" }).click();
  await expect(pagination).toContainText("Page 200 of 201");
  await expect(bodyRows(page)).toHaveCount(50);

  // A page past the end shows the last one.
  const past = new URL(page.url());
  past.searchParams.set("page", "999");
  await page.goto(`${past.pathname}${past.search}`);
  await expect(pagination).toContainText("Page 201 of 201");
});

test("marks pending transactions with a badge", async ({ page }) => {
  // One booked and one pending row, seeded directly (support/fixtures.ts).
  const account = `E2E fixture pending ${uniqueTag()}`;
  const db = openTestDatabase();
  try {
    await seedPendingFixture(db, account);
  } finally {
    await db.$client.end();
  }
  await openAccount(page, account);
  await expectRowCount(page, 2);
  await expect(
    transactionRow(page, "Card reservation fixture").getByText("Pending", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    transactionRow(page, "Corner shop fixture").getByText("Pending", {
      exact: true,
    }),
  ).toHaveCount(0);
  // Pending ones count in the totals.
  await expect(total(page, "Expenses")).toHaveText(euros(-9_999));

  // The details show the counterparty's account number when known (F-028).
  await transactionRow(page, "Corner shop fixture")
    .getByRole("button", { name: "Details" })
    .click();
  await expect(
    page.getByRole("dialog").getByTestId("counterparty-iban"),
  ).toHaveText("FI21 1234 5600 0007 85");
  await page.keyboard.press("Escape");
  await transactionRow(page, "Card reservation fixture")
    .getByRole("button", { name: "Details" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").getByTestId("counterparty-iban"),
  ).toHaveCount(0);
});
