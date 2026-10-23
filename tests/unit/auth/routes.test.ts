import { describe, expect, it } from "vitest";
import {
  accessDecision,
  isApiPath,
  isHealthPath,
  isPublicPath,
  isServerActionRequest,
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

describe("isServerActionRequest", () => {
  it("matches only POSTs that carry the Next-Action header", () => {
    const action = new Headers({ "Next-Action": "7f3a" });
    expect(isServerActionRequest("POST", action)).toBe(true);
    expect(isServerActionRequest("GET", action)).toBe(false);
    expect(isServerActionRequest("POST", new Headers())).toBe(false);
  });
});
