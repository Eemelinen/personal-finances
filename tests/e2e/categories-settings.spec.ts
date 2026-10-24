import { expect, test, type Page } from "@playwright/test";
import { uniqueTag } from "./support/transactions";

// /settings/categories end to end (F-015): categories and rules are created,
// reordered and deleted. Every test works on its own uniquely named
// category and shows only that category's rules, so parallel tests that add
// rules elsewhere do not change what it sees.

async function openSettings(page: Page) {
  await page.goto("/settings/categories");
  await expect(
    page.getByRole("heading", { level: 1, name: "Categories and rules" }),
  ).toBeVisible();
}

async function addCategory(
  page: Page,
  name: string,
  options: { parent?: string; kind?: string } = {},
) {
  await page.getByLabel("New category").fill(name);
  await page
    .getByLabel("Parent")
    .selectOption({ label: options.parent ?? "None (top level)" });
  if (options.kind) {
    await page.getByLabel("Kind").selectOption({ label: options.kind });
  }
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByText(`Category ${name} added.`)).toBeVisible();
}

function categoryRow(page: Page, name: string) {
  return page
    .getByRole("table", { name: "Categories" })
    .getByRole("row")
    .filter({ hasText: name });
}

function rulesTable(page: Page) {
  return page.getByRole("table", { name: "Rules" });
}

async function openNewRule(page: Page) {
  const details = page.locator("details").filter({ hasText: "New rule" });
  if (
    !(await details.evaluate((element) => (element as HTMLDetailsElement).open))
  ) {
    await details.getByText("New rule", { exact: true }).click();
  }
  return details;
}

async function addRule(
  page: Page,
  rule: { pattern: string; category: string; matchType?: string },
) {
  const form = await openNewRule(page);
  await form
    .getByLabel("Match type")
    .selectOption({ label: rule.matchType ?? "Contains" });
  await form.getByLabel("Pattern").fill(rule.pattern);
  await form.getByLabel("Rule category").selectOption({ label: rule.category });
  await form.getByRole("button", { name: "Add rule" }).click();
  return form;
}

async function showRulesOf(page: Page, category: string) {
  await page.getByLabel("Show rules of").selectOption({ label: category });
}

test("creates, reorders and deletes rules", async ({ page }) => {
  const tag = uniqueTag();
  const category = `E2E rules ${tag}`;
  await openSettings(page);
  await addCategory(page, category);

  for (const pattern of [`alpha-${tag}`, `beta-${tag}`]) {
    const form = await addRule(page, { pattern, category });
    await expect(form.getByRole("status")).toHaveText("Rule created.");
  }

  // A new rule runs first, so the newer one is on top.
  await showRulesOf(page, category);
  const patterns = rulesTable(page).getByTestId("rule-pattern");
  await expect(patterns).toHaveText([`beta-${tag}`, `alpha-${tag}`]);
  await expect(
    rulesTable(page)
      .getByRole("row")
      .filter({ hasText: `beta-${tag}` }),
  ).toContainText(category);

  await rulesTable(page)
    .getByRole("row")
    .filter({ hasText: `beta-${tag}` })
    .getByRole("button", { name: "Move down" })
    .click();
  await expect(patterns).toHaveText([`alpha-${tag}`, `beta-${tag}`]);

  // The order is stored: the rule numbers follow it after a reload too.
  await page.reload();
  await showRulesOf(page, category);
  await expect(patterns).toHaveText([`alpha-${tag}`, `beta-${tag}`]);
  const number = async (pattern: string) =>
    Number(
      await rulesTable(page)
        .getByRole("row")
        .filter({ hasText: pattern })
        .getByRole("cell")
        .first()
        .textContent(),
    );
  expect(await number(`alpha-${tag}`)).toBeLessThan(
    await number(`beta-${tag}`),
  );

  await rulesTable(page)
    .getByRole("row")
    .filter({ hasText: `beta-${tag}` })
    .getByRole("button", { name: "Move up" })
    .click();
  await expect(patterns).toHaveText([`beta-${tag}`, `alpha-${tag}`]);

  await rulesTable(page)
    .getByRole("row")
    .filter({ hasText: `alpha-${tag}` })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(patterns).toHaveText([`beta-${tag}`]);
  await page.reload();
  await showRulesOf(page, category);
  await expect(patterns).toHaveText([`beta-${tag}`]);

  // Deleting the category deletes its rules.
  const row = categoryRow(page, category);
  await expect(row).toContainText("1 rule, 0 transactions");
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(row).toContainText(
    `Delete ${category}? 1 rule is deleted and 0 transactions lose the category.`,
  );
  await row.getByRole("button", { name: "Confirm delete" }).click();
  await expect(categoryRow(page, category)).toHaveCount(0);
  await expect(
    page.getByLabel("Show rules of").getByRole("option", { name: category }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("row").filter({ hasText: `beta-${tag}` }),
  ).toHaveCount(0);
});

test("rejects a rule with an invalid regular expression", async ({ page }) => {
  const tag = uniqueTag();
  const category = `E2E regex ${tag}`;
  await openSettings(page);
  await addCategory(page, category);
  const form = await addRule(page, {
    pattern: "(unclosed",
    category,
    matchType: "Regular expression",
  });
  await expect(form.getByRole("alert")).toContainText(
    "Invalid regular expression",
  );
  await showRulesOf(page, category);
  await expect(page.getByText("No rules.")).toBeVisible();

  await form.getByLabel("Pattern").fill(`^shop ${tag}\\b`);
  await form.getByRole("button", { name: "Add rule" }).click();
  await expect(form.getByRole("status")).toHaveText("Rule created.");
  await expect(rulesTable(page).getByTestId("rule-pattern")).toHaveText([
    `^shop ${tag}\\b`,
  ]);
});

test("adds, renames and deletes a subcategory", async ({ page }) => {
  const tag = uniqueTag();
  const parent = `E2E parent ${tag}`;
  await openSettings(page);
  await addCategory(page, parent, { kind: "Income" });
  await addCategory(page, `Child ${tag}`, { parent });
  await expect(categoryRow(page, `Child ${tag}`)).toContainText("Income");

  const child = categoryRow(page, `Child ${tag}`);
  await child.getByRole("button", { name: "Rename" }).click();
  // While renaming, the name is in an input (not the row's text).
  const categoriesTable = page.getByRole("table", { name: "Categories" });
  await categoriesTable.getByLabel("Category name").fill(`Renamed ${tag}`);
  await categoriesTable.getByRole("button", { name: "Save" }).click();
  await expect(categoryRow(page, `Renamed ${tag}`)).toBeVisible();
  await expect(categoryRow(page, `Child ${tag}`)).toHaveCount(0);

  // The same name twice under one parent is refused.
  await addCategoryExpectingError(page, `Renamed ${tag}`, parent);

  const parentRow = categoryRow(page, parent).first();
  await parentRow.getByRole("button", { name: "Delete" }).click();
  await expect(parentRow).toContainText("and its 1 subcategory");
  await parentRow.getByRole("button", { name: "Confirm delete" }).click();
  await expect(categoryRow(page, parent)).toHaveCount(0);
  await expect(categoryRow(page, `Renamed ${tag}`)).toHaveCount(0);
});

async function addCategoryExpectingError(
  page: Page,
  name: string,
  parent: string,
) {
  await page.getByLabel("New category").fill(name);
  await page.getByLabel("Parent").selectOption({ label: parent });
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "already exists" }),
  ).toHaveText(`A category ${name} already exists here.`);
}
