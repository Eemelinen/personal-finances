import { execFile } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodePasswordHash } from "@/server/auth/hash-encoding";
import { verifyPassword } from "@/server/auth/password";

const cli = path.resolve("src/server/auth/hash-password.ts");

// `pnpm auth:hash` with the password piped in (the non-terminal path).
function runCli(
  input: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["--import", "tsx", cli],
      (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin?.end(input);
  });
}

describe("pnpm auth:hash", () => {
  it("prints an AUTH_PASSWORD_HASH line that verifies the password", async () => {
    const { code, stdout } = await runCli("correct horse battery\n");

    expect(code).toBe(0);
    const match = /^AUTH_PASSWORD_HASH=(\S+)\n$/.exec(stdout);
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain("$");
    const phc = decodePasswordHash(match![1]!);
    expect(phc).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(phc!, "correct horse battery")).toBe(true);
  });

  it("refuses a short password", async () => {
    const { code, stdout, stderr } = await runCli("short\n");

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/at least 8 characters/);
  });
});
