import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
} from "@playwright/test";
import { LOGIN_PATH } from "@/lib/auth/routes";
import { SESSION_COOKIE, sealSession } from "@/server/auth/session";
import { E2E_PASSWORD, E2E_SESSION_SECRET } from "./support/credentials";

const DAY_MS = 86_400_000;

/** Puts a valid session issued `ageMs` ago into the browser. */
async function addSessionIssued(
  context: BrowserContext,
  baseURL: string,
  ageMs: number,
): Promise<string> {
  const seal = await sealSession(E2E_SESSION_SECRET, Date.now() - ageMs);
  await context.addCookies([
    { name: SESSION_COOKIE, value: seal, url: baseURL, httpOnly: true },
  ]);
  return seal;
}

// Every test here starts logged out.
test.use({ storageState: { cookies: [], origins: [] } });

test("a logged-out visitor is sent to /login from every page", async ({
  page,
}) => {
  for (const path of ["/", "/transactions", "/reports", "/settings"]) {
    await page.goto(path);
    await expect(page).toHaveURL("/login");
    await expect(
      page.getByRole("heading", { level: 1, name: "Personal Finances" }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  }
});

test("route handlers answer 401 without a session, the health check does not", async ({
  request,
}) => {
  const unknown = await request.get("/api/anything", { maxRedirects: 0 });
  expect(unknown.status()).toBe(401);

  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
});

test("a wrong password is rejected", async ({ page, context }) => {
  await page.goto("/login");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Log in" }).click();

  // Next.js's route announcer is an alert too, hence the filter.
  await expect(
    page.getByRole("alert").filter({ hasText: "Wrong password." }),
  ).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page).toHaveURL("/login");
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();

  await page.goto("/settings");
  await expect(page).toHaveURL("/login");
});

test("login sets a session cookie, logout clears it", async ({
  page,
  context,
}) => {
  await page.goto("/settings");
  await expect(page).toHaveURL("/login");
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeVisible();

  const session = (await context.cookies()).find(
    (c) => c.name === SESSION_COOKIE,
  );
  expect(session).toBeDefined();
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Lax");
  const days = ((session?.expires ?? 0) * 1000 - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(29.9);
  expect(days).toBeLessThanOrEqual(30);

  // Logged in, the login page leads back to the app.
  await page.goto("/login");
  await expect(page).toHaveURL("/");

  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings" }),
  ).toBeVisible();
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Log out" })
    .click();

  await expect(page).toHaveURL("/login");
  expect(
    (await context.cookies()).find((c) => c.name === SESSION_COOKIE),
  ).toBeUndefined();
  await page.goto("/transactions");
  await expect(page).toHaveURL("/login");
});

test("a day-old session is re-issued with a fresh 30-day expiry", async ({
  page,
  context,
  baseURL,
}) => {
  const oldSeal = await addSessionIssued(context, baseURL!, 2 * DAY_MS);

  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings" }),
  ).toBeVisible();

  const session = (await context.cookies()).find(
    (c) => c.name === SESSION_COOKIE,
  );
  expect(session?.value).toBeDefined();
  expect(session?.value).not.toBe(oldSeal);
  const days = ((session?.expires ?? 0) * 1000 - Date.now()) / DAY_MS;
  expect(days).toBeGreaterThan(29.9);
});

test("logout clears a day-old session instead of re-issuing it", async ({
  page,
  context,
  baseURL,
}) => {
  await addSessionIssued(context, baseURL!, 2 * DAY_MS);
  // Back to "old" after the navigation re-issued it.
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings" }),
  ).toBeVisible();
  await addSessionIssued(context, baseURL!, 2 * DAY_MS);

  await page
    .getByRole("banner")
    .getByRole("button", { name: "Log out" })
    .click();

  await expect(page).toHaveURL("/login");
  expect(
    (await context.cookies()).find((c) => c.name === SESSION_COOKIE),
  ).toBeUndefined();
  await page.goto("/");
  await expect(page).toHaveURL("/login");
});

/** The `pf_session` value a response sets, if any. */
function setSessionCookie(response: APIResponse): string | undefined {
  return response
    .headersArray()
    .find(
      ({ name, value }) =>
        name.toLowerCase() === "set-cookie" &&
        value.startsWith(`${SESSION_COOKIE}=`),
    )?.value;
}

// The race behind the test above, made deterministic: a request the page
// sends in the background (a link prefetch, a client navigation) can still
// be in flight when logout's response deletes the cookie, and a re-issued
// cookie in its later response would log the browser back in. So only a
// page load re-issues; every other request leaves the cookie alone.
test("only a page load re-issues a day-old session, so no background response can outlive logout", async ({
  request,
}) => {
  const seal = await sealSession(E2E_SESSION_SECRET, Date.now() - 2 * DAY_MS);
  const cookie = `${SESSION_COOKIE}=${seal}`;
  const document = {
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };

  const background: Record<string, string>[] = [
    // The router's prefetch and client navigation: fetch() from the page.
    {
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      rsc: "1",
      "next-router-prefetch": "1",
    },
    { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", rsc: "1" },
    // A speculative page load (prerender) the browser may make on its own.
    { ...document, "sec-purpose": "prefetch;prerender" },
  ];
  for (const headers of background) {
    const response = await request.get("/settings", {
      headers: { cookie, ...headers },
      maxRedirects: 0,
    });
    // The session was accepted: the page, or Next's redirect that adds the
    // `_rsc` cache-busting parameter to an RSC request, never the login page.
    expect(response.status(), JSON.stringify(headers)).toBeLessThan(400);
    expect(response.headers().location ?? "").not.toContain(LOGIN_PATH);
    expect(setSessionCookie(response), JSON.stringify(headers)).toBeUndefined();
  }

  const load = await request.get("/settings", {
    headers: { cookie, ...document },
    maxRedirects: 0,
  });
  expect(load.status()).toBe(200);
  const reissued = setSessionCookie(load);
  expect(reissued).toBeDefined();
  expect(reissued).not.toContain(seal);
});
