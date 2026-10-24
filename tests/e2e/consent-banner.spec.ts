import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { expect, test, type Page } from "@playwright/test";
import { formatLocalDay } from "@/lib/format";
import { encryptSecret } from "@/server/crypto";
import { localDate } from "@/server/dates";
import type { Db } from "@/server/db/client";
import {
  accounts,
  balanceSnapshots,
  connections,
  institutions,
} from "@/server/db/schema";
import { FAKE_SESSION_REFS } from "@/server/providers/fake";
import { E2E_ENCRYPTION_KEY } from "./support/credentials";
import { E2E_TIME_ZONE, openTestDatabase } from "./support/database";

// Consent expiry and renewal end to end (F-011) through the fake provider:
// a connection whose consent ends in five days shows a warning banner and
// one whose consent has ended an error banner, on every page; Renew in the
// banner goes through the fake bank's login and back to the same
// connection, whose accounts (matched by IBAN, then provider id) and their
// history stay. Other specs seed connections too (the dashboard spec's
// expiring and expired ones stay in the database), so only this spec's
// banners and cards are asserted, found by connection id.

const tag = randomUUID().slice(0, 8);
const EXPIRING_ACCOUNT = `E2E Expiring ${tag}`;
const CHECKING = `E2E Renew Checking ${tag}`;
const SAVINGS = `E2E Renew Savings ${tag}`;
const DAY_MS = 86_400_000;
// Recent, so the history never counts as a balance at the start of a
// report range (the balance-history spec sums those).
const HISTORY_DAY = localDate(new Date(Date.now() - 3 * DAY_MS), E2E_TIME_ZONE);

let db: Db;
let institutionId: string;
let expiring: { id: string; consentExpiresAt: Date };
let expired: { id: string };

test.describe.configure({ mode: "serial" });

async function seedConnection(
  values: Partial<typeof connections.$inferInsert>,
) {
  const [connection] = await db
    .insert(connections)
    .values({
      institutionId,
      provider: "fake",
      sessionRef: encryptSecret(
        FAKE_SESSION_REFS.valid,
        Buffer.from(E2E_ENCRYPTION_KEY, "base64"),
      ),
      status: "active",
      ...values,
    })
    .returning();
  return connection;
}

test.beforeAll(async () => {
  db = openTestDatabase();
  // The fake's Nordea, as connecting through it creates it (renewal goes
  // back to the connection's bank); another spec may have created it.
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
  institutionId = institution.id;

  const expiringRow = await seedConnection({
    consentExpiresAt: new Date(Date.now() + 5 * DAY_MS),
  });
  expiring = {
    id: expiringRow.id,
    consentExpiresAt: expiringRow.consentExpiresAt!,
  };
  await db.insert(accounts).values({
    connectionId: expiring.id,
    institutionId,
    providerAccountRef: "fake-checking",
    iban: "FI00 0000 0000 0000 01",
    name: EXPIRING_ACCOUNT,
    type: "checking",
    currency: "EUR",
  });

  // Ended yesterday; the sync already marked it expired. Its account ids at
  // the bank were per session: checking is found by IBAN, savings (no IBAN
  // stored) by its id.
  expired = await seedConnection({
    status: "expired",
    consentExpiresAt: new Date(Date.now() - DAY_MS),
  });
  const seeded = await db
    .insert(accounts)
    .values([
      {
        connectionId: expired.id,
        institutionId,
        providerAccountRef: "old-session-uid",
        iban: "FI0000000000000001",
        name: CHECKING,
        type: "checking" as const,
        currency: "EUR",
      },
      {
        connectionId: expired.id,
        institutionId,
        providerAccountRef: "fake-savings",
        iban: null,
        name: SAVINGS,
        type: "savings" as const,
        currency: "EUR",
      },
    ])
    .returning({ id: accounts.id });
  await db.insert(balanceSnapshots).values(
    seeded.map(({ id }) => ({
      accountId: id,
      date: HISTORY_DAY,
      amountMinor: 123_45,
      currency: "EUR",
      balanceType: "CLBD",
    })),
  );
});

test.afterAll(async () => {
  if (db) {
    // Later specs must not see this spec's banners.
    const ids = [expiring?.id, expired?.id].filter(Boolean);
    if (ids.length > 0) {
      await db.delete(accounts).where(inArray(accounts.connectionId, ids));
      await db.delete(connections).where(inArray(connections.id, ids));
    }
    await db.$client.end();
  }
});

