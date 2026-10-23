/**
 * `pnpm auth:hash` — prints the AUTH_PASSWORD_HASH line for a password.
 *
 * On a terminal it asks for the password twice without echoing it, so it
 * never lands in the shell history; otherwise it reads the first line of
 * stdin (`printf '%s' "$PW" | pnpm --silent auth:hash`).
 */
import { encodePasswordHash } from "./hash-encoding";
import { hashPassword } from "./password";

function promptHidden(question: string): Promise<string> {
  const { stdin, stderr } = process;
  return new Promise((resolve, reject) => {
    let value = "";
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          finish();
          reject(new Error("cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };
    stdin.on("data", onData);
  });
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readStdinLine();
  const password = await promptHidden("Password: ");
  const again = await promptHidden("Repeat password: ");
  if (password !== again) throw new Error("the passwords do not match");
  return password;
}

async function main() {
  const password = await readPassword();
  if (password.length < 8) {
    throw new Error("use a password of at least 8 characters");
  }
  const phc = await hashPassword(password);
  process.stdout.write(`AUTH_PASSWORD_HASH=${encodePasswordHash(phc)}\n`);
}

main().catch((error: unknown) => {
  console.error(
    `auth:hash: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
