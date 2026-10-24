import { describe, expect, it } from "vitest";
import { parseEnv } from "@/server/env";
import {
  isProviderError,
  parseRetryAfter,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  providerErrorFromStatus,
} from "@/server/providers/errors";
import {
  createFakeProvider,
  FAKE_ACCOUNTS,
  FAKE_AUTHORIZATION_CODES,
  FAKE_BANK_PATH,
  fakeAuthorizationCode,
  FAKE_RETRY_AFTER_MS,
  FAKE_SESSION_REFS,
  FAKE_TRANSACTION_PAGE_SIZE,
} from "@/server/providers/fake";
import { fetchAllTransactions } from "@/server/providers/paging";
import {
  asBankConnector,
  createProviderRegistry,
  defaultProviders,
  getBankConnector,
  getBankProvider,
  UnknownProviderError,
} from "@/server/providers/registry";
import type {
  FinancialProvider,
  ProviderTransaction,
} from "@/server/providers/types";

const DATABASE_URL = "postgres://user:pass@localhost:5432/finances";
const NOW = new Date("2026-10-23T09:30:00Z");
const session = { sessionRef: FAKE_SESSION_REFS.valid };
const [checking, savings] = FAKE_ACCOUNTS;

function stubProvider(id: FinancialProvider["id"]): FinancialProvider {
  return {
    id,
    listAccounts: async () => [],
    getBalances: async () => [],
    getTransactions: async () => ({ transactions: [], continuationKey: null }),
  };
}

describe("provider registry", () => {
  it("looks a provider up by its id", () => {
    const fake = createFakeProvider();
    const csv = stubProvider("csv");
    const registry = createProviderRegistry([fake, csv]);

    expect(registry.get("fake")).toBe(fake);
    expect(registry.get("csv")).toBe(csv);
    expect(registry.has("fake")).toBe(true);
    expect(registry.ids()).toEqual(["fake", "csv"]);
  });

  it("throws UnknownProviderError for unregistered or unknown ids", () => {
    const registry = createProviderRegistry([createFakeProvider()]);

    expect(registry.has("enable_banking")).toBe(false);
    expect(() => registry.get("enable_banking")).toThrow(UnknownProviderError);
    expect(() => registry.get("no-such-provider")).toThrow(
      /No provider registered for "no-such-provider"/,
    );
  });

  it("refuses to register an id twice", () => {
    expect(() =>
      createProviderRegistry([stubProvider("csv"), stubProvider("csv")]),
    ).toThrow(/registered twice/);
  });

  it("selects the bank provider with BANK_PROVIDER", () => {
    const fakeEnv = parseEnv({ DATABASE_URL, BANK_PROVIDER: "fake" });
    const registry = createProviderRegistry(defaultProviders(fakeEnv));

    expect(getBankProvider(fakeEnv, registry).id).toBe("fake");
  });

  it("defaults to Enable Banking and registers the fake only when selected", () => {
    const env = parseEnv({ DATABASE_URL });
    const registry = createProviderRegistry(defaultProviders(env));

    expect(env.BANK_PROVIDER).toBe("enable_banking");
    expect(registry.has("fake")).toBe(false);
    expect(registry.has("kraken")).toBe(true);
    // Registered without ENABLE_BANKING_*: the configuration loads on use.
    expect(getBankProvider(env, registry).id).toBe("enable_banking");
  });

  it("returns the bank provider as a connector, and refuses one that cannot connect", () => {
    for (const env of [
      parseEnv({ DATABASE_URL }),
      parseEnv({ DATABASE_URL, BANK_PROVIDER: "fake" }),
    ]) {
      const registry = createProviderRegistry(defaultProviders(env));
      expect(getBankConnector(env, registry).id).toBe(env.BANK_PROVIDER);
    }
    expect(() => asBankConnector(stubProvider("csv"))).toThrow(
      /csv cannot connect banks/,
    );
  });

  it("rejects an unknown BANK_PROVIDER", () => {
    expect(() => parseEnv({ DATABASE_URL, BANK_PROVIDER: "csv" })).toThrow(
      /BANK_PROVIDER/,
    );
  });
});

