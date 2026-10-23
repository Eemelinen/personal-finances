import { expect, test as setup } from "@playwright/test";
import { E2E_AUTH_STATE, E2E_PASSWORD } from "./support/credentials";

// Logs in once; the other specs start from this browser state.
setup("log in", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL("/");
  await page.context().storageState({ path: E2E_AUTH_STATE });
});
