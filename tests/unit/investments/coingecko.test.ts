import { describe, expect, it } from "vitest";
import {
  createCoinGeckoClient,
  numberToDecimal,
} from "@/server/investments/coingecko";
import { PriceApiError } from "@/server/investments/price-client";

// The CoinGecko client (F-021) against a mocked `fetch`: `/simple/price`
// JSON, small prices in exponent notation, unknown ids, errors and the
// demo key header. Nothing reaches the network.

const NOW = Date.parse("2026-10-24T04:30:00Z");

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function client(
  respond: (url: URL) => Response,
  options: { apiKey?: string } = {},
) {
  const requests: { url: URL; headers: Record<string, string> }[] = [];
  let now = NOW;
  const sleeps: number[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, headers: init?.headers as Record<string, string> });
    return respond(url);
  }) as typeof globalThis.fetch;
  return {
    requests,
    sleeps,
    coingecko: createCoinGeckoClient({
      ...options,
      timeZone: "Europe/Helsinki",
      fetch,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    }),
  };
}

describe("numberToDecimal", () => {
  it.each([
    [61234.12, "61234.12"],
    [0.5, "0.5"],
    [1.2e-7, "0.00000012"],
    [3.4e-12, "0.0000000000034"],
    [1e21, "1000000000000000000000"],
    [0, "0"],
    [-2.5e-3, "-0.0025"],
  ])("writes %d as %s", (value, expected) => {
    expect(numberToDecimal(value)).toBe(expected);
  });

  it("drops digits below 10^-18", () => {
    expect(numberToDecimal(1.23e-17)).toBe("0.000000000000000012");
  });

  it("rejects NaN and infinities", () => {
    expect(() => numberToDecimal(Number.NaN)).toThrow(RangeError);
    expect(() => numberToDecimal(Infinity)).toThrow(RangeError);
  });
});

describe("createCoinGeckoClient", () => {
  it("fetches several coins in one request and dates them locally", async () => {
    const { coingecko, requests } = client(() =>
      json({
        bitcoin: { eur: 61234.12, last_updated_at: NOW / 1000 - 3600 },
        "shiba-inu": { eur: 1.2e-5, last_updated_at: NOW / 1000 },
        // Not asked for: ignored.
        dogecoin: { eur: 0.1 },
      }),
    );

    const prices = await coingecko.getPrices(
      ["shiba-inu", "bitcoin", "no-such-coin", "bitcoin"],
      "EUR",
    );

    expect(requests).toHaveLength(1);
    const { url, headers } = requests[0];
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.coingecko.com/api/v3/simple/price",
    );
    expect(url.searchParams.get("ids")).toBe("bitcoin,no-such-coin,shiba-inu");
    expect(url.searchParams.get("vs_currencies")).toBe("eur");
    expect(url.searchParams.get("include_last_updated_at")).toBe("true");
    expect(headers["x-cg-demo-api-key"]).toBeUndefined();
    expect(prices).toEqual(
      new Map([
        ["bitcoin", { date: "2026-10-24", price: "61234.12", currency: "EUR" }],
        [
          "shiba-inu",
          { date: "2026-10-24", price: "0.000012", currency: "EUR" },
        ],
      ]),
    );
  });

  it("sends the demo key when given", async () => {
    const { coingecko, requests } = client(() => json({}), { apiKey: "demo" });
    await coingecko.getPrices(["bitcoin"], "EUR");
    expect(requests[0].headers["x-cg-demo-api-key"]).toBe("demo");
  });

  it("splits long id lists and keeps to 5 requests a minute", async () => {
    const ids = Array.from({ length: 320 }, (_, i) => `coin-${i}`);
    const { coingecko, requests, sleeps } = client(() => json({}));
    await coingecko.getPrices(ids, "EUR");
    expect(requests).toHaveLength(7);
    expect(sleeps).toEqual([60_000]);
  });

  it.each([
    [429, "rate_limited"],
    [401, "auth"],
    [503, "unavailable"],
    [400, "invalid_response"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const { coingecko } = client(() => json({}, { status }));
    await expect(coingecko.getPrices(["bitcoin"], "EUR")).rejects.toMatchObject(
      {
        name: "PriceApiError",
        kind,
      },
    );
  });

  it("reports an unreachable API", async () => {
    const { coingecko } = client(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      coingecko.getPrices(["bitcoin"], "EUR"),
    ).rejects.toBeInstanceOf(PriceApiError);
  });

  it("rejects a negative price", async () => {
    const { coingecko } = client(() => json({ bitcoin: { eur: -1 } }));
    await expect(coingecko.getPrices(["bitcoin"], "EUR")).rejects.toMatchObject(
      {
        kind: "invalid_response",
      },
    );
  });
});
