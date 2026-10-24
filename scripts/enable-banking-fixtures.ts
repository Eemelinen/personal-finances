// Builds tests/fixtures/enable-banking/ from the raw responses that
// scripts/enable-banking-spike.ts recorded in secrets/enable-banking-raw/
// (F-001). Headers are dropped; ids, IBANs, card numbers, hashes,
// continuation keys and person names are replaced with synthetic values,
// consistently across files, so a uid in a request path still matches the
// session's account and a continuation_key still matches the next request.
//
//   pnpm exec tsx scripts/enable-banking-fixtures.ts
//
// The SOURCES map names the raw recordings of the 2026-10-24 sandbox run;
// edit it after a new recording. The run fails if an original identifier
// survives.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const RAW_DIR = "secrets/enable-banking-raw";
const OUT_DIR = "tests/fixtures/enable-banking";

// fixture path → raw recording
const SOURCES: Record<string, string> = {
  "aspsps.json": "aspsps",
  "auth-start.json": "nordea-auth",
  "error-wrong-authorization-code.json": "error-invalid-code",
  "error-account-not-found.json": "error-unknown-account",
  "error-wrong-transactions-period.json":
    "nordea-from-2024-10-24-account-2-transactions-page-1",
  "nordea/session-create.json": "nordea-session-create",
  "nordea/session.json": "nordea-session",
  "nordea/account-details.json": "nordea-account-1-details",
  "nordea/account-balances.json": "nordea-account-1-balances",
  "nordea/transactions-default.json": "nordea-account-1-transactions-page-1",
  "nordea/transactions-page-1.json":
    "nordea-from-2025-05-02-account-2-transactions-page-1",
  "nordea/transactions-page-2.json":
    "nordea-from-2025-05-02-account-2-transactions-page-2",
  "nordea/transactions-page-3.json":
    "nordea-from-2025-05-02-account-2-transactions-page-3",
  "nordea/transactions-page-4.json":
    "nordea-from-2025-05-02-account-2-transactions-page-4",
  "s-pankki/session-create.json": "s-pankki-session-create",
  "s-pankki/account-details.json": "s-pankki-account-1-details",
  "s-pankki/account-balances.json": "s-pankki-account-1-balances",
  "s-pankki/card-details.json": "s-pankki-account-3-details",
  "s-pankki/card-balances.json": "s-pankki-account-3-balances",
  "s-pankki/transactions-page-1.json": "s-pankki-account-1-transactions-page-1",
  "s-pankki/transactions-page-2.json": "s-pankki-account-1-transactions-page-2",
  "s-pankki/transactions-last-page.json":
    "s-pankki-account-1-transactions-page-14",
  "s-pankki/transactions-pending-empty.json": "s-pankki-pending",
};

// Account holders and private counterparties in the sandbox data, some of
// them apparently other developers' test payments.
const NAMES: Record<string, string> = {
  "Aino Salo;Tiina Salo": "Maija Meikäläinen;Matti Meikäläinen",
  "Aino Salo": "Maija Meikäläinen",
  "Tiina Salo": "Matti Meikäläinen",
  "Salo Ari": "Virtanen Ville",
  "Salo Johanna": "Virtanen Liisa",
  Johanna: "Liisa",
  "Simon Baker": "Erik Esimerkki",
  "Petr Haiser": "Pekka Testaaja",
  "Fedor Tyurin": "Teemu Testaaja",
  "Eero Vahteri": "Eino Esimerkki",
  Harry: "Henri",
};

// Long numbers that identify a card or an account outside the IBAN scheme.
const NUMBERS: Record<string, string> = { "4009976448": "4000000001" };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const FI_IBAN = /\bFI\d{16}\b/g;

const uuids = new Map<string, string>();
const ibans = new Map<string, string>();
const tokens = new Map<string, string>();

function fakeUuid(original: string): string {
  const key = original.toLowerCase();
  if (!uuids.has(key)) {
    const n = String(uuids.size + 1).padStart(12, "0");
    uuids.set(key, `00000000-0000-4000-8000-${n}`);
  }
  return uuids.get(key)!;
}

function ibanCheckDigits(country: string, bban: string): string {
  const digits = `${bban}${country}00`.replace(/[A-Z]/g, (c) =>
    String(c.charCodeAt(0) - 55),
  );
  const remainder = BigInt(digits) % BigInt(97);
  return String(BigInt(98) - remainder).padStart(2, "0");
}