function banner(page: Page, connectionId: string) {
  return page.locator(
    `[data-testid="consent-banner"][data-consent-for="${connectionId}"]`,
  );
}

test("warns before the consent ends and shows an error after it, on every page", async ({
  page,
}) => {
  const day = formatLocalDay(expiring.consentExpiresAt, E2E_TIME_ZONE);
  for (const path of [
    "/",
    "/transactions",
    "/reports",
    "/connections",
    "/settings",
  ]) {
    await page.goto(path);
    const warning = banner(page, expiring.id);
    await expect(warning).toHaveAttribute("data-level", "expiring");
    await expect(warning).toContainText(
      `Nordea: the bank consent ends on ${day}. Renew it to keep syncing.`,
    );
    await expect(
      warning.getByRole("button", { name: "Renew Nordea" }),
    ).toBeVisible();

    const error = banner(page, expired.id);
    await expect(error).toHaveAttribute("data-level", "expired");
    await expect(error).toContainText(
      "Nordea: the bank consent has ended, so it is no longer synced.",
    );
    // Above the page's content, outside its main landmark.
    await expect(
      page.getByRole("main").getByTestId("consent-banner"),
    ).toHaveCount(0);
  }

  // /connections marks the ended one expired and offers Renew on its card.
  await page.goto("/connections");
  const card = page.locator(`li[data-connection-id="${expired.id}"]`);
  await expect(card).toContainText("Expired");
  await expect(
    card.getByRole("button", { name: "Renew Nordea" }),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Sync now" })).toHaveCount(0);
});

test("Renew goes through the fake bank and continues the same connection and accounts", async ({
  page,
}) => {
  const before = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.connectionId, expired.id))
    .orderBy(asc(accounts.name));

  await page.goto("/transactions");
  const error = banner(page, expired.id);
  const renew = error.getByRole("button", { name: "Renew Nordea" });
  await expect(renew).toBeEnabled();
  await renew.click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Fake bank: Nordea" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Approve access" }).click();

  await expect(page).toHaveURL(
    new RegExp(`/connections\\?renewed=${expired.id}$`),
  );
  await expect(
    page.getByRole("status").filter({ hasText: "Renewed Nordea" }),
  ).toHaveText(
    /^Renewed Nordea until \d{1,2}\.\d{1,2}\.\d{4}\. Its accounts and their history continue\. Its balances and transactions are synced\./,
  );
  await expect(banner(page, expired.id)).toHaveCount(0);
  // The other connection still warns.
  await expect(banner(page, expiring.id)).toBeVisible();

  const card = page.locator(`li[data-connection-id="${expired.id}"]`);
  await expect(card).toContainText("Active");
  await expect(card.getByRole("button", { name: "Renew Nordea" })).toHaveCount(
    0,
  );
  // No duplicates: the same two accounts, with the names given before.
  const names = card.getByLabel("Account name");
  await expect(names).toHaveCount(2);
  await expect(names.nth(0)).toHaveValue(CHECKING);
  await expect(names.nth(1)).toHaveValue(SAVINGS);
  // The sync after renewing ran on the same accounts.
  await expect(card.getByTestId("sync-run-status")).toHaveText([
    "Succeeded",
    "Succeeded",
  ]);

  // Same account ids, now under the new session's provider ids, with the
  // history from before the renewal.
  const after = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      ref: accounts.providerAccountRef,
      archived: accounts.archived,
    })
    .from(accounts)
    .where(eq(accounts.connectionId, expired.id))
    .orderBy(asc(accounts.name));
  expect(after).toEqual([
    { ...before[0], ref: "fake-checking", archived: false },
    { ...before[1], ref: "fake-savings", archived: false },
  ]);
  const ids = before.map(({ id }) => id);
  const kept = await db
    .select({ accountId: balanceSnapshots.accountId })
    .from(balanceSnapshots)
    .where(
      and(
        inArray(balanceSnapshots.accountId, ids),
        eq(balanceSnapshots.date, HISTORY_DAY),
      ),
    );
  expect(kept.map(({ accountId }) => accountId).sort()).toEqual(
    [...ids].sort(),
  );
  expect(
    await db.$count(balanceSnapshots, inArray(balanceSnapshots.accountId, ids)),
  ).toBeGreaterThan(ids.length);
});
