import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { encryptSecret } from "@/server/crypto";
import type { Db } from "@/server/db/client";
import { accounts, connections, institutions } from "@/server/db/schema";
import { formatMoney } from "@/lib/format";
import { createFakeProvider, FAKE_SESSION_REFS } from "@/server/providers/fake";
import { E2E_ENCRYPTION_KEY } from "./support/credentials";
import { openTestDatabase } from "./support/database";

// Sync now end to end (F-010) through the fake provider: a connection is
// seeded as the connect flow leaves it before its first sync (accounts, no
// balances), then the card's Sync now syncs it with a pending state and the
// new balances, the sync log and the header's last sync appear; Re-read
// history then fetches the whole history again without duplicates. Other specs
// connect banks in parallel, so only this spec's connections are asserted,
// and the dashboard's Sync now (every connection) is not clicked.

const tag = randomUUID().slice(0, 8);
const BANK = `E2E Sync Bank ${tag}`;
const DOWN_BANK = `E2E Down Bank ${tag}`;
const CHECKING = `E2E Sync Checking ${tag}`;
const SAVINGS = `E2E Sync Savings ${tag}`;

let db: Db;
let connectionId: string;
let downConnectionId: string;

async function seedConnection(name: string, sessionRef: string) {
  const [institution] = await db
    .insert(institutions)
    .values({
      name,
      country: "FI",
      provider: "fake",
      providerRef: `e2e-${randomUUID()}`,
    })
    .returning();
  const [connection] = await db
    .insert(connections)
    .values({
      institutionId: institution.id,
      provider: "fake",
      sessionRef: encryptSecret(
        sessionRef,
        Buffer.from(E2E_ENCRYPTION_KEY, "base64"),
      ),
      status: "active",
      consentExpiresAt: new Date(Date.now() + 90 * 86_400_000),
    })
    .returning();
  return { institution, connection };
}

test.beforeAll(async () => {
  db = openTestDatabase();
  const { institution, connection } = await seedConnection(
    BANK,
    FAKE_SESSION_REFS.valid,
  );
  connectionId = connection.id;
  await db.insert(accounts).values(
    [
      ["fake-checking", CHECKING, "checking"],
      ["fake-savings", SAVINGS, "savings"],
    ].map(([ref, name, type]) => ({
      connectionId,
      institutionId: institution.id,
      providerAccountRef: ref,
      name,
      type: type as "checking" | "savings",
      currency: "EUR",
    })),
  );
  downConnectionId = (
    await seedConnection(DOWN_BANK, FAKE_SESSION_REFS.unavailable)
  ).connection.id;
});

test.afterAll(async () => {
  await db?.$client.end();
});

/** Holds every Server Action request for a moment, so the pending state shows. */
async function slowDownActions(page: Page) {
  await page.route("**/connections", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().headers()["next-action"]
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await route.continue();
  });
}

/** The fake's interim available balance today, as the dashboard shows it. */
async function expectedBalance(ref: string): Promise<string> {
  const balances = await createFakeProvider().getBalances(
    { sessionRef: FAKE_SESSION_REFS.valid },
    ref,
  );
  const available = balances.find((balance) => balance.balanceType === "ITAV");
  return formatMoney(available!.amountMinor, available!.currency);
}

