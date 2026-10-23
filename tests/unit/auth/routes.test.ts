import { describe, expect, it } from "vitest";
import { isApiPath, isPublicPath } from "@/lib/auth/routes";

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