describe("provider error mapping", () => {
  it.each([401, 403])("maps HTTP %i to ProviderAuthError", (status) => {
    const error = providerErrorFromStatus("enable_banking", status);

    expect(error).toBeInstanceOf(ProviderAuthError);
    expect(error).toMatchObject({
      kind: "auth_expired",
      providerId: "enable_banking",
      name: "ProviderAuthError",
    });
  });

  it("maps HTTP 429 to ProviderRateLimitError with Retry-After", () => {
    const seconds = providerErrorFromStatus("enable_banking", 429, {
      retryAfter: "120",
    });
    const httpDate = providerErrorFromStatus("enable_banking", 429, {
      retryAfter: "Fri, 23 Oct 2026 09:31:00 GMT",
      now: NOW,
    });
    const absent = providerErrorFromStatus("enable_banking", 429);

    expect(seconds).toBeInstanceOf(ProviderRateLimitError);
    expect(seconds).toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 120_000,
    });
    expect(httpDate).toMatchObject({ retryAfterMs: 60_000 });
    expect(absent).toMatchObject({ retryAfterMs: null });
  });

  it.each([408, 500, 502, 503, 504])(
    "maps HTTP %i to ProviderUnavailableError",
    (status) => {
      expect(providerErrorFromStatus("enable_banking", status)).toBeInstanceOf(
        ProviderUnavailableError,
      );
    },
  );

  it.each([400, 404, 422])("leaves HTTP %i to the caller (a bug)", (status) => {
    expect(providerErrorFromStatus("enable_banking", status)).toBeUndefined();
  });

  it("keeps the cause and is recognised as a provider error", () => {
    const cause = new Error("socket hang up");
    const error = providerErrorFromStatus("enable_banking", 503, { cause });

    expect(error?.cause).toBe(cause);
    expect(isProviderError(error)).toBe(true);
    expect(isProviderError(new Error("other"))).toBe(false);
  });

  it("parses Retry-After defensively", () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(" 5 ")).toBe(5_000);
    // A date in the past means "now", not a negative wait.
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", NOW)).toBe(0);
  });
});

