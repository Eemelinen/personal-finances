import { randomInt, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  accounts,
  connections,
  institutions,
  transactions,
} from "@/server/db/schema";
import { openTestDatabase } from "./support/database";

// The connect-bank flow end to end (F-007) through the fake provider
// (`BANK_PROVIDER=fake`): /connections redirects to the fake's stand-in bank
// page, which approves or cancels back to /connections/callback like a
// bank. The callback syncs the new connection right away (F-010). Other
// specs seed connections too, so each test finds its own connection by the
// id the callback puts in the URL. Remove's confirmation says what goes and
// what stays (F-033): an account with imported rows is kept as a manual one.

/** Opens /connections and waits for hydration (Connect is disabled while pending). */
async function openConnections(page: Page) {
  await page.goto("/connections");
  await expect(
    page.getByRole("heading", { level: 1, name: "Connections" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect" })).toBeEnabled();
}

/** Starts connecting `bank` and lands on the fake bank's page. */
async function goToBank(page: Page, bank: string) {
  await openConnections(page);
  await page.getByLabel("Bank", { exact: true }).selectOption(bank);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: `Fake bank: ${bank}` }),
  ).toBeVisible();
}

/** Connects `bank` and returns its card on /connections. */
async function connect(page: Page, bank: string) {
  await goToBank(page, bank);
  await page.getByRole("link", { name: "Approve access" }).click();
  await expect(page).toHaveURL(/\/connections\?connected=[0-9a-f-]{36}$/);
  const id = new URL(page.url()).searchParams.get("connected");
  return page.locator(`[data-connection-id="${id}"]`);
}

test("connects a bank through the fake provider and renames an account", async ({
  page,
}) => {
  const card = await connect(page, "S-Pankki");

  await expect(
    page.getByRole("status").filter({ hasText: "Connected S-Pankki" }),
  ).toHaveText(
    /^Connected S-Pankki with 2 accounts\. Its balances and transactions are synced\./,
  );
  await expect(card.getByRole("heading", { level: 2 })).toHaveText("S-Pankki");
  await expect(card).toContainText("Active");
  // 180 days less ten minutes from now, as a fi-FI day.
  await expect(card).toContainText(/Consent until\s*\d{1,2}\.\d{1,2}\.\d{4}/);
  // The first sync ran in the callback: balances, then transactions.
  await expect(card).toContainText(/Last sync\s*\d{1,2}\.\d{1,2}\.\d{4}/);
  await expect(card.getByTestId("sync-run-kind")).toHaveText([
    "Transactions",
    "Balances",
  ]);
  await expect(card.getByTestId("sync-run-status")).toHaveText([
    "Succeeded",
    "Succeeded",
  ]);

  const checking = card.getByRole("form", {
    name: "Account FI00 0000 0000 0000 01",
  });
  const savings = card.getByRole("form", {
    name: "Account FI00 0000 0000 0000 02",
  });
  await expect(checking.getByLabel("Account name")).toHaveValue(
    "Fake Checking",
  );
  await expect(checking.getByLabel("Account type")).toHaveValue("checking");
  await expect(savings.getByLabel("Account type")).toHaveValue("savings");

  const name = `E2E Bills ${randomUUID().slice(0, 8)}`;
  await checking.getByLabel("Account name").fill(name);
  await checking.getByLabel("Account type").selectOption("Savings");
  await checking.getByRole("button", { name: "Save" }).click();
  await expect(
    card.getByRole("status").filter({ hasText: "Account saved." }),
  ).toBeVisible();

  await page.reload();
  await expect(checking.getByLabel("Account name")).toHaveValue(name);
  await expect(checking.getByLabel("Account type")).toHaveValue("savings");
});

test("a login cancelled at the bank shows an error and connects nothing", async ({
  page,
}) => {
  await goToBank(page, "Nordea");

  await page.getByRole("link", { name: "Cancel" }).click();

  await expect(page).toHaveURL("/connections?error=cancelled");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    /^The bank login was cancelled, so no connection was made\./,
  );
  // Nothing was stored (other specs connect in parallel, so the
  // connections themselves are counted in L2 instead).
  await expect(
    page.getByRole("status").filter({ hasText: "Connected" }),
  ).toHaveCount(0);
});

