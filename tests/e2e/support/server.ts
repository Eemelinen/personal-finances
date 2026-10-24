/**
 * Playwright's `webServer` for L3 (playwright.config.ts). It starts a
 * throwaway Postgres 18 with Testcontainers, applies the committed migrations,
 * seeds the default categories and rules (as `pnpm db:migrate` does) and the
 * rows no UI can create yet (./fixtures.ts), builds the app and serves the standalone output, which is what the Docker
 * image runs, on 127.0.0.1:E2E_PORT, logging in with the test-only password
 * from ./credentials.ts and the deterministic fake bank (`BANK_PROVIDER=fake`).
 * It never touches the dev database. The database URL goes to
 * ./database.ts's file, so specs can seed data directly.
 *
 *   E2E_PORT=3100        port to serve on (playwright.config.ts sets it)
 *   E2E_SKIP_BUILD=1     reuse an existing `pnpm build` (CI builds once)
 *
 * Error lines the app prints also go to ./server-errors.ts's file, which
 * fails the run in the global teardown.
 *
 * Playwright sends SIGTERM when the run ends; the server and the database are
 * stopped then. If the process is killed outright, Testcontainers' reaper
 * removes the container.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { encodePasswordHash } from "@/server/auth/hash-encoding";
import { hashPassword } from "@/server/auth/password";
import { seedDefaults } from "@/server/categorization/seed";
import { seedE2eFixtures } from "./fixtures";
import {
  E2E_ENCRYPTION_KEY,
  E2E_PASSWORD,
  E2E_SESSION_SECRET,
} from "./credentials";
import { DATABASE_URL_FILE, E2E_TIME_ZONE } from "./database";
import { ERRORS_FILE, isServerErrorLine } from "./server-errors";
import {
  startTestDatabase,
  type TestDatabase,
} from "../../integration/helpers/postgres";

const root = process.cwd();
const port = process.env.E2E_PORT ?? "3100";
const standaloneDir = path.join(root, ".next", "standalone");

let database: TestDatabase | undefined;
let server: ChildProcess | undefined;
let stopping = false;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`)),
    );
  });
}

/** Passes the app's output through and records its error lines. */
function watchOutput(from: Readable, to: Writable): void {
  createInterface({ input: from, crlfDelay: Infinity }).on("line", (line) => {
    to.write(`${line}\n`);
    if (isServerErrorLine(line)) {
      appendFileSync(path.join(root, ERRORS_FILE), `${line}\n`);
    }
  });
}

async function stop(exitCode: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    if (server && server.exitCode === null) server.kill("SIGTERM");
    await database?.stop().catch((error: unknown) => {
      console.error("[e2e] stopping the test database failed:", error);
    });
  }
  process.exit(exitCode);
}

process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));

async function main(): Promise<void> {
  console.info("[e2e] starting Postgres 18 (Testcontainers)…");
  database = await startTestDatabase();
  // What the Compose `migrate` service does after the migrations.
  await seedDefaults(database.db);
  await seedE2eFixtures(database.db);

  if (process.env.E2E_SKIP_BUILD === "1") {
    console.info("[e2e] E2E_SKIP_BUILD=1: using the existing build");
  } else {
    await run("pnpm", ["build"]);
  }

  const serverJs = path.join(standaloneDir, "server.js");
  if (!existsSync(serverJs)) {
    throw new Error(`${serverJs} is missing; run pnpm build first`);
  }
  // `output: "standalone"` leaves static assets out of the bundle; the
  // Dockerfile copies them in the same way.
  cpSync(
    path.join(root, ".next", "static"),
    path.join(standaloneDir, ".next", "static"),
    {
      recursive: true,
    },
  );
  cpSync(path.join(root, "public"), path.join(standaloneDir, "public"), {
    recursive: true,
  });

  mkdirSync(path.dirname(path.join(root, ERRORS_FILE)), { recursive: true });
  // For specs that seed the database directly (./database.ts).
  writeFileSync(path.join(root, DATABASE_URL_FILE), database.url);

  console.info(`[e2e] serving the standalone build on 127.0.0.1:${port}`);
  server = spawn(process.execPath, [serverJs], {
    cwd: standaloneDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: port,
      HOSTNAME: "127.0.0.1",
      DATABASE_URL: database.url,
      AUTH_PASSWORD_HASH: encodePasswordHash(await hashPassword(E2E_PASSWORD)),
      SESSION_SECRET: E2E_SESSION_SECRET,
      APP_TIMEZONE: E2E_TIME_ZONE,
      BANK_PROVIDER: "fake",
      ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
    },
  });
  watchOutput(server.stdout!, process.stdout);
  watchOutput(server.stderr!, process.stderr);
  server.on("exit", (code) => {
    if (!stopping) {
      console.error(`[e2e] the app server exited with ${code}`);
      void stop(code ?? 1);
    }
  });
}

main().catch((error: unknown) => {
  console.error("[e2e]", error);
  void stop(1);
});
