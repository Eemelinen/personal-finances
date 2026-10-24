import { eq } from "drizzle-orm";
import { expect, test, type Page } from "@playwright/test";
import { addDays, localDate } from "@/server/dates";
import { assets, fxRates, prices } from "@/server/db/schema";
import { E2E_TIME_ZONE, openTestDatabase } from "./support/database";

// /investments end to end: import the synthetic Nordnet export
// (tests/fixtures/nordnet/), read the summary and the holdings table valued
// at the trades' prices; then seed a closing price and a USD rate, as the
// price-update job would, and see the table and net worth use them; a second
// import adds nothing. Then a manual crypto holding (F-021) saved through
// the form, valued once a CoinGecko price is seeded. The test database is
// shared, so the dashboard checks look at their own accounts only.

const FIXTURE = "tests/fixtures/nordnet/transactions-utf16.csv";

// The tests count the holdings table's rows, which the crypto test adds to.
test.describe.configure({ mode: "serial" });

async function openInvestments(page: Page) {
  await page.goto("/investments");
  await expect(
    page.getByRole("heading", { level: 1, name: "Investments" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Import" })).toBeEnabled();
}

async function importFixture(page: Page) {
  await page.getByLabel("Nordnet CSV file").setInputFiles(FIXTURE);
  await page.getByRole("button", { name: "Import" }).click();
  const summary = page.getByTestId("nordnet-summary");
  await expect(summary).toBeVisible();
  return summary;
}

async function expectCounts(
  summary: ReturnType<Page["getByTestId"]>,
  expected: Record<string, number>,
) {
  for (const [label, value] of Object.entries(expected)) {
    await expect(
      summary
        .getByRole("term")
        .filter({ hasText: new RegExp(`^${label}$`) })
        .locator("xpath=following-sibling::dd"),
    ).toHaveText(String(value));
  }
}

function holding(page: Page, symbol: string) {
  return page
    .getByTestId("holding")
    .filter({ visible: true })
    .filter({
      has: page.getByRole("rowheader", { name: new RegExp(`^${symbol}`) }),
    });
}

test("imports a Nordnet export and lists the holdings", async ({ page }) => {
  await openInvestments(page);
  const summary = await importFixture(page);
  await expectCounts(summary, {
    "Rows read": 13,
    Inserted: 11,
    "Skipped as duplicates": 0,
    "Not recorded": 2,
    Errors: 0,
  });
  await expect(summary).toContainText("Accounts: Nordnet 99990001 (new)");
  await expect(summary).toContainText(
    "Row 5: VALUUTANVAIHTO: a currency exchange inside the account is not recorded",
  );

  // Valued at the trades' prices; USX has no USD rate yet.
  await expect(
    page.getByTestId("holding").filter({ visible: true }),
  ).toHaveCount(3);
  const aaa = holding(page, "AAA1");
  await expect(aaa.getByTestId("holding-quantity")).toHaveText("80");
  await expect(aaa.getByTestId("holding-price")).toHaveText(
    /^13,00\s€last trade, 7\.4\.2026$/,
  );
  await expect(aaa.getByTestId("holding-value")).toHaveText(/^1\s040,00\s€$/);
  // 80 units cost 1 033,40 € (average cost, fees included).
  await expect(aaa.getByTestId("holding-gain")).toHaveText(
    /^\+6,60\s€\+0,6\s%$/,
  );
  await expect(aaa.getByTestId("holding-weight")).toHaveText(/^70,3\s%$/);
  const fund = holding(page, "NORDNET INDEKSI ESIM");
  await expect(fund.getByTestId("holding-quantity")).toHaveText("3,235");
  await expect(fund.getByTestId("holding-value")).toHaveText(/^440,03\s€$/);
  const usx = holding(page, "USX");
  await expect(usx.getByTestId("holding-price")).toHaveText(
    /^50,00\s\$last trade, 10\.2\.2026$/,
  );
  await expect(usx.getByTestId("holding-value")).toHaveText("No FX rate");
  await expect(usx.getByTestId("holding-weight")).toHaveText("—");
  await expect(
    page.getByTestId("total-value").filter({ visible: true }),
  ).toHaveText(/^1\s480,03\s€$/);
  await expect(page.getByText("some holdings have no price yet")).toBeVisible();

  // What the daily price update stores: a close for AAA1 and a USD rate.
  const db = openTestDatabase();
  try {
    const yesterday = addDays(localDate(new Date(), E2E_TIME_ZONE), -1);
    const [aaaAsset] = await db
      .select()
      .from(assets)
      .where(eq(assets.symbol, "AAA1"));
    await db.insert(prices).values({
      assetId: aaaAsset.id,
      date: yesterday,
      priceMinor: "1500",
      currency: "EUR",
      source: "twelve_data",
    });
    await db
      .insert(fxRates)
      .values({ date: "2026-02-10", currency: "USD", rate: "1.1" });
  } finally {
    await db.$client.end();
  }

  await openInvestments(page);
  await expect(aaa.getByTestId("holding-price")).toContainText("closing price");
  await expect(aaa.getByTestId("holding-value")).toHaveText(/^1\s200,00\s€$/);
  await expect(aaa.getByTestId("holding-gain")).toHaveText(
    /^\+166,60\s€\+16,1\s%$/,
  );
  // 10 × 50,00 $ / 1,1 = 454,55 € against 470,00 €.
  await expect(usx.getByTestId("holding-value")).toHaveText(/^454,55\s€$/);
  await expect(usx.getByTestId("holding-gain")).toHaveText(
    /^−15,45\s€−3,3\s%$/,
  );
  await expect(
    page.getByTestId("total-value").filter({ visible: true }),
  ).toHaveText(/^2\s094,58\s€$/);
  await expect(page.getByText("some holdings have no price yet")).toBeHidden();

  // The same file again adds nothing.
  await expectCounts(await importFixture(page), {
    Inserted: 0,
    "Skipped as duplicates": 11,
  });
  await expect(
    page.getByTestId("holding").filter({ visible: true }),
  ).toHaveCount(3);

  // The dashboard counts the holdings in net worth.
  await page.goto("/");
  const account = page
    .getByRole("region", { name: "Nordnet" })
    .getByTestId("account")
    .filter({ hasText: "Nordnet 99990001" });
  await expect(account.getByTestId("account-balance")).toHaveText(
    /^2\s094,58\s€$/,
  );
  await expect(account.getByTestId("account-holdings")).toHaveText(
    "in holdings",
  );
});

test("rejects a file that is not a Nordnet export", async ({ page }) => {
  await openInvestments(page);
  await page
    .getByLabel("Nordnet CSV file")
    .setInputFiles("tests/fixtures/csv/nordea.csv");
  await page.getByRole("button", { name: "Import" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "not a Nordnet" }),
  ).toHaveText(
    "This is not a Nordnet transaction export: no header row with Tapahtumatyyppi, Summa and a date was found.",
  );
});

test("adds a manual crypto holding and values it", async ({ page }) => {
  await openInvestments(page);
  const form = page.getByRole("region", { name: "Add a crypto holding" });
  const save = form.getByRole("button", { name: "Save holding" });
  await expect(save).toBeEnabled();

  // A refused quantity keeps what was typed.
  await form.getByLabel("Wallet").fill("Ledger");
  await form.getByLabel("Coin symbol").fill("btc");
  await form.getByLabel("Quantity").fill("-1");
  await save.click();
  await expect(form.getByRole("alert")).toHaveText(
    "The quantity cannot be negative.",
  );
  await expect(form.getByLabel("Wallet")).toHaveValue("Ledger");

  await form.getByLabel("Quantity").fill("0,5");
  await save.click();
  await expect(form.getByRole("status")).toHaveText("Saved 0.5 BTC in Ledger.");
  await expect(form.getByLabel("Wallet")).toHaveValue("");
  const btc = holding(page, "BTC");
  await expect(btc).toContainText("Bitcoin");
  await expect(btc.getByTestId("holding-quantity")).toHaveText("0,5");
  await expect(btc.getByTestId("holding-price")).toHaveText("No price");

  // What the daily price update stores from CoinGecko.
  const today = localDate(new Date(), E2E_TIME_ZONE);
  const db = openTestDatabase();
  try {
    const [btcAsset] = await db
      .select()
      .from(assets)
      .where(eq(assets.coingeckoId, "bitcoin"));
    await db.insert(prices).values({
      assetId: btcAsset.id,
      date: today,
      priceMinor: "6000050",
      currency: "EUR",
      source: "coingecko",
    });
  } finally {
    await db.$client.end();
  }

  await openInvestments(page);
  const [year, month, day] = today.split("-").map(Number);
  await expect(btc.getByTestId("holding-price")).toHaveText(
    new RegExp(`^60\\s000,50\\s€market price, ${day}\\.${month}\\.${year}$`),
  );
  await expect(btc.getByTestId("holding-value")).toHaveText(/^30\s000,25\s€$/);

  // The wallet counts in net worth.
  await page.goto("/");
  const wallet = page
    .getByRole("region", { name: "Manual" })
    .getByTestId("account")
    .filter({ hasText: "Ledger" });
  await expect(wallet.getByTestId("account-balance")).toHaveText(
    /^30\s000,25\s€$/,
  );
});
