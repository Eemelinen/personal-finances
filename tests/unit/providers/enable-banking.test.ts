import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/server/env";
import {
  createApplicationJwt,
  createEnableBankingClient,
  ENABLE_BANKING_API_URL,
  EnableBankingApiError,
  enableBankingConfigFromEnv,
  JWT_AUDIENCE,
  JWT_ISSUER,
  type EnableBankingConfig,
} from "@/server/providers/enable-banking/client";
import {
  createEnableBankingProvider,
  mapTransaction,
  toMinorUnits,
} from "@/server/providers/enable-banking/provider";
import type { EnableBankingTransaction } from "@/server/providers/enable-banking/schemas";
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "@/server/providers/errors";
import { fetchAllTransactions } from "@/server/providers/paging";

// Every exchange comes from the F-001 sandbox recordings in
// tests/fixtures/enable-banking/ (README there); a few are derived from them
// where the recording has the data but not the endpoint (noted at each).
// No test touches the network: `fetch` is a stub that serves fixtures.

const FIXTURES = join(process.cwd(), "tests/fixtures/enable-banking");
const NOW = Date.parse("2026-10-24T09:00:00Z"); // 12:00 in Helsinki
const TODAY = "2026-10-24";
const TIME_ZONE = "Europe/Helsinki";
const APP_ID = "00000000-0000-4000-8000-0000000000aa";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const CONFIG: EnableBankingConfig = {
  appId: APP_ID,
  privateKey,
  redirectUrl: "http://localhost:3000/connections/callback",
  environment: "sandbox",
};

interface Exchange {
  request: { method: string; path: string; body?: unknown };
  status: number;
  body: unknown;
}

function fixture(name: string): Exchange {
  return JSON.parse(
    readFileSync(join(FIXTURES, `${name}.json`), "utf8"),
  ) as Exchange;
}

interface SessionCreateBody {
  session_id: string;
  accounts: { uid: string }[];
  aspsp: { name: string; country: string };
  access: { valid_until: string };
}

const NORDEA_SESSION = fixture("nordea/session-create");
const SPANKKI_SESSION = fixture("s-pankki/session-create");
const nordea = NORDEA_SESSION.body as SessionCreateBody;
const spankki = SPANKKI_SESSION.body as SessionCreateBody;
const [nordeaJoint] = nordea.accounts;
const [spankkiCurrent, , spankkiCard] = spankki.accounts;

/** `GET /accounts/{uid}/details` for every account of a `POST /sessions`. */
function detailsOf(session: SessionCreateBody): Exchange[] {
  return session.accounts.map((account) => ({
    request: { method: "GET", path: `/accounts/${account.uid}/details` },
    status: 200,
    body: account,
  }));
}

/** S-Pankki's `GET /sessions/{id}` was not recorded; built from its POST. */
function sessionOf(session: SessionCreateBody, status = "AUTHORIZED") {
  return {
    request: { method: "GET", path: `/sessions/${session.session_id}` },
    status: 200,
    body: {
      status,
      accounts: session.accounts.map(({ uid }) => uid).reverse(),
      aspsp: session.aspsp,
      access: session.access,
    },
  } satisfies Exchange;
}

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const canonical = (path: string) => {
  const url = new URL(path, ENABLE_BANKING_API_URL);
  url.searchParams.sort();
  return `${url.pathname}?${url.searchParams}`;
};

/** A `fetch` that answers each request with the matching exchange. */
function fixtureFetch(exchanges: Exchange[]) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(ENABLE_BANKING_API_URL);
    const call: Call = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const match = exchanges.find(
      ({ request }) =>
        request.method === call.method &&
        canonical(request.path) === canonical(call.path) &&
        (request.body === undefined ||
          JSON.stringify(request.body) === JSON.stringify(call.body)),
    );
    if (!match) throw new Error(`No fixture for ${call.method} ${call.path}`);
    return Response.json(match.body, { status: match.status });
  };
  return { fetchFn, calls };
}

/** A `fetch` that returns the given responses in order. */
function scriptedFetch(responses: (() => Response)[]) {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`Unexpected request ${calls.length}`);
    return next();
  };
  return { fetchFn, calls };
}

