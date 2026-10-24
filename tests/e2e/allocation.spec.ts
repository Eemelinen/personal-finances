import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { Db } from "@/server/db/client";
import {
  accounts,
  assets,
  holdings,
  institutions,
  investmentTransactions,
  prices,
} from "@/server/db/schema";
import { addDays, localDate } from "@/server/dates";
import { daysBetween, rangeStart } from "@/server/reports/balance-series";
import { E2E_TIME_ZONE, openTestDatabase } from "./support/database";

// Allocation and performance end to end (F-022): a brokerage portfolio
// without a synced balance (as a Nordnet import: cash from its transactions)
// and a manual crypto wallet, seeded straight into the test database, valued
// with the prices of each day. The allocation shows them by asset class and
// by account, the performance per account splits contributions from the
// market gain, and the balance history and the dashboard count them in net
// worth. Other specs' accounts are in the database too (this project runs
// last), so only this spec's accounts are asserted to the cent.

test.describe.configure({ mode: "serial" });

const PORTFOLIO = "E2E Salkku";
const WALLET = "E2E Lompakko";
const BANK = "E2E Allokaatiopankki";

let db: Db;
let today: string;

test.beforeAll(async () => {
  db = openTestDatabase();
  today = localDate(new Date(), E2E_TIME_ZONE);
  const ago = (days: number) => addDays(today, -days);
  const institution = async (name: string, provider: string) => {
    const [row] = await db
      .insert(institutions)
      .values({
        name,
        country: "FI",
        provider,
        providerRef: `e2e-${randomUUID()}`,
      })
      .returning();
    return row;
  };
  const bank = await institution(BANK, "csv");
  const manual = await institution("E2E Manuaali", "manual");
  const [portfolio, wallet] = await db
    .insert(accounts)
    .values([
      {
        institutionId: bank.id,
        type: "brokerage",
        name: PORTFOLIO,
        currency: "EUR",
      },
      {
        institutionId: manual.id,
        type: "crypto",
        name: WALLET,
        currency: "EUR",
      },
    ])
    .returning();
  const [stock, fund, coin] = await db
    .insert(assets)
    .values([
      { symbol: "E2EALLOC", assetClass: "stock", currency: "EUR" },
      { symbol: "E2E RAHASTO", assetClass: "fund", currency: "EUR" },
      { symbol: "E2ECOIN", assetClass: "crypto", currency: "EUR" },
    ])
    .returning();

  // 10 000,00 in; 100 shares at 50,00 and 10 fund units at 100,00 bought
  // at their closes; the shares close at 60,00 five days ago.
  await db.insert(investmentTransactions).values(
    (
      [
        [60, "transfer", null, null, 1_000_000],
        [50, "buy", stock.id, "100", -500_000],
        [40, "buy", fund.id, "10", -100_000],
      ] as const
    ).map(([daysAgo, type, assetId, quantity, amountMinor]) => ({
      accountId: portfolio.id,
      type,
      assetId,
      quantity,
      amountMinor,
      currency: "EUR",
      tradeDate: ago(daysAgo),
      dedupeHash: `e2e-${randomUUID()}`,
    })),
  );
  // The wallet: 2 coins from 20 days ago, at 100,00 then 150,00.
  await db.insert(holdings).values([
    {
      accountId: portfolio.id,
      assetId: stock.id,
      date: ago(50),
      quantity: "100",
    },
    {
      accountId: portfolio.id,
      assetId: fund.id,
      date: ago(40),
      quantity: "10",
    },
    { accountId: wallet.id, assetId: coin.id, date: ago(20), quantity: "2" },
  ]);
  await db.insert(prices).values(
    (
      [
        [stock.id, 50, "5000"],
        [stock.id, 5, "6000"],
        [fund.id, 40, "10000"],
        [coin.id, 20, "10000"],
        [coin.id, 2, "15000"],
      ] as const
    ).map(([assetId, daysAgo, priceMinor]) => ({
      assetId,
      date: ago(daysAgo),
      priceMinor,
      currency: "EUR",
      source: "twelve_data",
    })),
  );
});

test.afterAll(async () => {
  await db?.$client.end();
});

const money = (text: string) =>
  new RegExp(`^${text.replace(/ /g, "\\s").replace("+", "\\+")}\\s€$`);

function accountRow(page: Page, name: string) {
  return page
    .getByRole("region", { name: "By account" })
    .getByTestId("allocation-account")
    .filter({
      has: page.getByRole("rowheader", { name: new RegExp(`^${name}`) }),
    });
}