test("Sync now syncs a connection through the fake provider and updates balances and the sync log", async ({
  page,
}) => {
  await page.goto("/");
  const bank = page.getByTestId("bank").filter({ hasText: BANK });
  await expect(
    bank.getByTestId("account").filter({ hasText: CHECKING }),
  ).toContainText("No balance yet");
  await expect(
    page
      .getByRole("region", { name: "Connections" })
      .getByRole("button", { name: "Sync now" }),
  ).toBeVisible();

  await page.goto("/connections");
  const card = page.locator(`[data-connection-id="${connectionId}"]`);
  await expect(card).toContainText("Not synced yet");
  await expect(card).toContainText("No syncs yet.");

  await slowDownActions(page);
  await card.getByRole("button", { name: "Sync now" }).click();
  const pending = card.getByRole("button", { name: "Syncing…" });
  await expect(pending).toBeDisabled();
  await expect(pending).toHaveAttribute("aria-busy", "true");

  await expect(card.getByRole("status")).toHaveText(
    new RegExp(`^${BANK} synced, \\d+ new transactions\\.$`),
  );
  await expect(card.getByRole("button", { name: "Sync now" })).toBeEnabled();
  await expect(card).not.toContainText("Not synced yet");
  await expect(card).toContainText(/Last sync\s*\d{1,2}\.\d{1,2}\.\d{4}/);

  // Two runs: the balances (two accounts, two balance types each), then
  // the transactions.
  const runs = card.getByTestId("sync-run");
  await expect(runs).toHaveCount(2);
  await expect(runs.getByTestId("sync-run-kind")).toHaveText([
    "Transactions",
    "Balances",
  ]);
  await expect(runs.getByTestId("sync-run-status")).toHaveText([
    "Succeeded",
    "Succeeded",
  ]);
  await expect(runs.nth(1).getByTestId("sync-run-inserted")).toHaveText("4");
  await expect(runs.nth(0).getByTestId("sync-run-inserted")).not.toHaveText(
    "0",
  );
  await expect(page.getByTestId("last-sync")).toHaveText(
    /^Last sync \d{1,2}\.\d{1,2}\.\d{4} klo \d{1,2}\.\d{2}$/,
  );

  // A second sync finds nothing new and logs two more runs.
  await card.getByRole("button", { name: "Sync now" }).click();
  await expect(card.getByRole("status")).toHaveText(
    `${BANK} synced, 0 new transactions.`,
  );
  await expect(runs).toHaveCount(4);
  await expect(runs.first().getByTestId("sync-run-inserted")).toHaveText("0");

  // Re-read history (F-028) fetches the whole history again, as the first
  // sync did, and inserts nothing.
  const backfilled = await runs
    .nth(2)
    .getByTestId("sync-run-fetched")
    .innerText();
  await card.getByRole("button", { name: "Re-read history" }).click();
  // Its own message next to Sync now's, which still says the same.
  await expect(card.getByRole("status")).toHaveText([
    `${BANK} synced, 0 new transactions.`,
    `${BANK} synced, 0 new transactions.`,
  ]);
  await expect(runs).toHaveCount(6);
  await expect(runs.first().getByTestId("sync-run-kind")).toHaveText(
    "Transactions",
  );
  await expect(runs.first().getByTestId("sync-run-fetched")).toHaveText(
    backfilled,
  );
  await expect(runs.first().getByTestId("sync-run-inserted")).toHaveText("0");

  // The dashboard shows the synced balances under the user's names.
  await page.goto("/");
  await expect(
    bank
      .getByTestId("account")
      .filter({ hasText: CHECKING })
      .getByTestId("account-balance"),
  ).toHaveText(await expectedBalance("fake-checking"));
  await expect(
    bank
      .getByTestId("account")
      .filter({ hasText: SAVINGS })
      .getByTestId("account-balance"),
  ).toHaveText(await expectedBalance("fake-savings"));
});

test("a failed Sync now says why and is in the sync log", async ({ page }) => {
  await page.goto("/connections");
  const card = page.locator(`[data-connection-id="${downConnectionId}"]`);
  await card.getByRole("button", { name: "Sync now" }).click();

  await expect(card.getByRole("alert")).toHaveText(
    `${DOWN_BANK}: the bank service is not reachable; try again later.`,
  );
  const runs = card.getByTestId("sync-run");
  await expect(runs).toHaveCount(1);
  await expect(runs.getByTestId("sync-run-kind")).toHaveText("Balances");
  await expect(runs.getByTestId("sync-run-status")).toHaveText("Failed");
  await expect(runs.getByTestId("sync-run-error")).toHaveText(
    "fake bank unavailable",
  );
  // Still active: the next scheduled sync retries it.
  await expect(card).toContainText("Active");
  await expect(card).toContainText("Not synced yet");
});