function setup(fetchFn: typeof fetch, now: () => number = () => NOW) {
  const sleeps: number[] = [];
  const client = createEnableBankingClient({
    config: CONFIG,
    fetch: fetchFn,
    now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const provider = createEnableBankingProvider({
    client,
    timeZone: TIME_ZONE,
    now,
  });
  return { client, provider, sleeps };
}

const nordeaConnection = { sessionRef: nordea.session_id };
const spankkiConnection = { sessionRef: spankki.session_id };

const errorBody = (status: number, error: string) =>
  Response.json(
    { code: status, message: error, error, detail: null },
    {
      status,
    },
  );

describe("application JWT", () => {
  it("is RS256 with the application id as kid, for the Enable Banking API, valid an hour", async () => {
    const jwt = await createApplicationJwt(CONFIG, new Date(NOW));

    expect(decodeProtectedHeader(jwt)).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: APP_ID,
    });
    const { payload } = await jwtVerify(jwt, publicKey, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      currentDate: new Date(NOW),
    });
    expect(payload).toEqual({
      iss: "enablebanking.com",
      aud: "api.enablebanking.com",
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
  });

  it("is sent as a bearer token, reused, and renewed before it expires", async () => {
    let now = NOW;
    const { fetchFn, calls } = fixtureFetch([fixture("aspsps")]);
    const { client } = setup(fetchFn, () => now);

    await client.getAspsps("FI");
    await client.getAspsps("FI");
    now += 56 * 60_000;
    await client.getAspsps("FI");

    const tokens = calls.map(({ headers }) =>
      headers.authorization.replace(/^Bearer /, ""),
    );
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[0]);
    const { payload } = await jwtVerify(tokens[2], publicKey, {
      currentDate: new Date(now),
    });
    expect(payload.iat).toBe(now / 1000);
  });
});

describe("configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "enable-banking-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const DATABASE_URL = "postgres://user:pass@localhost:5432/finances";

  it("parses ENABLE_BANKING_* and reads the PEM key file", async () => {
    const keyPath = join(dir, "key.pem");
    writeFileSync(
      keyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    );
    const env = parseEnv({
      DATABASE_URL,
      ENABLE_BANKING_APP_ID: APP_ID,
      ENABLE_BANKING_PRIVATE_KEY_PATH: keyPath,
      ENABLE_BANKING_REDIRECT_URL: CONFIG.redirectUrl,
      ENABLE_BANKING_ENV: "production",
    });
    const config = enableBankingConfigFromEnv(env);

    expect(config).toMatchObject({
      appId: APP_ID,
      redirectUrl: CONFIG.redirectUrl,
      environment: "production",
    });
    const jwt = await createApplicationJwt(config, new Date(NOW));
    await expect(
      jwtVerify(jwt, publicKey, { currentDate: new Date(NOW) }),
    ).resolves.toBeDefined();
  });

  it("treats empty values as unset and defaults to the sandbox", () => {
    const env = parseEnv({
      DATABASE_URL,
      ENABLE_BANKING_APP_ID: "",
      ENABLE_BANKING_PRIVATE_KEY_PATH: " ",
      ENABLE_BANKING_REDIRECT_URL: "",
    });

    expect(env).toMatchObject({
      ENABLE_BANKING_APP_ID: undefined,
      ENABLE_BANKING_PRIVATE_KEY_PATH: undefined,
      ENABLE_BANKING_REDIRECT_URL: undefined,
      ENABLE_BANKING_ENV: "sandbox",
    });
    expect(() => enableBankingConfigFromEnv(env)).toThrow(
      /Enable Banking is not configured/,
    );
  });

  it("rejects an invalid redirect URL or environment", () => {
    expect(() =>
      parseEnv({ DATABASE_URL, ENABLE_BANKING_REDIRECT_URL: "callback" }),
    ).toThrow(/ENABLE_BANKING_REDIRECT_URL/);
    expect(() =>
      parseEnv({ DATABASE_URL, ENABLE_BANKING_ENV: "staging" }),
    ).toThrow(/ENABLE_BANKING_ENV/);
  });

  it("names a missing key file without reading on construction", async () => {
    const env = parseEnv({
      DATABASE_URL,
      ENABLE_BANKING_APP_ID: APP_ID,
      ENABLE_BANKING_PRIVATE_KEY_PATH: join(dir, "missing.pem"),
    });
    const client = createEnableBankingClient({
      config: () => enableBankingConfigFromEnv(env),
      fetch: async () => {
        throw new Error("no request expected");
      },
    });

    await expect(client.getAspsps("FI")).rejects.toThrow(
      /Cannot read the Enable Banking private key/,
    );
  });
});

