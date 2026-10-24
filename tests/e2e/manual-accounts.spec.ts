import { randomInt, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

// Settings → Accounts end to end (F-029): add an own account outside the
// bank connections with a balance on a date, see it listed there and on
// the dashboard's account list under its bank, then refuse its IBAN for a
// second account. The test database is shared, so the bank name and the
// IBAN are unique to the run.

/** A random synthetic Finnish IBAN with valid mod-97 check digits. */
function randomFinnishIban(): string {
  const bban = Array.from({ length: 14 }, () => randomInt(10)).join("");
  // `FI00` moved to the end, letters as numbers (F = 15, I = 18).
  let remainder = 0;
  for (const digit of `${bban}151800`) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  const check = String(98 - remainder).padStart(2, "0");
  return `FI${check}${bban}`;
}

/** `FI21 1234 5600 0007 85`: how a person copies it from a netbank. */
function grouped(iban: string): string {
  return iban.replace(/(.{4})/g, "$1 ").trim();
}

test("adds an own account with a balance and shows it on the dashboard", async ({
  page,
}) => {
  const bank = `E2E Oma pankki ${randomUUID().slice(0, 8)}`;
  const iban = randomFinnishIban();

  await page.goto("/settings");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^Accounts/ })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Accounts" }),
  ).toBeVisible();
  const add = page.getByRole("region", { name: "Add an account" });
  await expect(add.getByRole("button", { name: "Add account" })).toBeEnabled();

  await add.getByLabel("Bank").fill(bank);
  await add.getByLabel("Account name").fill("Säästötili");
  await add.getByLabel("IBAN").fill(grouped(iban).toLowerCase());
  await add.getByLabel("Type").selectOption("savings");
  await add.getByLabel("Balance (optional)").fill("1 234,56");
  await add.getByLabel("Balance date").fill("2026-10-01");
  await add.getByRole("button", { name: "Add account" }).click();
  await expect(add.getByRole("status")).toHaveText(/^Account added\./);

  const listed = page.getByTestId("manual-account").filter({ hasText: bank });
  await expect(listed).toContainText("Säästötili");
  await expect(listed).toContainText(iban);
  await expect(listed).toContainText("Savings");
  await expect(listed.getByTestId("manual-account-balance")).toHaveText(
    /^1\s234,56\s€ on 1\.10\.2026$/,
  );

  // The same IBAN again is refused, and the form keeps what was typed.
  await add.getByLabel("Bank").fill(bank);
  await add.getByLabel("Account name").fill("Kopio");
  await add.getByLabel("IBAN").fill(iban);
  await add.getByRole("button", { name: "Add account" }).click();
  await expect(add.getByRole("alert")).toHaveText(
    `The IBAN ${iban} is already used by the account “Säästötili”.`,
  );
  await expect(add.getByLabel("Account name")).toHaveValue("Kopio");

  await page.goto("/");
  const account = page
    .getByRole("region", { name: bank })
    .getByTestId("account")
    .filter({ hasText: "Säästötili" });
  await expect(account).toHaveCount(1);
  await expect(account.getByTestId("account-balance")).toHaveText(
    /^1\s234,56\s€$/,
  );
  await expect(account.getByTestId("account-last-sync")).toHaveText(
    "Manual account",
  );
});

test("links /connections to Settings → Accounts", async ({ page }) => {
  await page.goto("/connections");
  await page
    .getByRole("main")
    .getByRole("link", { name: "Settings → Accounts" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Accounts" }),
  ).toBeVisible();
});
