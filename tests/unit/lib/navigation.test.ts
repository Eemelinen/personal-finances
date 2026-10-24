import { describe, expect, it } from "vitest";
import { isActiveHref, NAV_ITEMS } from "@/lib/navigation";

describe("NAV_ITEMS", () => {
  it("lists the six sections in order with unique hrefs", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Dashboard",
      "Transactions",
      "Reports",
      "Investments",
      "Connections",
      "Settings",
    ]);
    expect(new Set(NAV_ITEMS.map((item) => item.href)).size).toBe(6);
  });
});

describe("isActiveHref", () => {
  it("matches the dashboard only on the root path", () => {
    expect(isActiveHref("/", "/")).toBe(true);
    expect(isActiveHref("/transactions", "/")).toBe(false);
  });

  it("matches a section and the pages below it", () => {
    expect(isActiveHref("/transactions", "/transactions")).toBe(true);
    expect(isActiveHref("/transactions/abc", "/transactions")).toBe(true);
  });

  it("does not match a different section with the same prefix", () => {
    expect(isActiveHref("/reports-archive", "/reports")).toBe(false);
    expect(isActiveHref("/", "/reports")).toBe(false);
  });
});
