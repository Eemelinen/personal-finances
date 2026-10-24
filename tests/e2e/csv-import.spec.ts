import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { createManualAccount } from "@/server/csv/import-csv";
import { accounts, transactions } from "@/server/db/schema";
import { openTestDatabase } from "./support/database";

// /import end to end: upload a synthetic export (tests/fixtures/csv/), check
// the preview, import it into a new manual account and read the summary;
// a second import of the same file skips every row as a duplicate. An
// account the bank already synced shows, before the import, how many of the
// file's rows it has (F-032).

const FIXTURES = "tests/fixtures/csv";

/** Opens /import and waits for hydration (Preview is disabled before it). */
async function openImport(page: Page) {
  await page.goto("/import");
  await expect(
    page.getByRole("heading", { level: 1, name: "Import" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview" })).toBeEnabled();
}

async function preview(
  page: Page,
  file: Parameters<Locator["setInputFiles"]>[0],
) {
  await openImport(page);
  await page.getByLabel("CSV file").setInputFiles(file);
  await page.getByRole("button", { name: "Preview" }).click();
}

async function intoNewAccount(page: Page, prefix: string): Promise<string> {
  const name = `${prefix} ${randomUUID().slice(0, 8)}`;
  await page
    .getByLabel("Account", { exact: true })
    .selectOption({ label: "New manual account…" });
  await page.getByLabel("New account name").fill(name);
  return name;
}

async function expectSummary(
  page: Page,
  expected: {
    rowsRead: number;
    inserted: number;
    duplicates: number;
    errors: number;
  },
) {
  const summary = page.getByTestId("import-summary");
  await expect(summary).toBeVisible();
  const value = (label: string) =>
    summary
      .getByRole("term")
      .filter({ hasText: new RegExp(`^${label}$`) })
      .locator("xpath=following-sibling::dd");
  await expect(value("Rows read")).toHaveText(String(expected.rowsRead));
  await expect(value("Inserted")).toHaveText(String(expected.inserted));
  await expect(value("Skipped as duplicates")).toHaveText(
    String(expected.duplicates),
  );
  await expect(value("Errors")).toHaveText(String(expected.errors));
  return summary;
}

test("imports a Nordea export once and skips it the second time", async ({
  page,
}) => {
  await preview(page, `${FIXTURES}/nordea.csv`);
  await expect(page.getByTestId("csv-detected")).toHaveText(
    "nordea.csv: Nordea, Windows-1252, 6 rows, 6 readable, 0 with errors.",
  );
  const table = page.getByRole("table");
  // Header + six rows, Windows-1252 letters decoded, fi-FI amounts.
  await expect(table.getByRole("row")).toHaveCount(7);
  const row = table.getByRole("row").filter({ hasText: "Lähikauppa Öljymäki" });
  await expect(row).toContainText("20.1.2026");
  await expect(row).toContainText(/[-−]1\s234,56\s€/);
  await expect(table).toContainText("Kuukausimaksu 12,90 € – ½ hinnalla");

  const name = await intoNewAccount(page, "Nordea e2e");
  await page.getByRole("button", { name: "Import 6 rows" }).click();
  await expectSummary(page, {
    rowsRead: 6,
    inserted: 6,
    duplicates: 0,
    errors: 0,
  });

  // The new account is now chosen; the same file adds nothing.
  await expect(
    page.getByLabel("Account", { exact: true }).locator("option:checked"),
  ).toHaveText(`Nordea · ${name} (manual)`);
  await page.getByRole("button", { name: "Import 6 rows" }).click();
  await expectSummary(page, {
    rowsRead: 6,
    inserted: 0,
    duplicates: 6,
    errors: 0,
  });

  // A fresh page offers the account with the others.
  await preview(page, `${FIXTURES}/nordea.csv`);
  await expect(
    page.getByLabel("Account", { exact: true }).getByRole("option", {
      name: `Nordea · ${name} (manual)`,
    }),
  ).toBeAttached();
});

test("shows how many rows a synced account already has", async ({ page }) => {
  // Four of nordea.csv's six rows as the bank's API stored them: other
  // texts, refs, the salary and a purchase booked a day later.
  const name = `Synced e2e ${randomUUID().slice(0, 8)}`;
  const db = openTestDatabase();
  try {
    const accountId = await createManualAccount(
      { name, type: "checking", format: "nordea" },
      { db },
    );
    await db
      .update(accounts)
      .set({ providerAccountRef: `e2e-${accountId}` })
      .where(eq(accounts.id, accountId));
    const bank = (
      ref: string,
      bookingDate: string,
      valueDate: string,
      amountMinor: number,
      counterparty: string,
    ) => ({
      accountId,
      providerTxnRef: `${accountId}:${ref}`,
      dedupeHash: `${accountId}:${ref}`,
      bookingDate,
      valueDate,
      amountMinor,
      currency: "EUR",
      counterparty,
      source: "bank" as const,
    });
    await db
      .insert(transactions)
      .values([
        bank("rent", "2026-01-02", "2026-01-02", -95_000, "ESIMERKKI ASUNNOT"),
        bank("coffee", "2026-01-05", "2026-01-04", -450, "KAHVILA MAARANPAA"),
        bank("salary", "2026-01-16", "2026-01-15", 350_000, "TYONANTAJA OY"),
        bank("shop", "2026-01-21", "2026-01-21", -123_456, "LAHIKAUPPA"),
      ]);
  } finally {
    await db.$client.end();
  }

  await preview(page, `${FIXTURES}/nordea.csv`);
  await page
    .getByLabel("Account", { exact: true })
    .selectOption({ label: `Nordea · ${name} (manual)` });
  const match = page.getByTestId("csv-match");
  await expect(match).toHaveText("4 already in the app, 2 new, 0 errors.");
  await page
    .getByLabel("Account", { exact: true })
    .selectOption({ label: "New manual account…" });
  await expect(match).toHaveText("0 already in the app, 6 new, 0 errors.");
  await page
    .getByLabel("Account", { exact: true })
    .selectOption({ label: `Nordea · ${name} (manual)` });
  await expect(match).toHaveText("4 already in the app, 2 new, 0 errors.");

  await page.getByRole("button", { name: "Import 6 rows" }).click();
  await expectSummary(page, {
    rowsRead: 6,
    inserted: 2,
    duplicates: 4,
    errors: 0,
  });
  await expect(match).toHaveText("6 already in the app, 0 new, 0 errors.");
});

test("lists unreadable S-Pankki rows by row number and imports the rest", async ({
  page,
}) => {
  await preview(page, `${FIXTURES}/s-pankki-errors.csv`);
  await expect(page.getByTestId("csv-detected")).toHaveText(
    "s-pankki-errors.csv: S-Pankki, UTF-8, 5 rows, 2 readable, 3 with errors.",
  );
  await expect(
    page.getByText('Row 3: Invalid booking date: "31.02.2026"'),
  ).toBeVisible();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(3);

  await intoNewAccount(page, "S-Pankki e2e");
  await page.getByRole("button", { name: "Import 2 rows" }).click();
  const summary = await expectSummary(page, {
    rowsRead: 5,
    inserted: 2,
    duplicates: 0,
    errors: 3,
  });
  await expect(summary.getByRole("listitem")).toHaveText([
    'Row 3: Invalid booking date: "31.02.2026"',
    'Row 4: Not an amount: "kymmenen"',
    "Row 5: The amount is empty",
  ]);
});

test("imports another CSV with chosen columns", async ({ page }) => {
  await preview(page, {
    name: "other-bank.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "When;How much;Who;What\n1.4.2026;-5,00;Kiosk;Snacks\n2.4.2026;+100,00;Friend;Paid back\n",
    ),
  });
  await expect(
    page.getByText(
      "Choose the date and amount columns, then update the preview.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Import/ })).toBeHidden();

  await page.getByLabel("Date column").selectOption("When");
  await page.getByLabel("Amount column").selectOption("How much");
  await page.getByLabel("Counterparty column").selectOption("Who");
  await page.getByRole("button", { name: "Update preview" }).click();
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("row").nth(1)).toContainText("Kiosk");
  await expect(table.getByRole("row").nth(1)).not.toContainText("Snacks");

  await intoNewAccount(page, "Other e2e");
  await page.getByRole("button", { name: "Import 2 rows" }).click();
  await expectSummary(page, {
    rowsRead: 2,
    inserted: 2,
    duplicates: 0,
    errors: 0,
  });
});

test("rejects a file that is not the chosen bank's export", async ({
  page,
}) => {
  await openImport(page);
  await page.getByLabel("CSV file").setInputFiles(`${FIXTURES}/s-pankki.csv`);
  await page.getByLabel("Format").selectOption("Nordea");
  await page.getByRole("button", { name: "Preview" }).click();
  // Next.js' route announcer is an alert too.
  await expect(
    page.getByRole("alert").filter({ hasText: "not a Nordea export" }),
  ).toHaveText("This is not a Nordea export: its header row was not found.");
  await expect(page.getByRole("table")).toBeHidden();
});

test("previews a file larger than the default 1 MB action limit", async ({
  page,
}) => {
  const lines = ["Kirjauspäivä;Määrä;Saaja/Maksaja;Viesti"];
  for (let i = 0; i < 40_000; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    lines.push(`${day}.01.2026;-${i % 100},50;Kauppa ${i};Ostos numero ${i}`);
  }
  const buffer = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  expect(buffer.length).toBeGreaterThan(1.2 * 1024 * 1024);

  await preview(page, { name: "large.csv", mimeType: "text/csv", buffer });
  await expect(page.getByTestId("csv-detected")).toHaveText(
    "large.csv: Nordea, UTF-8, 40000 rows, 40000 readable, 0 with errors.",
  );
  await expect(page.getByRole("table")).toContainText(
    "The first 200 of 40000 rows",
  );
  await expect(
    page.getByRole("button", { name: "Import 40000 rows" }),
  ).toBeVisible();
});
