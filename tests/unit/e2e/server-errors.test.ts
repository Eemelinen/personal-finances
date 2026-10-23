import { describe, expect, it } from "vitest";
import { isServerErrorLine } from "../../e2e/support/server-errors";

describe("isServerErrorLine", () => {
  it("flags Next.js error output", () => {
    expect(
      isServerErrorLine(
        'Error: Route "/": Next.js encountered the unstable value `Date.now()`',
      ),
    ).toBe(true);
    expect(isServerErrorLine(" ⨯ TypeError: x is not a function")).toBe(true);
    expect(isServerErrorLine("    at async Page (src/app/page.tsx:3:1)")).toBe(
      false,
    );
  });

  it("lets ordinary log lines through", () => {
    expect(isServerErrorLine("▲ Next.js 16.4.2")).toBe(false);
    expect(isServerErrorLine("[auth] failed login attempt (1 in a row)")).toBe(
      false,
    );
  });
});
