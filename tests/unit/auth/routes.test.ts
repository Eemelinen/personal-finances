import { describe, expect, it } from "vitest";
import {
  accessDecision,
  isApiPath,
  isHealthPath,
  isPublicPath,
  mayReissueSession,
} from "@/lib/auth/routes";

describe("isPublicPath", () => {
  it("lets only the login page and the health check through", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/login/")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);

    for (const path of [
      "/",
      "/transactions",
      "/settings",
      "/login/other",
      "/loginx",
      "/api/health/x",
      "/api/other",
    ]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });
});

describe("isApiPath", () => {
  it("matches route handlers under /api", () => {
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api/accounts")).toBe(true);
    expect(isApiPath("/apiary")).toBe(false);
    expect(isApiPath("/")).toBe(false);
  });
});

describe("isHealthPath", () => {
  it("matches only the health check", () => {
    expect(isHealthPath("/api/health")).toBe(true);
    expect(isHealthPath("/api/health/")).toBe(true);
    expect(isHealthPath("/api/healthz")).toBe(false);
    expect(isHealthPath("/login")).toBe(false);
  });
});

describe("accessDecision", () => {
  it("sends visitors without a session to the login page, or 401 under /api", () => {
    expect(accessDecision("/", false)).toBe("redirect-to-login");
    expect(accessDecision("/settings", false)).toBe("redirect-to-login");
    expect(accessDecision("/api/accounts", false)).toBe("unauthorized");
    expect(accessDecision("/login", false)).toBe("allow");
    expect(accessDecision("/api/health", false)).toBe("allow");
  });

  it("lets a session through and moves it off the login page", () => {
    expect(accessDecision("/", true)).toBe("allow");
    expect(accessDecision("/api/accounts", true)).toBe("allow");
    expect(accessDecision("/login", true)).toBe("redirect-to-app");
    expect(accessDecision("/login/", true)).toBe("redirect-to-app");
  });
});

describe("mayReissueSession", () => {
  const navigate = {
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
  };

  it("allows a page load", () => {
    expect(mayReissueSession("GET", new Headers(navigate))).toBe(true);
    expect(mayReissueSession("HEAD", new Headers(navigate))).toBe(true);
  });

  it("refuses fetches from a page: prefetches, client navigations, actions", () => {
    const fetchFromPage = new Headers({
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    });
    expect(mayReissueSession("GET", fetchFromPage)).toBe(false);
    expect(
      mayReissueSession(
        "POST",
        new Headers({ "Sec-Fetch-Mode": "cors", "Next-Action": "7f3a" }),
      ),
    ).toBe(false);
  });

  it("refuses a form POST even as a navigation (an action without JavaScript)", () => {
    expect(mayReissueSession("POST", new Headers(navigate))).toBe(false);
  });

  it("refuses speculative page loads", () => {
    const purposes: Record<string, string>[] = [
      { "Sec-Purpose": "prefetch" },
      { "Sec-Purpose": "prefetch;prerender" },
      { Purpose: "prefetch" },
    ];
    for (const purpose of purposes) {
      expect(
        mayReissueSession("GET", new Headers({ ...navigate, ...purpose })),
      ).toBe(false);
    }
  });

  it("refuses a request without Fetch Metadata", () => {
    expect(mayReissueSession("GET", new Headers())).toBe(false);
  });
});