function fakeIban(original: string): string {
  if (!ibans.has(original)) {
    const bban = `1234560000${String(ibans.size + 1).padStart(4, "0")}`;
    ibans.set(original, `FI${ibanCheckDigits("FI", bban)}${bban}`);
  }
  return ibans.get(original)!;
}

function fakeToken(kind: string, original: string): string {
  if (!tokens.has(original)) {
    const count = [...tokens.values()].filter((v) =>
      v.startsWith(`${kind}-`),
    ).length;
    tokens.set(original, `${kind}-${count + 1}`);
  }
  return tokens.get(original)!;
}

const HASH_KEYS = new Set([
  "identification_hash",
  "identification_hashes",
  "psu_id_hash",
]);

function anonymise(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => anonymise(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, anonymise(v, k)]),
    );
  }
  if (typeof value !== "string") return value;
  if (HASH_KEYS.has(key)) return fakeToken("hash", value);
  if (key === "continuation_key") return fakeToken("continuation-key", value);
  let text = value.replace(UUID, fakeUuid).replace(FI_IBAN, fakeIban);
  for (const [original, replacement] of Object.entries(NUMBERS)) {
    text = text.replaceAll(original, replacement);
  }
  for (const [original, replacement] of Object.entries(NAMES)) {
    text = text.replace(new RegExp(`\\b${original}\\b`, "g"), replacement);
  }
  return text;
}

function anonymisePath(path: string): string {
  const [pathname, query] = path.split("?");
  const params = new URLSearchParams(query ?? "");
  const key = params.get("continuation_key");
  if (key) params.set("continuation_key", fakeToken("continuation-key", key));
  const anonymised = anonymise(pathname) as string;
  return params.size ? `${anonymised}?${params}` : anonymised;
}

type Raw = {
  request: { method: string; path: string; body?: unknown };
  status: number;
  body: unknown;
};

// The ASPSP list is cut to the banks this app uses, without payment
// products (the app never initiates payments).
function trimAspsps(body: unknown) {
  const { aspsps, ...rest } = body as { aspsps: Record<string, unknown>[] };
  return {
    ...rest,
    aspsps: aspsps
      .filter((aspsp) =>
        ["Nordea", "S-Pankki", "Mock ASPSP"].includes(aspsp.name as string),
      )
      .map((aspsp) =>
        Object.fromEntries(
          Object.entries(aspsp).filter(([key]) => key !== "payments"),
        ),
      ),
  };
}

// Continuation keys are replaced in recording order, so the key a page
// returns gets the same token as the next page's request.
rmSync(OUT_DIR, { recursive: true, force: true });
const originals: string[] = [];
for (const [fixture, source] of Object.entries(SOURCES)) {
  const rawText = readFileSync(join(RAW_DIR, `${source}.json`), "utf8");
  const raw = JSON.parse(rawText) as Raw;
  originals.push(rawText);
  const body = fixture === "aspsps.json" ? trimAspsps(raw.body) : raw.body;
  const out = {
    request: {
      method: raw.request.method,
      path: anonymisePath(raw.request.path),
      ...(raw.request.body ? { body: anonymise(raw.request.body) } : {}),
    },
    status: raw.status,
    body: anonymise(body),
  };
  const file = join(OUT_DIR, fixture);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}

// Fail if anything that identified the original data survived.
const written = Object.keys(SOURCES)
  .map((fixture) => readFileSync(join(OUT_DIR, fixture), "utf8"))
  .join("\n");
const leaks = [
  ...uuids.keys(),
  ...ibans.keys(),
  ...tokens.keys(),
  ...Object.keys(NUMBERS),
  ...Object.keys(NAMES),
].filter((original) => written.toLowerCase().includes(original.toLowerCase()));
const unmappedUuids = (written.match(UUID) ?? []).filter(
  (uuid) => !uuid.startsWith("00000000-0000-4000-8000-"),
);
if (
  leaks.length ||
  unmappedUuids.length ||
  /eyJ[A-Za-z0-9_-]{20}/.test(written)
) {
  console.error(
    "Original identifiers left in the fixtures:",
    leaks,
    unmappedUuids,
  );
  process.exit(1);
}
console.info(
  `${Object.keys(SOURCES).length} fixtures in ${OUT_DIR}: ${uuids.size} ids, ${ibans.size} IBANs, ${tokens.size} hashes and keys replaced (from ${originals.length} recordings)`,
);
