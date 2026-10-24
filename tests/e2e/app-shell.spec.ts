import { expect, test, type Page } from "@playwright/test";

const SECTIONS = [
  { href: "/", label: "Dashboard" },
  { href: "/transactions", label: "Transactions" },
  { href: "/reports", label: "Reports" },
  { href: "/investments", label: "Investments" },
  { href: "/connections", label: "Connections" },
  { href: "/settings", label: "Settings" },
] as const;

// The dashboard has data by the time this spec runs (dashboard.spec.ts seeds
// it first), Reports links to its reports, Settings links to category
// management, and Transactions and Investments may already show what other
// specs (running in parallel) imported; every other section is still a
// placeholder.
const WITH_DATA = new Set<string>([
  "/",
  "/transactions",
  "/reports",
  "/investments",
  "/settings",
]);

async function expectSection(page: Page, label: string, href: string) {
  await expect(page).toHaveURL(href);
  await expect(
    page.getByRole("heading", { level: 1, name: label }),
  ).toBeVisible();
  if (!WITH_DATA.has(href)) {
    await expect(
      page.getByTestId("empty-state").filter({ visible: true }),
    ).toBeVisible();
  }
  await expect(page.getByRole("banner")).toContainText("Personal Finances");
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("the test server reaches its database", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ status: "ok", db: "ok" });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("every page renders inside the shell", async ({ page }) => {
    for (const { href, label } of SECTIONS) {
      const response = await page.goto(href);
      expect(response?.status()).toBe(200);
      await expectSection(page, label, href);
      await expect(
        page
          .getByRole("navigation", { name: "Main" })
          .getByRole("link", { name: label }),
      ).toHaveAttribute("aria-current", "page");
    }
  });

  test("every navigation link opens its page", async ({ page }) => {
    await page.goto("/settings");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
    await expect(nav.getByRole("link")).toHaveText(
      SECTIONS.map((s) => s.label),
    );

    for (const { href, label } of SECTIONS) {
      await nav.getByRole("link", { name: label }).click();
      await expectSection(page, label, href);
      await expect(nav.getByRole("link", { name: label })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    }
    await expectNoHorizontalScroll(page);
  });
});

test.describe("mobile", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("the sidebar is replaced by a menu whose links open their pages", async ({
    page,
  }) => {
    await page.goto("/settings");
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
    await expectNoHorizontalScroll(page);

    for (const { href, label } of SECTIONS) {
      await page.getByRole("button", { name: "Open menu" }).click();
      const menu = page.getByRole("dialog", { name: "Personal Finances" });
      await expect(menu).toBeVisible();
      await menu.getByRole("link", { name: label }).click();
      await expect(menu).toBeHidden();
      await expectSection(page, label, href);
      await expectNoHorizontalScroll(page);
    }
  });
});