describe("authorisation", () => {
  it("lists the banks of a country", async () => {
    const { fetchFn } = fixtureFetch([fixture("aspsps")]);
    const { provider } = setup(fetchFn);

    const banks = await provider.listBanks("FI");

    expect(banks.map(({ name }) => name)).toEqual([
      "Nordea",
      "S-Pankki",
      "Mock ASPSP",
    ]);
    expect(banks[0]).toEqual({
      name: "Nordea",
      country: "FI",
      maximumConsentSeconds: 15_552_000,
    });
  });

  it("starts an authorisation with the configured redirect URL", async () => {
    const exchange = fixture("auth-start");
    const { fetchFn, calls } = fixtureFetch([exchange]);
    const { provider } = setup(fetchFn);

    const result = await provider.startAuthorization({
      aspsp: { name: "Nordea", country: "FI" },
      state: "00000000-0000-4000-8000-000000000001",
      validUntil: new Date("2027-04-22T06:34:24.369Z"),
    });

    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/auth",
      body: exchange.request.body,
      headers: { "content-type": "application/json" },
    });
    expect(result).toEqual({
      url: "https://tilisy-sandbox.enablebanking.com/ais/start?sessionid=00000000-0000-4000-8000-000000000002",
      authorizationId: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("refuses to start without a redirect URL", async () => {
    const client = createEnableBankingClient({
      config: { ...CONFIG, redirectUrl: undefined },
      fetch: async () => {
        throw new Error("no request expected");
      },
    });

    await expect(
      client.startAuthorization({
        aspsp: { name: "Nordea", country: "FI" },
        state: "s",
        validUntil: new Date(NOW),
      }),
    ).rejects.toThrow(/ENABLE_BANKING_REDIRECT_URL/);
  });

  it("creates the session and maps its accounts, IBAN-less cards included", async () => {
    const { fetchFn, calls } = fixtureFetch([NORDEA_SESSION, SPANKKI_SESSION]);
    const { provider } = setup(fetchFn);

    const created = await provider.completeAuthorization(
      "00000000-0000-4000-8000-000000000006",
    );
    const card = await provider.completeAuthorization(
      (SPANKKI_SESSION.request.body as { code: string }).code,
    );

    expect(calls[0]).toMatchObject({ method: "POST", path: "/sessions" });
    expect(created).toEqual({
      sessionRef: nordea.session_id,
      aspsp: { name: "Nordea", country: "FI" },
      validUntil: "2027-04-22T06:34:24.369000Z",
      accounts: [
        {
          ref: "00000000-0000-4000-8000-000000000005",
          name: "KÄYTTÖTILI ·0001",
          type: "checking",
          currency: "EUR",
          iban: "FI4312345600000001",
        },
        {
          ref: "00000000-0000-4000-8000-000000000008",
          name: "KÄYTTÖTILI ·0002",
          type: "checking",
          currency: "EUR",
          iban: "FI1612345600000002",
        },
        {
          ref: "00000000-0000-4000-8000-000000000009",
          name: "KÄYTTÖTILI ·0003",
          type: "checking",
          currency: "EUR",
          iban: "FI8612345600000003",
        },
      ],
    });
    expect(card.accounts.map(({ name, iban }) => ({ name, iban }))).toEqual([
      { name: "My account nickname ·0004", iban: "FI5912345600000004" },
      { name: "My account nickname ·0005", iban: "FI3212345600000005" },
      { name: "S-Etukortti Visa Credit ·0001", iban: null },
    ]);
  });
});

describe("accounts and balances", () => {
  it("lists the session's accounts in its order, matched by uid", async () => {
    const { fetchFn, calls } = fixtureFetch([
      fixture("nordea/session"),
      fixture("nordea/account-details"),
      ...detailsOf(nordea),
    ]);
    const { provider } = setup(fetchFn);

    const accounts = await provider.listAccounts(nordeaConnection);

    // GET /sessions/{id} lists 9, 5, 8; POST /sessions listed 5, 8, 9.
    expect(accounts.map(({ ref }) => ref.slice(-1))).toEqual(["9", "5", "8"]);
    expect(accounts[1]).toEqual({
      ref: nordeaJoint.uid,
      name: "KÄYTTÖTILI ·0001",
      type: "checking",
      currency: "EUR",
      iban: "FI4312345600000001",
    });
    expect(calls.map(({ path }) => path)).toEqual([
      `/sessions/${nordea.session_id}`,
      "/accounts/00000000-0000-4000-8000-000000000009/details",
      "/accounts/00000000-0000-4000-8000-000000000005/details",
      "/accounts/00000000-0000-4000-8000-000000000008/details",
    ]);
  });

  it.each(["EXPIRED", "REVOKED", "CLOSED"])(
    "reports a %s session as an expired consent",
    async (status) => {
      const { fetchFn } = fixtureFetch([sessionOf(spankki, status)]);
      const { provider } = setup(fetchFn);

      const error = await provider
        .listAccounts(spankkiConnection)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProviderAuthError);
      expect(String(error)).not.toContain(spankki.session_id);
    },
  );

  it("reports a consent past its valid_until as expired", async () => {
    const { fetchFn } = fixtureFetch([fixture("nordea/session")]);
    const { provider } = setup(fetchFn, () =>
      Date.parse("2027-04-23T00:00:00Z"),
    );

    await expect(provider.listAccounts(nordeaConnection)).rejects.toThrow(
      ProviderAuthError,
    );
  });

  it("maps balances to signed minor units, dated today without a reference date", async () => {
    const { fetchFn } = fixtureFetch([fixture("nordea/account-balances")]);
    const { provider } = setup(fetchFn);

    expect(
      await provider.getBalances(nordeaConnection, nordeaJoint.uid),
    ).toEqual([
      {
        amountMinor: 17_138,
        currency: "EUR",
        balanceType: "ITAV",
        date: TODAY,
      },
      {
        amountMinor: 15_928,
        currency: "EUR",
        balanceType: "ITBD",
        date: TODAY,
      },
      {
        amountMinor: 15_928,
        currency: "EUR",
        balanceType: "VALU",
        date: TODAY,
      },
    ]);
  });

  it("keeps the card's ITBD and its credit-limit ITAV on their reference date", async () => {
    const { fetchFn } = fixtureFetch([fixture("s-pankki/card-balances")]);
    const { provider } = setup(fetchFn, () =>
      Date.parse("2026-10-25T09:00:00Z"),
    );

    expect(
      await provider.getBalances(spankkiConnection, spankkiCard.uid),
    ).toEqual([
      {
        amountMinor: 6_121,
        currency: "EUR",
        balanceType: "ITBD",
        date: "2026-10-24",
      },
      {
        amountMinor: 306_121,
        currency: "EUR",
        balanceType: "ITAV",
        date: "2026-10-24",
      },
    ]);
  });

  it("maps the card's details without an IBAN", async () => {
    const { fetchFn } = fixtureFetch([
      sessionOf({ ...spankki, accounts: [spankkiCard] }),
      fixture("s-pankki/card-details"),
    ]);
    const { provider } = setup(fetchFn);

    expect(await provider.listAccounts(spankkiConnection)).toEqual([
      {
        ref: spankkiCard.uid,
        name: "S-Etukortti Visa Credit ·0001",
        type: "checking",
        currency: "EUR",
        iban: null,
      },
    ]);
  });
});

describe("transaction pagination", () => {
  const nordeaPages = [1, 2, 3, 4].map((page) =>
    fixture(`nordea/transactions-page-${page}`),
  );

  it("backfills Nordea from 540 days back, following continuation_key to null", async () => {
    const { fetchFn, calls } = fixtureFetch([
      fixture("nordea/session"),
      ...detailsOf(nordea),
      ...nordeaPages,
    ]);
    const { provider } = setup(fetchFn);

    const transactions = await fetchAllTransactions(
      provider,
      nordeaConnection,
      nordeaJoint.uid,
      {},
    );

    expect(transactions).toHaveLength(140);
    expect(new Set(transactions.map(({ ref }) => ref)).size).toBe(140);
    // One session lookup for the bank and one details lookup for the
    // account's type, then the recorded page requests.
    expect(calls.map(({ path }) => path)).toEqual([
      `/sessions/${nordea.session_id}`,
      `/accounts/${nordeaJoint.uid}/details`,
      ...nordeaPages.map(({ request }) => request.path),
    ]);
    expect(calls[2].path).toContain("date_from=2025-05-02");
  });

  it("clamps a Nordea `from` older than its history to 540 days", async () => {
    const { fetchFn, calls } = fixtureFetch([
      fixture("nordea/session"),
      ...detailsOf(nordea),
      nordeaPages[0],
    ]);
    const { provider } = setup(fetchFn);

    const page = await provider.getTransactions(
      nordeaConnection,
      nordeaJoint.uid,
      { from: "2024-01-01" },
    );

    expect(page.transactions).toHaveLength(40);
    expect(page.continuationKey).toBe("continuation-key-1");
    expect(calls.at(-1)?.path).toBe(nordeaPages[0].request.path);
  });

  // FIN-025: a real Nordea card answered a date_from 540 days back with a
  // 400 ASPSP_ERROR. The sandbox has no Nordea card; its details are the
  // S-Pankki card's (`CARD`, no IBAN) under another uid.
  const nordeaCard = {
    ...(fixture("s-pankki/card-details")
      .body as SessionCreateBody["accounts"][number]),
    uid: "00000000-0000-4000-8000-0000000000c1",
  };
  const nordeaWithCard = {
    ...nordea,
    accounts: [nordeaJoint, nordeaCard],
  };
  const cardTransactions = (query: string): Exchange => ({
    request: {
      method: "GET",
      path: `/accounts/${nordeaCard.uid}/transactions${query}`,
    },
    status: 200,
    body: { transactions: [], continuation_key: null },
  });

  it("asks a Nordea card without date_from on a first sync and from its own `from` later", async () => {
    const { fetchFn, calls } = fixtureFetch([
      sessionOf(nordeaWithCard),
      ...detailsOf(nordeaWithCard),
      cardTransactions(""),
      cardTransactions("?date_from=2024-01-01"),
    ]);
    const { provider } = setup(fetchFn);

    await provider.getTransactions(nordeaConnection, nordeaCard.uid, {});
    await provider.getTransactions(nordeaConnection, nordeaCard.uid, {
      from: "2024-01-01",
    });

    // The card's details are looked up once, then remembered.
    expect(calls.map(({ path }) => path)).toEqual([
      `/sessions/${nordea.session_id}`,
      `/accounts/${nordeaCard.uid}/details`,
      `/accounts/${nordeaCard.uid}/transactions`,
      `/accounts/${nordeaCard.uid}/transactions?date_from=2024-01-01`,
    ]);
  });

  it("knows a card from listAccounts() without looking it up again", async () => {
    const { fetchFn, calls } = fixtureFetch([
      sessionOf(nordeaWithCard),
      ...detailsOf(nordeaWithCard),
      cardTransactions(""),
      nordeaPages[0],
    ]);
    const { provider } = setup(fetchFn);

    await provider.listAccounts(nordeaConnection);
    await provider.getTransactions(nordeaConnection, nordeaCard.uid, {});
    await provider.getTransactions(nordeaConnection, nordeaJoint.uid, {});

    expect(calls.slice(3).map(({ path }) => path)).toEqual([
      `/accounts/${nordeaCard.uid}/transactions`,
      nordeaPages[0].request.path,
    ]);
  });

  it("asks S-Pankki without date_from and passes each key on", async () => {
    const first = fixture("s-pankki/transactions-page-1");
    const second = fixture("s-pankki/transactions-page-2");
    const last = fixture("s-pankki/transactions-last-page");
    const { fetchFn, calls } = fixtureFetch([
      sessionOf(spankki),
      first,
      second,
      last,
    ]);
    const { provider } = setup(fetchFn);

    const page1 = await provider.getTransactions(
      spankkiConnection,
      spankkiCurrent.uid,
      {},
    );
    const page2 = await provider.getTransactions(
      spankkiConnection,
      spankkiCurrent.uid,
      {},
      page1.continuationKey!,
    );
    const lastPage = await provider.getTransactions(
      spankkiConnection,
      spankkiCurrent.uid,
      {},
      "continuation-key-6",
    );

    expect(page1).toMatchObject({ continuationKey: "continuation-key-4" });
    expect(page1.transactions).toHaveLength(100);
    expect(page2).toMatchObject({ continuationKey: "continuation-key-5" });
    expect(page2.transactions).toHaveLength(100);
    expect(lastPage).toMatchObject({ continuationKey: null });
    expect(lastPage.transactions).toHaveLength(3);
    expect(calls.map(({ path }) => path)).toEqual([
      `/sessions/${spankki.session_id}`,
      first.request.path,
      second.request.path,
      last.request.path,
    ]);
  });

  it("keeps paging after an empty page that still has a key", async () => {
    const empty = fixture("s-pankki/transactions-pending-empty");
    const { fetchFn } = fixtureFetch([empty]);
    const { client } = setup(fetchFn);

    const page = await client.getTransactions(spankkiCurrent.uid, {
      transactionStatus: "PDNG",
    });

    expect(page).toEqual({
      transactions: [],
      continuation_key: "continuation-key-7",
    });

    // Through the provider and the paging helper: the empty page is
    // followed to the next one.
    const pages: Exchange[] = [
      {
        request: {
          method: "GET",
          path: `/accounts/${spankkiCurrent.uid}/transactions`,
        },
        status: 200,
        body: { transactions: [], continuation_key: "continuation-key-7" },
      },
      {
        ...fixture("s-pankki/transactions-last-page"),
        request: {
          method: "GET",
          path: `/accounts/${spankkiCurrent.uid}/transactions?continuation_key=continuation-key-7`,
        },
      },
    ];
    const paged = fixtureFetch([sessionOf(spankki), ...pages]);
    const { provider } = setup(paged.fetchFn);

    expect(
      await fetchAllTransactions(
        provider,
        spankkiConnection,
        spankkiCurrent.uid,
        {},
      ),
    ).toHaveLength(3);
  });

  it("retries once from the day a WRONG_TRANSACTIONS_PERIOD names, for a bank without a known limit", async () => {
    const mockBank = {
      ...nordea,
      aspsp: { name: "Mock ASPSP", country: "FI" },
    };
    const { fetchFn, calls } = fixtureFetch([
      sessionOf(mockBank),
      fixture("error-wrong-transactions-period"),
      nordeaPages[0],
    ]);
    const { provider } = setup(fetchFn);

    const page = await provider.getTransactions(
      nordeaConnection,
      nordeaJoint.uid,
      { from: "2024-10-24" },
    );

    expect(page.transactions).toHaveLength(40);
    expect(calls.slice(1).map(({ path }) => path)).toEqual([
      `/accounts/${nordeaJoint.uid}/transactions?date_from=2024-10-24`,
      `/accounts/${nordeaJoint.uid}/transactions?date_from=2025-05-02`,
    ]);
  });

  it("sends `to` as date_to", async () => {
    const { fetchFn, calls } = fixtureFetch([
      sessionOf(spankki),
      {
        request: {
          method: "GET",
          path: `/accounts/${spankkiCurrent.uid}/transactions?date_from=2026-10-01&date_to=2026-10-20`,
        },
        status: 200,
        body: { transactions: [], continuation_key: null },
      },
    ]);
    const { provider } = setup(fetchFn);

    await provider.getTransactions(spankkiConnection, spankkiCurrent.uid, {
      from: "2026-10-01",
      to: "2026-10-20",
    });

    expect(calls).toHaveLength(2);
  });
});

describe("transaction mapping", () => {
  const rows = (name: string) =>
    (fixture(name).body as { transactions: EnableBankingTransaction[] })
      .transactions;
  const nordeaRows = rows("nordea/transactions-page-1");
  const spankkiRows = rows("s-pankki/transactions-page-1");

  it("maps a Nordea credit: debtor as counterparty, reference number left out", () => {
    expect(mapTransaction(nordeaRows[0], TODAY)).toEqual({
      ref: "00000000-0000-4000-8000-000000000010",
      bookingDate: "2026-10-24",
      valueDate: "2026-10-24",
      amountMinor: 1_032,
      currency: "EUR",
      counterparty: "Erik Esimerkki",
      description: "Kiitos",
      status: "booked",
    });
  });

  it("maps a Nordea debit: negative, creditor as counterparty, repeated lines once", () => {
    expect(mapTransaction(nordeaRows[1], TODAY)).toMatchObject({
      amountMinor: -19,
      counterparty: "Virtanen Liisa",
      description: "Kino",
    });
  });

  it("maps an S-Pankki debit with ISO codes and no transaction date", () => {
    expect(mapTransaction(spankkiRows[0], TODAY)).toEqual({
      ref: "00000000-0000-4000-8000-000000000155",
      bookingDate: "2026-10-23",
      valueDate: "2026-10-23",
      amountMinor: -1_000,
      currency: "EUR",
      counterparty: "Inpay A/S",
      description: "wsg8ruhyu9",
      status: "booked",
    });
  });

  it("maps every recorded row: sign from the indicator, entry_reference as ref", () => {
    const names = [
      "nordea/transactions-default",
      ...[1, 2, 3, 4].map((page) => `nordea/transactions-page-${page}`),
      "s-pankki/transactions-page-1",
      "s-pankki/transactions-page-2",
      "s-pankki/transactions-last-page",
    ];
    for (const name of names) {
      for (const row of rows(name)) {
        const mapped = mapTransaction(row, TODAY)!;
        expect(mapped.ref).toBe(row.entry_reference);
        expect(Math.abs(mapped.amountMinor)).toBe(
          toMinorUnits(row.transaction_amount.amount, "EUR"),
        );
        expect(mapped.amountMinor < 0).toBe(
          row.credit_debit_indicator === "DBIT",
        );
        expect(mapped).toMatchObject({
          bookingDate: row.booking_date,
          valueDate: row.value_date,
          currency: "EUR",
          status: "booked",
        });
      }
    }
  });

  const base = nordeaRows[1];

  it("maps pending rows and dates them by the transaction day when unbooked", () => {
    expect(
      mapTransaction(
        {
          ...base,
          status: "PDNG",
          booking_date: null,
          value_date: null,
          transaction_date: "2026-10-23",
        },
        TODAY,
      ),
    ).toMatchObject({
      status: "pending",
      bookingDate: "2026-10-23",
      valueDate: null,
    });
    expect(
      mapTransaction(
        {
          ...base,
          status: "PDNG",
          booking_date: null,
          transaction_date: null,
          value_date: null,
        },
        TODAY,
      ),
    ).toMatchObject({ bookingDate: TODAY });
  });

  it.each(["CNCL", "RJCT", "SCHD", "OTHR"])("drops %s rows", (status) => {
    expect(mapTransaction({ ...base, status }, TODAY)).toBeNull();
  });

  it("falls back to the transaction code's text and to transaction_id", () => {
    expect(
      mapTransaction(
        {
          ...base,
          entry_reference: null,
          transaction_id: "tx-1",
          remittance_information: [base.reference_number!, " "],
        },
        TODAY,
      ),
    ).toMatchObject({ ref: "tx-1", description: "Itsepalvelu" });
    expect(
      mapTransaction(
        {
          ...base,
          entry_reference: null,
          remittance_information: null,
          bank_transaction_code: null,
        },
        TODAY,
      ),
    ).toMatchObject({ ref: null, description: null });
  });

  it("keeps a signed amount without an indicator", () => {
    expect(
      mapTransaction(
        {
          ...base,
          credit_debit_indicator: null,
          transaction_amount: { currency: "EUR", amount: "-12.5" },
        },
        TODAY,
      ),
    ).toMatchObject({ amountMinor: -1_250, counterparty: null });
  });

  it("converts decimal strings to minor units of the currency", () => {
    expect(toMinorUnits("1234.5", "EUR")).toBe(123_450);
    expect(toMinorUnits("0.19", "EUR")).toBe(19);
    expect(toMinorUnits("-3061.21", "EUR")).toBe(-306_121);
    expect(toMinorUnits("1500", "JPY")).toBe(1_500);
    expect(() => toMinorUnits("1e3", "EUR")).toThrow(RangeError);
  });
});

describe("error mapping", () => {
  it("surfaces a 404 ACCOUNT_DOES_NOT_EXIST as an API error without the uid", async () => {
    const exchange = fixture("error-account-not-found");
    const uid = exchange.request.path.split("/")[2];
    const { fetchFn, calls } = fixtureFetch([exchange]);
    const { provider } = setup(fetchFn);

    const error = await provider
      .getBalances(nordeaConnection, uid)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnableBankingApiError);
    expect(error).toMatchObject({
      status: 404,
      code: "ACCOUNT_DOES_NOT_EXIST",
      message:
        "Enable Banking GET /accounts/{uid}/balances → HTTP 404 ACCOUNT_DOES_NOT_EXIST: No account found matching provided id",
    });
    expect((error as Error).message).not.toContain(uid);
    expect(calls).toHaveLength(1);
  });

  it("revokes a session with DELETE /sessions/{id}, with or without a body", async () => {
    const { fetchFn, calls } = scriptedFetch([
      () => Response.json({ message: "OK" }),
      () => new Response(null, { status: 204 }),
    ]);
    const { provider } = setup(fetchFn);

    await provider.revokeSession(nordeaConnection);
    await provider.revokeSession(spankkiConnection);

    expect(calls).toEqual([
      `DELETE /sessions/${nordea.session_id}`,
      `DELETE /sessions/${spankki.session_id}`,
    ]);
  });

  it("reports a session that is already closed as an auth error", async () => {
    const { fetchFn } = scriptedFetch([() => errorBody(422, "CLOSED_SESSION")]);
    const { provider } = setup(fetchFn);

    await expect(
      provider.revokeSession(nordeaConnection),
    ).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("does not retry a wrong authorisation code", async () => {
    const exchange = fixture("error-wrong-authorization-code");
    const { fetchFn, calls } = fixtureFetch([exchange]);
    const { provider } = setup(fetchFn);

    await expect(
      provider.completeAuthorization(
        (exchange.request.body as { code: string }).code,
      ),
    ).rejects.toMatchObject({
      name: "EnableBankingApiError",
      status: 422,
      code: "WRONG_AUTHORIZATION_CODE",
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "ACCESS_DENIED"],
    [422, "EXPIRED_SESSION"],
    [422, "REVOKED_SESSION"],
    [404, "SESSION_DOES_NOT_EXIST"],
  ])("maps HTTP %i %s to ProviderAuthError", async (status, code) => {
    const { fetchFn, calls } = scriptedFetch([() => errorBody(status, code)]);
    const { provider } = setup(fetchFn);

    const error = await provider
      .listAccounts(nordeaConnection)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderAuthError);
    expect(error).toMatchObject({ providerId: "enable_banking" });
    expect((error as Error).cause).toBeInstanceOf(EnableBankingApiError);
    expect(String(error)).not.toContain(nordea.session_id);
    expect(calls).toHaveLength(1);
  });

  it("retries a 429 after Retry-After and then succeeds", async () => {
    const balances = fixture("nordea/account-balances");
    const { fetchFn, calls } = scriptedFetch([
      () =>
        new Response(null, { status: 429, headers: { "Retry-After": "2" } }),
      () => Response.json(balances.body),
    ]);
    const { provider, sleeps } = setup(fetchFn);

    expect(
      await provider.getBalances(nordeaConnection, nordeaJoint.uid),
    ).toHaveLength(3);
    expect(sleeps).toEqual([2_000]);
    expect(calls).toHaveLength(2);
  });

  it("gives up on 429 after three attempts with ProviderRateLimitError", async () => {
    const tooMany = () =>
      new Response(null, { status: 429, headers: { "Retry-After": "5" } });
    const { fetchFn, calls } = scriptedFetch([tooMany, tooMany, tooMany]);
    const { provider, sleeps } = setup(fetchFn);

    await expect(
      provider.getBalances(nordeaConnection, nordeaJoint.uid),
    ).rejects.toMatchObject({
      name: "ProviderRateLimitError",
      retryAfterMs: 5_000,
    });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it("does not wait for a long Retry-After", async () => {
    const { fetchFn, calls } = scriptedFetch([
      () =>
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "3600" },
        }),
    ]);
    const { provider, sleeps } = setup(fetchFn);

    const error = await provider
      .getBalances(nordeaConnection, nordeaJoint.uid)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toMatchObject({ retryAfterMs: 3_600_000 });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("maps the bank's own rate limit without retrying", async () => {
    const { fetchFn, calls } = scriptedFetch([
      () => errorBody(422, "ASPSP_RATE_LIMIT_EXCEEDED"),
    ]);
    const { provider } = setup(fetchFn);

    await expect(
      provider.getBalances(nordeaConnection, nordeaJoint.uid),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(calls).toHaveLength(1);
  });

  it("retries 5xx with a doubling backoff, then ProviderUnavailableError", async () => {
    const down = () => errorBody(503, "SERVICE_UNAVAILABLE");
    const { fetchFn, calls } = scriptedFetch([down, down, down]);
    const { provider, sleeps } = setup(fetchFn);

    const error = await provider
      .getBalances(nordeaConnection, nordeaJoint.uid)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it("recovers from a 502 on the next attempt", async () => {
    const balances = fixture("nordea/account-balances");
    const { fetchFn } = scriptedFetch([
      () => new Response("Bad gateway", { status: 502 }),
      () => Response.json(balances.body),
    ]);
    const { provider, sleeps } = setup(fetchFn);

    await expect(
      provider.getBalances(nordeaConnection, nordeaJoint.uid),
    ).resolves.toHaveLength(3);
    expect(sleeps).toEqual([1_000]);
  });

  it("retries network failures, then ProviderUnavailableError", async () => {
    const offline = () => {
      throw new TypeError("fetch failed");
    };
    const { fetchFn, calls } = scriptedFetch([offline, offline, offline]);
    const { provider } = setup(fetchFn);

    await expect(
      provider.getBalances(nordeaConnection, nordeaJoint.uid),
    ).rejects.toThrow(
      new ProviderUnavailableError(
        "enable_banking",
        "Enable Banking GET /accounts/{uid}/balances is unreachable: fetch failed",
      ),
    );
    expect(calls).toHaveLength(3);
  });

  it("does not repeat POST /sessions after a 5xx (the code is single-use)", async () => {
    const { fetchFn, calls } = scriptedFetch([
      () => errorBody(500, "INTERNAL_ERROR"),
    ]);
    const { provider } = setup(fetchFn);

    await expect(provider.completeAuthorization("code")).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(calls).toEqual(["POST /sessions"]);
  });

  it("rejects a response of the wrong shape without echoing its values", async () => {
    const details = fixture("nordea/account-details");
    const { fetchFn } = scriptedFetch([
      () => Response.json({ ...(details.body as object), currency: undefined }),
    ]);
    const { client } = setup(fetchFn);

    const error = await client
      .getAccountDetails(nordeaJoint.uid)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /^Enable Banking GET \/accounts\/\{uid\}\/details returned an unexpected response:\n {2}currency: /,
    );
    expect((error as Error).message).not.toContain("FI43");
  });
});
