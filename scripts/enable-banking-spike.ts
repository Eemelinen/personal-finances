// Enable Banking access spike (F-001). Talks to the real API with the
// application in .env and writes every raw response to
// secrets/enable-banking-raw/ (gitignored); the anonymised copies under
// tests/fixtures/enable-banking/ are built from those by
// scripts/enable-banking-fixtures.ts.
//
//   pnpm exec tsx --env-file=.env scripts/enable-banking-spike.ts aspsps
//   … auth "<bank name>"     prints the bank's authorisation URL
//   … session <code>         creates the session and fetches every account
//   … fetch <session id> [date_from]  fetches the session's accounts again
//   … error                  records error responses
//   … get <name> <path>      records any GET, e.g. a query variant
//
// Not part of the app: no getEnv(), no imports from src/.
import { createSign, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.enablebanking.com";
const COUNTRY = "FI";
const RAW_DIR = "secrets/enable-banking-raw";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (run with --env-file=.env)`);
  return value;
}

function jwt(): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({
    typ: "JWT",
    alg: "RS256",
    kid: requireEnv("ENABLE_BANKING_APP_ID"),
  });
  const claims = encode({
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: now,
    exp: now + 3600,
  });
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(readFileSync(requireEnv("ENABLE_BANKING_PRIVATE_KEY_PATH")))
    .toString("base64url");
  return `${header}.${claims}.${signature}`;
}

// The fields of the responses this script reads; everything else is only
// written to disk.
type Body = {
  continuation_key?: string | null;
  aspsps?: { name: string; maximum_consent_validity?: number }[];
  url?: string;
  session_id?: string;
  aspsp?: { name?: string };
  // Objects with a uid from POST /sessions, uid strings from GET /sessions/{id}.
  accounts?: ({ uid: string } | string)[];
};

type Recorded = { status: number; headers: Record<string, string>; body: Body };

async function call(
  name: string,
  method: string,
  path: string,
  body?: object,
): Promise<Recorded> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const recorded: Recorded = {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: text ? JSON.parse(text) : null,
  };
  mkdirSync(RAW_DIR, { recursive: true });
  const file = join(RAW_DIR, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({ request: { method, path, body }, ...recorded }, null, 2),
  );
  console.info(
    `${method} ${path.split("?")[0]} → ${response.status} (${file})`,
  );
  return recorded;
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-");

async function fetchAccounts(
  prefix: string,
  accounts: { uid: string }[],
  dateFrom?: string,
) {
  for (const [index, { uid }] of accounts.entries()) {
    const base = `${prefix}-account-${index + 1}`;
    await call(`${base}-details`, "GET", `/accounts/${uid}/details`);
    await call(`${base}-balances`, "GET", `/accounts/${uid}/balances`);
    // Without date_from the bank's default window is returned.
    let continuationKey: string | null = null;
    let page = 1;
    do {
      const params = new URLSearchParams();
      if (dateFrom) params.set("date_from", dateFrom);
      if (continuationKey) params.set("continuation_key", continuationKey);
      const query: string = params.size ? `?${params}` : "";
      const { status, body } = await call(
        `${base}-transactions-page-${page}`,
        "GET",
        `/accounts/${uid}/transactions${query}`,
      );
      if (status !== 200) break;
      continuationKey = body.continuation_key ?? null;
      page += 1;
    } while (continuationKey && page <= 50);
  }
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  switch (command) {
    case "aspsps": {
      await call("application", "GET", "/application");
      await call("aspsps", "GET", `/aspsps?country=${COUNTRY}`);
      break;
    }
    case "auth": {
      if (!argument) throw new Error('usage: auth "<bank name>"');
      const { body } = await call(
        "aspsps",
        "GET",
        `/aspsps?country=${COUNTRY}`,
      );
      const aspsp = body.aspsps?.find(
        (candidate) => candidate.name === argument,
      );
      if (!aspsp) throw new Error(`no ASPSP named ${argument} in ${COUNTRY}`);
      const seconds: number = aspsp.maximum_consent_validity ?? 90 * 86400;
      const auth = await call(`${slug(argument)}-auth`, "POST", "/auth", {
        access: {
          valid_until: new Date(Date.now() + seconds * 1000).toISOString(),
        },
        aspsp: { name: aspsp.name, country: COUNTRY },
        state: randomUUID(),
        redirect_url: requireEnv("ENABLE_BANKING_REDIRECT_URL"),
        psu_type: "personal",
      });
      if (auth.status === 200) {
        console.info(`\nOpen in a browser:\n${auth.body.url}\n`);
        console.info(
          "After the bank redirects, copy `code` from the address bar and run `session <code>`.",
        );
      }
      break;
    }
    case "session": {
      if (!argument) throw new Error("usage: session <code>");
      const session = await call("session-create", "POST", "/sessions", {
        code: argument,
      });
      if (session.status !== 200) break;
      const prefix = slug(session.body.aspsp?.name ?? "bank");
      writeFileSync(
        join(RAW_DIR, `${prefix}-session-create.json`),
        readFileSync(join(RAW_DIR, "session-create.json")),
      );
      await call(
        `${prefix}-session`,
        "GET",
        `/sessions/${session.body.session_id}`,
      );
      await fetchAccounts(
        prefix,
        (session.body.accounts ?? []) as { uid: string }[],
      );
      console.info(`\nsession_id: ${session.body.session_id}`);
      break;
    }
    case "fetch": {
      if (!argument) throw new Error("usage: fetch <session id> [date_from]");
      const dateFrom = process.argv[4];
      const session = await call("session", "GET", `/sessions/${argument}`);
      if (session.status !== 200) break;
      const prefix = `${slug(session.body.aspsp?.name ?? "bank")}-${dateFrom ? `from-${dateFrom}` : "refetch"}`;
      await fetchAccounts(
        prefix,
        ((session.body.accounts ?? []) as string[]).map((uid) => ({ uid })),
        dateFrom,
      );
      break;
    }
    case "error": {
      await call(
        "error-unknown-account",
        "GET",
        `/accounts/${randomUUID()}/balances`,
      );
      await call("error-invalid-code", "POST", "/sessions", {
        code: randomUUID(),
      });
      break;
    }
    case "get": {
      const path = process.argv[4];
      if (!argument || !path) throw new Error("usage: get <name> <path>");
      await call(argument, "GET", path);
      break;
    }
    default:
      throw new Error(
        "commands: aspsps | auth <bank> | session <code> | fetch <id> [date_from] | error | get <name> <path>",
      );
  }
}

await main();