test("a callback with a state the app did not send is refused", async ({
  page,
}) => {
  await page.goto("/connections/callback?state=forged&code=whatever");

  await expect(page).toHaveURL("/connections?error=invalid_state");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "could not be matched to a connection you started",
  );
});

test("archives a connection, then removes it", async ({ page }) => {
  const card = await connect(page, "Nordea");
  await expect(card).toContainText("Active");

  await card.getByRole("button", { name: "Archive", exact: true }).click();
  await card
    .getByRole("button", { name: "Confirm archive", exact: true })
    .click();
  await expect(card).toContainText("Archived");
  await expect(
    card.getByRole("button", { name: "Archive", exact: true }),
  ).toHaveCount(0);
  await expect(card.getByLabel("Account name")).toHaveCount(0);

  await card.getByRole("button", { name: "Remove", exact: true }).click();
  await card
    .getByRole("button", { name: "Confirm remove", exact: true })
    .click();
  await expect(card).toHaveCount(0);
});

test("the Remove confirmation lists what stays, and the account with imported rows is kept", async ({
  page,
}) => {
  const tag = randomUUID().slice(0, 8);
  const kept = `E2E Kept ${tag}`;
  const gone = `E2E Gone ${tag}`;
  const db = openTestDatabase();
  let connectionId: string;
  try {
    const [institution] = await db
      .insert(institutions)
      .values({
        name: "Nordea",
        country: "FI",
        provider: "fake",
        providerRef: "Nordea",
      })
      .onConflictDoUpdate({
        target: [institutions.provider, institutions.providerRef],
        set: { updatedAt: new Date() },
      })
      .returning();
    // Archived, so no sync or consent banner touches it meanwhile.
    const [connection] = await db
      .insert(connections)
      .values({
        institutionId: institution.id,
        provider: "fake",
        sessionRef: null,
        status: "archived",
      })
      .returning();
    connectionId = connection.id;
    const iban = () =>
      `FI99${Array.from({ length: 14 }, () => randomInt(10)).join("")}`;
    const [keptAccount, goneAccount] = await db
      .insert(accounts)
      .values(
        [kept, gone].map((name) => ({
          connectionId: connection.id,
          institutionId: institution.id,
          providerAccountRef: `e2e-${name}`,
          iban: iban(),
          name,
          type: "checking" as const,
          currency: "EUR",
          archived: true,
        })),
      )
      .returning();
    // Long ago and unique, so no other spec's sums or lists see them.
    const row = (accountId: string, key: string, source: "bank" | "csv") => ({
      accountId,
      providerTxnRef: source === "bank" ? `${accountId}:${key}` : null,
      dedupeHash: `${accountId}:${key}`,
      bookingDate: "2019-02-01",
      amountMinor: -1_234,
      currency: "EUR",
      counterparty: `E2E Remove ${tag}`,
      source,
    });
    await db
      .insert(transactions)
      .values([
        row(keptAccount.id, "a", "bank"),
        row(keptAccount.id, "b", "bank"),
        row(keptAccount.id, "c", "csv"),
        row(goneAccount.id, "d", "bank"),
      ]);
  } finally {
    await db.$client.end();
  }

  await openConnections(page);
  const card = page.locator(`[data-connection-id="${connectionId}"]`);
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  const summary = card.getByTestId("removal-summary");
  await expect(summary).toContainText("Remove Nordea?");
  await expect(summary).toContainText(
    "Deleted: 1 account, 3 bank transactions and the balances.",
  );
  await expect(summary).toContainText(
    `Kept as a manual account: ${kept}, with 1 imported transaction.`,
  );

  await card
    .getByRole("button", { name: "Confirm remove", exact: true })
    .click();
  await expect(card).toHaveCount(0);

  await page.goto("/settings/accounts");
  await expect(page.getByRole("main")).toContainText(kept);
  await expect(page.getByRole("main")).not.toContainText(gone);
});