describe("fake provider", () => {
  const fake = createFakeProvider({ now: () => NOW });

  it("lists the synthetic accounts", async () => {
    const accounts = await fake.listAccounts(session);

    expect(accounts).toEqual(FAKE_ACCOUNTS);
    expect(accounts.map((account) => account.type)).toEqual([
      "checking",
      "savings",
    ]);
  });

  it("returns the same transactions on every call and from every instance", async () => {
    const range = { from: "2026-09-01", to: "2026-09-30" };
    const first = await fetchAllTransactions(
      fake,
      session,
      checking.ref,
      range,
    );
    const second = await fetchAllTransactions(
      createFakeProvider({ now: () => new Date("2027-01-01T00:00:00Z") }),
      session,
      checking.ref,
      range,
    );

    expect(first.length).toBeGreaterThan(3);
    expect(second).toEqual(first);
    expect(first[0]).toEqual(
      expect.objectContaining({
        bookingDate: "2026-09-01",
        amountMinor: -95_000,
      }),
    );
  });

  it("returns a day's transactions the same whatever range contains it", async () => {
    const day = "2026-10-15";
    const alone = await fetchAllTransactions(fake, session, checking.ref, {
      from: day,
      to: day,
    });
    const month = await fetchAllTransactions(fake, session, checking.ref, {
      from: "2026-10-01",
      to: "2026-10-20",
    });

    expect(alone).toEqual(month.filter((txn) => txn.bookingDate === day));
    expect(alone).toContainEqual(
      expect.objectContaining({
        amountMinor: 350_000,
        counterparty: "Example Employer",
      }),
    );
  });

  it("returns well-formed DTOs in integer minor units with unique refs", async () => {
    const txns = await fetchAllTransactions(fake, session, checking.ref, {
      from: "2025-01-01",
    });
    const refs = new Set(txns.map((txn) => txn.ref));

    expect(refs.size).toBe(txns.length);
    for (const txn of txns) {
      expect(Number.isSafeInteger(txn.amountMinor)).toBe(true);
      expect(txn.currency).toBe("EUR");
      expect(txn.bookingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("clamps the range to the account's life and today, today pending", async () => {
    const txns = await fetchAllTransactions(fake, session, checking.ref, {
      from: "2020-01-01",
      to: "2030-01-01",
    });
    const dates = txns.map((txn) => txn.bookingDate);
    const pending = txns.filter((txn) => txn.status === "pending");

    expect(dates[0]).toBe("2025-01-01");
    expect(dates.at(-1)! <= "2026-10-23").toBe(true);
    expect(pending.every((txn) => txn.bookingDate === "2026-10-23")).toBe(true);
    expect(
      await fetchAllTransactions(fake, session, checking.ref, {
        from: "2026-10-24",
      }),
    ).toEqual([]);
  });

  it("reports balances that agree with the transaction history", async () => {
    const sum = (txns: ProviderTransaction[], status: string) =>
      txns
        .filter((txn) => txn.status === status)
        .reduce((total, txn) => total + txn.amountMinor, 0);

    for (const [account, opening] of [
      [checking, 250_000],
      [savings, 1_000_000],
    ] as const) {
      const txns = await fetchAllTransactions(fake, session, account.ref, {
        from: "2025-01-01",
      });
      const balances = await fake.getBalances(session, account.ref);

      expect(balances).toEqual([
        {
          amountMinor: opening + sum(txns, "booked"),
          currency: "EUR",
          balanceType: "CLBD",
          date: "2026-10-22",
        },
        {
          amountMinor: opening + sum(txns, "booked") + sum(txns, "pending"),
          currency: "EUR",
          balanceType: "ITAV",
          date: "2026-10-23",
        },
      ]);
    }
  });

  it("fails with the typed errors for the special session refs", async () => {
    const ref = (sessionRef: string) => ({ sessionRef });

    await expect(
      fake.listAccounts(ref(FAKE_SESSION_REFS.expired)),
    ).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(fake.listAccounts(ref(""))).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
    await expect(
      fake.getBalances(ref(FAKE_SESSION_REFS.rateLimited), checking.ref),
    ).rejects.toMatchObject({
      kind: "rate_limited",
      providerId: "fake",
      retryAfterMs: FAKE_RETRY_AFTER_MS,
    });
    await expect(
      fake.getTransactions(ref(FAKE_SESSION_REFS.unavailable), checking.ref, {
        from: "2026-10-01",
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("rejects unknown accounts and invalid dates", async () => {
    await expect(fake.getBalances(session, "nope")).rejects.toThrow(
      /Unknown fake account/,
    );
    await expect(
      fake.getTransactions(session, checking.ref, { from: "2026-02-30" }),
    ).rejects.toThrow(RangeError);
  });
});

describe("transaction paging", () => {
  const range = { from: "2026-01-01", to: "2026-03-31" };

  it("splits a listing into pages that add up to the whole", async () => {
    const paged = createFakeProvider({
      now: () => NOW,
      transactionPageSize: 7,
    });
    const first = await paged.getTransactions(session, checking.ref, range);
    const second = await paged.getTransactions(
      session,
      checking.ref,
      range,
      first.continuationKey!,
    );
    const whole = await fetchAllTransactions(
      createFakeProvider({ now: () => NOW, transactionPageSize: 10_000 }),
      session,
      checking.ref,
      range,
    );

    expect(first.transactions).toHaveLength(7);
    expect(first.continuationKey).toBe("7");
    expect(second.transactions).toEqual(whole.slice(7, 14));
    expect(
      await fetchAllTransactions(paged, session, checking.ref, range),
    ).toEqual(whole);
    expect(whole.length).toBeGreaterThan(FAKE_TRANSACTION_PAGE_SIZE / 2);
  });

  it("starts at the oldest available day when the range has no start", async () => {
    const all = await fetchAllTransactions(fake(), session, checking.ref, {});

    expect(all[0].bookingDate).toBe("2025-01-01");
    expect(all).toEqual(
      await fetchAllTransactions(fake(), session, checking.ref, {
        from: "2025-01-01",
      }),
    );
  });

  it("rejects continuation keys the fake did not hand out", async () => {
    for (const key of ["", "0", "-5", "abc", "07"]) {
      await expect(
        fake().getTransactions(session, checking.ref, range, key),
      ).rejects.toThrow(/Invalid fake continuation key/);
    }
  });

  it("stops a provider that keeps paging", async () => {
    let calls = 0;
    const looping: FinancialProvider = {
      ...stubProvider("fake"),
      getTransactions: async () => {
        calls++;
        return { transactions: [], continuationKey: "again" };
      },
    };
    const endless: FinancialProvider = {
      ...stubProvider("fake"),
      getTransactions: async () => {
        calls++;
        return { transactions: [], continuationKey: String(calls) };
      },
    };

    await expect(
      fetchAllTransactions(looping, session, checking.ref, range),
    ).rejects.toThrow(/kept paging/);
    expect(calls).toBe(2);
    calls = 0;
    await expect(
      fetchAllTransactions(endless, session, checking.ref, range, 5),
    ).rejects.toThrow(/kept paging/);
    expect(calls).toBe(5);
  });

  function fake() {
    return createFakeProvider({ now: () => NOW });
  }
});

describe("fake bank authorisation", () => {
  const provider = createFakeProvider();
  const nordea = { name: "Nordea", country: "FI" };
  const validUntil = new Date("2027-04-22T09:00:00.000Z");

  it("lists Nordea and S-Pankki with a 180-day consent", async () => {
    expect(await provider.listBanks("FI")).toEqual([
      { name: "Nordea", country: "FI", maximumConsentSeconds: 15_552_000 },
      { name: "S-Pankki", country: "FI", maximumConsentSeconds: 15_552_000 },
    ]);
    expect(await provider.listBanks("SE")).toEqual([]);
  });

  it("sends the user to the stand-in bank with the state and an approving code", async () => {
    const { url } = await provider.startAuthorization({
      aspsp: nordea,
      state: "the-state",
      validUntil,
    });
    const parsed = new URL(url, "http://app.test");

    expect(parsed.pathname).toBe(FAKE_BANK_PATH);
    expect(parsed.searchParams.get("state")).toBe("the-state");
    expect(parsed.searchParams.get("bank")).toBe("Nordea");
    expect(parsed.searchParams.get("code")).toBe(
      fakeAuthorizationCode(nordea, validUntil),
    );
    await expect(
      provider.startAuthorization({
        aspsp: { name: "Other Bank", country: "FI" },
        state: "s",
        validUntil,
      }),
    ).rejects.toThrow(/Unknown fake bank/);
  });

  it("completes with the bank, the consent end and the fake accounts", async () => {
    expect(
      await provider.completeAuthorization(
        fakeAuthorizationCode(nordea, validUntil),
      ),
    ).toEqual({
      sessionRef: FAKE_SESSION_REFS.valid,
      aspsp: nordea,
      validUntil: validUntil.toISOString(),
      accounts: FAKE_ACCOUNTS,
    });
  });

  it("rejects unknown codes and can play an unavailable bank", async () => {
    await expect(
      provider.completeAuthorization("nonsense"),
    ).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(
      provider.completeAuthorization(
        fakeAuthorizationCode({ name: "Other", country: "FI" }, validUntil),
      ),
    ).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(
      provider.completeAuthorization(FAKE_AUTHORIZATION_CODES.unavailable),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("revokes a valid session and reports an expired one", async () => {
    await expect(
      provider.revokeSession({ sessionRef: FAKE_SESSION_REFS.valid }),
    ).resolves.toBeUndefined();
    await expect(
      provider.revokeSession({ sessionRef: FAKE_SESSION_REFS.expired }),
    ).rejects.toBeInstanceOf(ProviderAuthError);
  });
});
