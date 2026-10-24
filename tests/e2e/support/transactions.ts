import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

// Test data for the /transactions specs: every test imports its own rows
// (a Nordea-layout CSV) into a new manual account through /import and then
// filters /transactions to that account, so tests running in parallel never
// see each other's rows. Amounts of debits and credits differ, and the days
// are far from other specs' fixtures, so transfer detection never pairs
// rows of different tests.

/** A short random tag that makes names and texts unique to one test. */
export function uniqueTag(): string {
  return randomUUID().slice(0, 8);
}

export interface CsvRow {
  /** `dd.mm.yyyy` */
  date: string;
  /** Finnish amount, e.g. `-4,50` */
  amount: string;
  counterparty: string;
  description: string;
}

export function nordeaCsv(rows: readonly CsvRow[]): Buffer {
  const lines = ["Kirjauspäivä;Määrä;Saaja/Maksaja;Viesti"];
  for (const row of rows) {
    lines.push(
      [row.date, row.amount, row.counterparty, row.description].join(";"),
    );
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

/** Imports the rows into a new manual account; returns its name. */
export async function importIntoNewAccount(
  page: Page,
  tag: string,
  rows: readonly CsvRow[],
): Promise<string> {
  const accountName = `Tx e2e ${tag}`;
  await page.goto("/import");
  await expect(page.getByRole("button", { name: "Preview" })).toBeEnabled();
  await page.getByLabel("CSV file").setInputFiles({
    name: `${tag}.csv`,
    mimeType: "text/csv",
    buffer: nordeaCsv(rows),
  });
  await page.getByRole("button", { name: "Preview" }).click();
  await page
    .getByLabel("Account", { exact: true })
    .selectOption({ label: "New manual account…" });
  await page.getByLabel("New account name").fill(accountName);
  await page
    .getByRole("button", {
      name: `Import ${rows.length} ${rows.length === 1 ? "row" : "rows"}`,
    })
    .click();
  const summary = page.getByTestId("import-summary");
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await expect(
    summary
      .getByRole("term")
      .filter({ hasText: /^Inserted$/ })
      .locator("xpath=following-sibling::dd"),
  ).toHaveText(String(rows.length));
  return accountName;
}

/**
 * Opens /transactions filtered to the account through the filter form and
 * returns that URL (it carries the account id).
 */
export async function openAccount(
  page: Page,
  accountName: string,
): Promise<URL> {
  await page.goto("/transactions");
  const filters = page.getByRole("form", { name: "Filters" });
  await filters.getByLabel(accountName).check();
  await filters.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/[?&]account=[0-9a-f-]{36}/);
  return new URL(page.url());
}

export function transactionsTable(page: Page) {
  return page.getByRole("table", { name: "Transactions" });
}

/** The body row whose text contains `text`. */
export function transactionRow(page: Page, text: string) {
  return transactionsTable(page).getByRole("row").filter({ hasText: text });
}

export function totals(page: Page) {
  return page.getByRole("region", { name: "Totals" });
}

/** The value next to a term (`Income`, `Expenses`, `Net`) in the totals. */
export function total(page: Page, term: string) {
  return totals(page)
    .getByRole("term")
    .filter({ hasText: new RegExp(`^${term}$`) })
    .locator("xpath=following-sibling::dd");
}

const money = new Intl.NumberFormat("fi-FI", {
  style: "currency",
  currency: "EUR",
});

/** What the app shows for an amount in cents (`fi-FI`). */
export function euros(minor: number): string {
  return money.format(minor / 100);
}