test("shows the allocation by asset class and by account", async ({ page }) => {
  await page.goto("/reports");
  await page.getByRole("link", { name: /^Allocation/ }).click();
  await expect(page).toHaveURL("/reports/allocation");
  await expect(
    page.getByRole("navigation", { name: "Reports" }).getByRole("link", {
      name: "Allocation",
    }),
  ).toHaveAttribute("aria-current", "page");

  const classes = page.getByRole("region", { name: "By asset class" });
  for (const name of ["Cash", "Stocks and ETFs", "Funds", "Crypto"]) {
    await expect(classes.getByRole("rowheader", { name })).toBeVisible();
  }
  await expect(classes.getByTestId("allocation-bar")).toHaveAttribute(
    "aria-label",
    /^Net worth by asset class: Cash .*%, Stocks and ETFs .*%, Funds .*%, Crypto .*%$/,
  );

  // Cash 4 000,00 + shares 6 000,00 + fund 1 000,00.
  const portfolio = accountRow(page, PORTFOLIO);
  await expect(portfolio.getByTestId("allocation-value")).toHaveText(
    money("11 000,00"),
  );
  await expect(portfolio).toContainText(`${BANK} · Brokerage`);
  await expect(portfolio).toContainText(/7\s000,00\s€ holdings/);
  await expect(
    accountRow(page, WALLET).getByTestId("allocation-value"),
  ).toHaveText(money("300,00"));
});

test("splits each account's performance into contributions and gain", async ({
  page,
}) => {
  await page.goto("/reports/allocation");
  const section = page.getByRole("region", { name: "Portfolio performance" });
  const chart = section.getByTestId("performance-chart");
  const days = daysBetween(rangeStart("3m", today, null), today).length;
  await expect(
    section.getByRole("link", { name: "All accounts" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(chart).toHaveAttribute("data-days", String(days));

  await section.getByRole("link", { name: PORTFOLIO }).click();
  await expect(page).toHaveURL(/\/reports\/allocation\?range=3m&account=/);
  await expect(section.getByRole("link", { name: PORTFOLIO })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // Nothing was known 3 months ago: the 10 000,00 deposit is contributed,
  // the shares' rise from 50,00 to 60,00 is the gain.
  await expect(section.getByTestId("performance-start")).toHaveText("–");
  await expect(section.getByTestId("performance-contributions")).toHaveText(
    money("+10 000,00"),
  );
  await expect(section.getByTestId("performance-gain")).toHaveText(
    money("+1 000,00"),
  );
  await expect(section.getByTestId("performance-value")).toHaveText(
    money("11 000,00"),
  );
  await expect(chart.locator(".recharts-line-curve").first()).toBeVisible();
  await chart.hover();
  const tooltip = page
    .getByTestId("performance-tooltip")
    .filter({ visible: true });
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("Market gain");

  // The wallet's coins came in at 100,00 each.
  await section.getByRole("link", { name: WALLET }).click();
  await expect(section.getByTestId("performance-contributions")).toHaveText(
    money("+200,00"),
  );
  await expect(section.getByTestId("performance-gain")).toHaveText(
    money("+100,00"),
  );
  await expect(section.getByTestId("performance-value")).toHaveText(
    money("300,00"),
  );

  // The range keeps the account.
  await section.getByRole("link", { name: "1 year" }).click();
  await expect(page).toHaveURL(/\/reports\/allocation\?range=1y&account=/);
  await expect(chart).toHaveAttribute(
    "data-days",
    String(daysBetween(rangeStart("1y", today, null), today).length),
  );
  await expect(section.getByTestId("performance-value")).toHaveText(
    money("300,00"),
  );
});

test("counts the investments in the net-worth history and the dashboard", async ({
  page,
}) => {
  await page.goto("/reports/balances");
  const row = page
    .getByTestId("balance-row")
    .filter({ visible: true, hasText: PORTFOLIO });
  await expect(row.getByTestId("balance-start")).toHaveText("–");
  await expect(row.getByTestId("balance-end")).toHaveText(money("11 000,00"));
  await expect(
    page
      .getByTestId("balance-row")
      .filter({ visible: true, hasText: WALLET })
      .getByTestId("balance-end"),
  ).toHaveText(money("300,00"));

  await page.goto("/");
  const account = page
    .getByRole("region", { name: BANK })
    .getByTestId("account")
    .filter({ hasText: PORTFOLIO });
  await expect(account.getByTestId("account-balance")).toHaveText(
    money("11 000,00"),
  );
  await expect(account.getByTestId("account-holdings")).toHaveText(
    /^7\s000,00\s€ holdings \+ 4\s000,00\s€ cash$/,
  );
  await expect(account.getByTestId("sparkline")).toBeVisible();
});
